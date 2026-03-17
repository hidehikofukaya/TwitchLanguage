/**
 * POST /phrases/batch
 * Body: { comments: string[], nativeLang: string, metadata: {} }
 * Returns: { phrases: PhraseExplanation[] }
 *
 * Two-stage pipeline:
 *   Stage 1 — Extract phrase names from chat (language auto-detected by LLM)
 *   Stage 2 — Dict cache lookup → optional UD fetch → grounded explanation (Haiku × N, parallel)
 *
 * Dictionary cache rules (dict_terms + dict_entries in Supabase):
 *   - hit=true,  age < 90 days  → use cached entries, skip API
 *   - hit=true,  age ≥ 90 days  → mandatory re-fetch (data may be stale)
 *   - hit=false, age < 1 day    → skip API (too soon to retry)
 *   - hit=false, age ≥ 1 day    → re-fetch (might have new entries now)
 *   - no record                 → fetch and store
 */
export async function handlePhrasesBatch(request, env, userId, supabase) {
  const body = await request.json()
  const { comments, nativeLang = 'ja', metadata = {} } = body

  if (!Array.isArray(comments) || comments.length === 0) {
    return jsonResponse({ ok: false, error: 'comments required' }, 400)
  }

  // Normalise: accept both string[] (legacy) and {text,username,timestamp}[]
  const commentObjects = comments.slice(0, 100).map(c =>
    typeof c === 'string' ? { text: c, username: null, timestamp: null } : c
  )
  const commentTexts = commentObjects.map(c => c.text)

  // ── Stage 1: Extract candidate phrase names ──────────────────────────────
  // streamLang from DOM/comment detection; nativeLang so LLM knows what NOT to explain
  const phraseNames = await extractPhraseNames(
    commentTexts, nativeLang, env.ANTHROPIC_API_KEY, metadata.streamLang ?? null
  )
  if (!phraseNames || phraseNames.length === 0) {
    return jsonResponse({ ok: true, phrases: [] })
  }

  // Style examples: evenly-spaced sample of 7 comments representing chat register
  const step = Math.max(1, Math.floor(commentObjects.length / 7))
  const styleExamples = Array.from({ length: 7 }, (_, i) => commentObjects[i * step])
    .filter(Boolean)
    .map(c => c.text)

  // ── Stage 2: Dict lookup → optional UD fetch → explain (all in parallel) ─
  const results = await Promise.all(
    phraseNames.map(async phrase => {
      const src = findSourceComment(phrase, commentObjects)

      const relatedComments = commentObjects
        .filter(c => c !== src && c.text.toLowerCase().includes(phrase.toLowerCase()))
        .slice(0, 3)
        .map(c => c.text)

      // Dictionary cache layer
      const { shouldFetch, entries: cachedEntries, termId } =
        await resolveDictEntries(phrase, 'urban_dictionary', supabase)

      let udEntries = cachedEntries
      if (shouldFetch) {
        const fetched = await fetchUrbanDictionary(phrase)
        if (termId) await persistDictEntries(termId, 'urban_dictionary', fetched, supabase)
        udEntries = fetched  // null = no-hit
      }

      const explained = await explainWithContext(
        phrase, nativeLang, env.ANTHROPIC_API_KEY,
        { sourceComment: src?.text ?? null, relatedComments, styleExamples, metadata, udEntries }
      )
      if (!explained) return null
      return {
        ...explained,
        source_comment: src
          ? { text: src.text, username: src.username ?? null, timestamp: src.timestamp ?? null }
          : null
      }
    })
  )
  const phrases = results.filter(Boolean)

  if (phrases.length === 0) {
    return jsonResponse({ ok: true, phrases: [] })
  }

  // ── Upsert to phrase_cache ────────────────────────────────────────────────
  const rows = phrases.map(p => ({
    cache_key:   `${nativeLang}::${p.phrase.toLowerCase().trim()}`,
    phrase:      p.phrase,
    native_lang: nativeLang,
    target_lang: 'auto',
    translation: p.translation,
    nuance:      p.nuance,
    example:     p.example,
    expires_at:  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  }))

  await supabase
    .from('phrase_cache')
    .upsert(rows, { onConflict: 'cache_key', ignoreDuplicates: false })

  return jsonResponse({ ok: true, phrases })
}

// ══════════════════════════════════════════════════════════════════
// Dictionary cache — Supabase backed
// ══════════════════════════════════════════════════════════════════
const DICT_NO_HIT_TTL_MS  = 1  * 24 * 60 * 60 * 1000   // 1 day
const DICT_HIT_REFRESH_MS = 90 * 24 * 60 * 60 * 1000   // 3 months

/**
 * Look up current dict state for a (term, source) pair.
 * Returns { shouldFetch, entries, termId }
 *   - shouldFetch: true  → caller must call the external API
 *   - entries:     array of dict_entries rows (only when shouldFetch=false and hit=true)
 *   - termId:      uuid for subsequent persistDictEntries call
 */
async function resolveDictEntries(term, source, supabase) {
  const normTerm = term.toLowerCase().trim()

  // Ensure term exists (upsert is idempotent)
  const { data: termRow, error: termErr } = await supabase
    .from('dict_terms')
    .upsert({ term: normTerm, lang: 'en' }, { onConflict: 'term,lang' })
    .select('id')
    .single()

  if (termErr || !termRow) return { shouldFetch: true, entries: null, termId: null }

  const termId = termRow.id

  // Fetch current entries for this source
  const { data: rows } = await supabase
    .from('dict_entries')
    .select('*')
    .eq('term_id', termId)
    .eq('source', source)
    .eq('is_current', true)
    .order('score', { ascending: false })

  if (!rows || rows.length === 0) {
    // Never searched before
    return { shouldFetch: true, entries: null, termId }
  }

  const age = Date.now() - new Date(rows[0].searched_at).getTime()

  if (!rows[0].hit) {
    // Recorded no-hit: only retry after 1 day
    return { shouldFetch: age >= DICT_NO_HIT_TTL_MS, entries: null, termId }
  }

  // Has data: mandatory re-fetch after 3 months
  return { shouldFetch: age >= DICT_HIT_REFRESH_MS, entries: rows, termId }
}

/**
 * Persist fetch results (or a no-hit) into dict_entries.
 * Marks old is_current rows as superseded; keeps them as version history.
 */
async function persistDictEntries(termId, source, fetchedEntries, supabase) {
  // Determine next version number
  const { data: cur } = await supabase
    .from('dict_entries')
    .select('version')
    .eq('term_id', termId)
    .eq('source', source)
    .eq('is_current', true)
    .order('version', { ascending: false })
    .limit(1)

  const nextVersion = (cur?.[0]?.version ?? 0) + 1

  // Supersede old current entries
  await supabase
    .from('dict_entries')
    .update({ is_current: false })
    .eq('term_id', termId)
    .eq('source', source)
    .eq('is_current', true)

  if (!fetchedEntries || fetchedEntries.length === 0) {
    // Explicit no-hit record
    await supabase.from('dict_entries').insert({
      term_id: termId, source, hit: false, version: nextVersion
    })
  } else {
    await supabase.from('dict_entries').insert(
      fetchedEntries.map(e => ({
        term_id:    termId,
        source,
        source_ref: e.source_ref ?? null,
        hit:        true,
        version:    nextVersion,
        definition: e.definition,
        example:    e.example ?? null,
        tags:       e.tags ?? null,
        score:      e.score ?? null,
        score_down: e.score_down ?? null
      }))
    )
  }
}

// ══════════════════════════════════════════════════════════════════
// Stage 1 — Phrase name extractor (returns string[])
// ══════════════════════════════════════════════════════════════════
async function extractPhraseNames(commentTexts, nativeLang, apiKey, streamLang = null) {
  const nativeName   = LANG_NAMES[nativeLang]   ?? nativeLang
  const streamName   = LANG_NAMES[streamLang]   ?? streamLang
  const langDirective = streamLang
    ? `The stream language is ${streamName} (${streamLang}). Extract ONLY ${streamName} phrases from the comments.`
    : `Detect the dominant language of the comments and extract phrases from that language only.`

  const prompt = `You are extracting phrases from Twitch chat for a language learner whose native language is ${nativeName}.
${langDirective}

Output ONLY a JSON array of strings — no markdown, no explanation.
If no suitable phrases are found in the comments, output an empty array: []

Extraction rules:
- CRITICAL: Only extract phrases that ACTUALLY APPEAR verbatim (or near-verbatim) in the comments below. Do NOT invent or hallucinate phrases.
- Single words or short multi-word expressions only (NOT full sentences)
- Skip words 3 characters or shorter unless they are culturally significant Twitch/gaming slang
- Skip pure numbers, URLs, and @mentions
- Prefer slang, internet expressions, gaming terms, and memes that would be educational for an immersion learner

Twitch chat comments:
${commentTexts.join('\n')}`

  const text = await callClaude(prompt, 256, apiKey)

  const tryParse = raw => {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter(s => typeof s === 'string' && s.length > 0)
    } catch {}
    return null
  }

  return tryParse(text) ?? tryParse(text.match(/\[[\s\S]*?\]/)?.[0] ?? '') ?? []
}

// ══════════════════════════════════════════════════════════════════
// Source comment reverse-lookup (Worker code — no LLM)
// ══════════════════════════════════════════════════════════════════
function findSourceComment(phrase, commentObjects) {
  const phraseLower = phrase.toLowerCase()

  const exact = commentObjects.find(c => c.text.toLowerCase().includes(phraseLower))
  if (exact) return exact

  const phraseWords = phraseLower.split(/\W+/).filter(w => w.length > 1)
  if (phraseWords.length === 0) return null

  let best = null, bestScore = 0
  for (const c of commentObjects) {
    const textLower = c.text.toLowerCase()
    const score = phraseWords.filter(w => textLower.includes(w)).length
    if (score > bestScore) { bestScore = score; best = c }
  }
  return best
}

// ══════════════════════════════════════════════════════════════════
// Urban Dictionary API fetch — returns top 3 entries or null
// ══════════════════════════════════════════════════════════════════
async function fetchUrbanDictionary(term) {
  try {
    const url = `https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(term)}`
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'TwitchLaunguage-LanguageLearning/1.0' },
      signal:  AbortSignal.timeout(4000)
    })
    if (!res.ok) return null

    const data = await res.json()
    if (!Array.isArray(data.list) || data.list.length === 0) return null

    return data.list
      .sort((a, b) => b.thumbs_up - a.thumbs_up)
      .slice(0, 3)
      .map(d => ({
        source_ref: String(d.defid),
        definition: d.definition.replace(/\[|\]/g, '').trim(),
        example:    d.example.replace(/\[|\]/g, '').trim() || null,
        score:      d.thumbs_up,
        score_down: d.thumbs_down,
        tags:       null
      }))
  } catch {
    return null
  }
}

// ══════════════════════════════════════════════════════════════════
// Stage 2 — Grounded explainer
// ══════════════════════════════════════════════════════════════════
async function explainWithContext(phrase, nativeLang, apiKey, context = {}) {
  const {
    sourceComment   = null,
    relatedComments = [],
    styleExamples   = [],
    metadata        = {},
    udEntries       = null   // dict_entries rows or null
  } = context

  const langName = LANG_NAMES[nativeLang] ?? nativeLang

  // Build UD context block from cached/fetched entries
  let udBlock
  if (udEntries && udEntries.length > 0) {
    const lines = udEntries.map((e, i) =>
      `[${i + 1}] ${e.definition}${e.example ? `\n    Example: ${e.example}` : ''} (👍${e.score ?? '?'})`
    ).join('\n')
    udBlock = `[Urban Dictionary — ${udEntries.length} definition(s)]\n${lines}`
  } else {
    udBlock = `[Urban Dictionary — no entry found]\nThis term may be very new slang, a niche Twitch/gaming meme, or a specific streamer's expression.`
  }

  const pronunciationGuide = {
    ja: 'カタカナ読み (例: copium → コーピアム)',
    zh: 'ピンイン',
    ko: 'ハングル読み',
  }[nativeLang] ?? 'IPA phonetic notation (e.g. copium → /ˈkoʊpiəm/)'

  const streamLines = []
  if (metadata.gameTitle)   streamLines.push(`- Game/Category: ${metadata.gameTitle}`)
  if (metadata.streamTitle) streamLines.push(`- Stream Title: ${metadata.streamTitle}`)
  const streamBlock = streamLines.length > 0
    ? `STREAM CONTEXT:\n${streamLines.join('\n')}\n\n`
    : ''

  const usageLines = []
  if (sourceComment) usageLines.push(`"${sourceComment}"  ← this is the comment this phrase was extracted from`)
  relatedComments.forEach(c => usageLines.push(`"${c}"`))
  const usageBlock = usageLines.length > 0
    ? `ACTUAL USAGE IN THIS STREAM (use this as primary evidence for tone and context):\n${usageLines.join('\n')}\n\n`
    : ''

  const styleBlock = styleExamples.length > 0
    ? `CHAT STYLE EXAMPLES (match the register and tone of these when writing the example field):\n${styleExamples.map(s => `"${s}"`).join('\n')}\n\n`
    : ''

  const prompt = `You are a language learning assistant for Twitch viewers.
The learner's native language is ${langName}. They learn languages through Twitch chat immersion.

${streamBlock}PHRASE TO EXPLAIN: "${phrase}"

REFERENCE — community definition (factual baseline):
${udBlock}

${usageBlock}${styleBlock}Task: Explain the phrase to the learner in ${langName}.

Output ONLY a single valid JSON object, no markdown fences:
{"phrase":"${phrase}","pronunciation":"...","uncertain":false,"translation":"...","nuance":"...","example":"...","example_translation":"..."}

Field rules:
- pronunciation      : phonetic reading of the phrase using ${pronunciationGuide}
- uncertain          : true ONLY if UD has no entry AND usage context does not clearly reveal the meaning; false otherwise
- translation        : concise ${langName} meaning (1–2 sentences); prioritise ACTUAL USAGE over UD when they differ
- nuance             : how/when this phrase is used, tone, cultural context (write in ${langName})
- example            : one short Twitch chat message using the phrase, written ENTIRELY in the same language as the phrase — absolutely no ${langName} words, IN THE STYLE OF THE CHAT STYLE EXAMPLES
- example_translation: ${langName} translation of the example sentence only — no commentary

IMPORTANT: Never write disclaimers or apologies inside any field. Use the uncertain flag instead.`

  const text = await callClaude(prompt, 700, apiKey)

  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj.phrase === 'string' && typeof obj.translation === 'string') return obj
  } catch {}

  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const obj = JSON.parse(match[0])
      if (obj && typeof obj.phrase === 'string') return obj
    } catch {}
  }
  return null
}

// ══════════════════════════════════════════════════════════════════
// Shared Claude caller
// ══════════════════════════════════════════════════════════════════
async function callClaude(prompt, maxTokens, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }]
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.content?.[0]?.text ?? ''
}

// ══════════════════════════════════════════════════════════════════
// Constants / helpers
// ══════════════════════════════════════════════════════════════════
const LANG_NAMES = {
  ja: 'Japanese', en: 'English', zh: 'Chinese',
  ko: 'Korean',   es: 'Spanish', fr: 'French',
  de: 'German',   pt: 'Portuguese', ru: 'Russian'
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
