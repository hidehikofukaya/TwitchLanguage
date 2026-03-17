/**
 * POST /phrases/batch
 * Body: { comments: string[], nativeLang: string, targetLang: string }
 * Returns: { phrases: PhraseExplanation[] }
 *
 * Two-stage pipeline:
 *   Agent 1 — Extract phrase names from chat comments (Haiku, lightweight)
 *   Agent 2 — Fetch Urban Dictionary context + generate grounded explanation (Haiku × N, parallel)
 */
export async function handlePhrasesBatch(request, env, userId, supabase) {
  const body = await request.json()
  const { comments, nativeLang = 'ja', targetLang = 'en', metadata = {} } = body

  if (!Array.isArray(comments) || comments.length === 0) {
    return jsonResponse({ ok: false, error: 'comments required' }, 400)
  }

  // Normalise: accept both string[] (legacy) and {text,username,timestamp}[]
  const commentObjects = comments.slice(0, 100).map(c =>
    typeof c === 'string' ? { text: c, username: null, timestamp: null } : c
  )
  const commentTexts = commentObjects.map(c => c.text)

  // ── Stage 1: Extract candidate phrase names (strings only) ──────────────
  const phraseNames = await extractPhraseNames(commentTexts, targetLang, env.ANTHROPIC_API_KEY)
  if (!phraseNames || phraseNames.length === 0) {
    return jsonResponse({ ok: true, phrases: [] })
  }

  // Style examples: evenly-spaced sample of 7 comments representing the chat register
  const step = Math.max(1, Math.floor(commentObjects.length / 7))
  const styleExamples = Array.from({ length: 7 }, (_, i) => commentObjects[i * step])
    .filter(Boolean)
    .map(c => c.text)

  // ── Stage 2: Fetch UD context + explain (all phrases in parallel) ────────
  const results = await Promise.all(
    phraseNames.map(async phrase => {
      // Reverse-lookup source comment entirely in Worker code (no LLM index used)
      const src = findSourceComment(phrase, commentObjects)

      // Up to 3 other comments in the batch that also contain the phrase
      const relatedComments = commentObjects
        .filter(c => c !== src && c.text.toLowerCase().includes(phrase.toLowerCase()))
        .slice(0, 3)
        .map(c => c.text)

      const explained = await explainWithContext(
        phrase, nativeLang, targetLang, env.ANTHROPIC_API_KEY,
        { sourceComment: src?.text ?? null, relatedComments, styleExamples, metadata }
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

  // ── Upsert to server-side phrase_cache (core fields only) ────────────────
  const rows = phrases.map(p => ({
    cache_key:   `${nativeLang}-${targetLang}::${p.phrase.toLowerCase().trim()}`,
    phrase:      p.phrase,
    native_lang: nativeLang,
    target_lang: targetLang,
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
// Agent 1 — Phrase name extractor  (returns string[])
// ══════════════════════════════════════════════════════════════════
async function extractPhraseNames(commentTexts, targetLang, apiKey) {
  const targetName = LANG_NAMES[targetLang] ?? targetLang

  const prompt = `From the Twitch chat comments below, extract up to 5 ${targetName} slang terms, idioms, or notable phrases worth learning.
Output ONLY a JSON array of strings — no markdown, no explanation.

Extraction rules:
- Single words or short multi-word expressions only (NOT full sentences)
- Skip words 3 characters or shorter (ok, no, gg, wp, lol) unless culturally significant Twitch slang
- Skip pure numbers, URLs, and @mentions
- Prefer internet slang, gaming terms, memes, and expressions a ${targetName} learner would find unfamiliar

Example output: ["copium","no cap","he's cooked","brain rot"]

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
/**
 * Find the best matching comment for a phrase entirely in Worker code.
 * 1. Exact substring match (case-insensitive) → first match wins.
 * 2. Word-overlap similarity for hallucinated/variant phrases.
 */
function findSourceComment(phrase, commentObjects) {
  const phraseLower = phrase.toLowerCase()

  // 1. Exact substring match
  const exact = commentObjects.find(c => c.text.toLowerCase().includes(phraseLower))
  if (exact) return exact

  // 2. Word-overlap fallback (handles LLM slightly changing the phrase)
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
// RAG — Urban Dictionary lookup
// ══════════════════════════════════════════════════════════════════
async function fetchUrbanDictionary(term) {
  try {
    const url = `https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(term)}`
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'TwitchLaunguage-LanguageLearning/1.0' },
      // Cloudflare Worker fetch has no built-in timeout; use AbortController
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) return null

    const data = await res.json()
    if (!Array.isArray(data.list) || data.list.length === 0) return null

    // Pick the most upvoted definition
    const best = [...data.list].sort((a, b) => b.thumbs_up - a.thumbs_up)[0]

    return {
      definition: best.definition.replace(/\[|\]/g, '').trim(),
      example:    best.example.replace(/\[|\]/g, '').trim(),
      thumbs_up:  best.thumbs_up,
      thumbs_down: best.thumbs_down
    }
  } catch {
    return null   // timeout or network error — proceed without context
  }
}

// ══════════════════════════════════════════════════════════════════
// Agent 2 — Grounded explainer
// ══════════════════════════════════════════════════════════════════
async function explainWithContext(phrase, nativeLang, targetLang, apiKey, context = {}) {
  const { sourceComment = null, relatedComments = [], styleExamples = [], metadata = {} } = context

  // Fetch UD context while keeping the function async-parallel-friendly
  const ud = await fetchUrbanDictionary(phrase)

  const langName   = LANG_NAMES[nativeLang]  ?? nativeLang
  const targetName = LANG_NAMES[targetLang]  ?? targetLang

  const udBlock = ud
    ? `[Urban Dictionary — community definition, ${ud.thumbs_up} upvotes / ${ud.thumbs_down} downvotes]
Definition : ${ud.definition}
Example    : ${ud.example || '(none provided)'}`
    : `[Urban Dictionary — no entry found]
This term may be very new slang, a niche Twitch/gaming meme, or a specific streamer's expression.`

  const pronunciationGuide = {
    ja: 'カタカナ読み (例: copium → コーピアム)',
    zh: 'ピンイン (例: copium → kōpíyǎm)',
    ko: 'ハングル読み (例: copium → 코피엄)',
  }[nativeLang] ?? 'IPA phonetic notation (e.g. copium → /ˈkoʊpiəm/)'

  // ── Optional context blocks ──────────────────────────────────────
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
    ? `CHAT STYLE EXAMPLES (match the register and tone of these when writing the example field — keep it short and natural):\n${styleExamples.map(s => `"${s}"`).join('\n')}\n\n`
    : ''

  const prompt = `You are a language learning assistant for Twitch viewers.
The learner's native language is ${langName}. They are learning ${targetName} through Twitch chat.

${streamBlock}PHRASE TO EXPLAIN: "${phrase}"

REFERENCE — community definition (factual baseline):
${udBlock}

${usageBlock}${styleBlock}Task: Explain the phrase to the learner in ${langName}.

Output ONLY a single valid JSON object, no markdown fences:
{"phrase":"${phrase}","pronunciation":"...","uncertain":false,"translation":"...","nuance":"...","example":"...","example_translation":"..."}

Field rules:
- pronunciation      : phonetic reading using ${pronunciationGuide}
- uncertain          : true ONLY if UD has no entry AND usage context does not clearly reveal the meaning; false otherwise
- translation        : concise ${langName} meaning (1–2 sentences); prioritise ACTUAL USAGE over UD when they differ; write your best inference even if uncertain
- nuance             : how/when Twitch viewers use it, tone, cultural context (in ${langName}); write your best inference even if uncertain
- example            : one short Twitch chat message using the phrase, written ENTIRELY in ${targetName}, IN THE STYLE OF THE CHAT STYLE EXAMPLES — absolutely no ${langName} words
- example_translation: ${langName} translation of the example sentence only — no commentary, no extra content

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
