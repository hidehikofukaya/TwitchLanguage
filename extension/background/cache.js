/**
 * Local phrase cache manager.
 *
 * Storage layout in chrome.storage.local:
 *   phrase_cache: { [cacheKey]: PhraseEntry }
 *   phrase_queue: PhraseEntry[]         ← ready-to-display ordered queue
 *   selection_counts: { [cacheKey]: number }
 *   recent_keys: string[]               ← last 5 displayed keys (anti-repeat)
 *
 * Eviction: when total JSON size > MAX_BYTES, remove entries with the
 * highest selection_count (most-seen phrases are evicted first).
 */

const CACHE_KEY      = 'phrase_cache'
const QUEUE_KEY      = 'phrase_queue'
const COUNTS_KEY     = 'selection_counts'
const RECENT_KEY     = 'recent_keys'
const MAX_BYTES      = 10 * 1024 * 1024   // 10 MB
const RECENT_WINDOW  = 5                   // min gap between same phrase

export async function getCachedPhrase(key) {
  const { phrase_cache = {} } = await chrome.storage.local.get(CACHE_KEY)
  return phrase_cache[key] ?? null
}

/** Bulk-insert freshly generated phrases into cache and display queue. */
export async function storePhrases(phrases) {
  const stored = await chrome.storage.local.get([CACHE_KEY, QUEUE_KEY, COUNTS_KEY])
  const cache   = stored[CACHE_KEY]   ?? {}
  const queue   = stored[QUEUE_KEY]   ?? []
  const counts  = stored[COUNTS_KEY]  ?? {}

  for (const p of phrases) {
    const key = buildKey(p)
    cache[key] = { ...p, cached_at: Date.now() }
    if (!queue.some(q => buildKey(q) === key)) {
      queue.push(p)
    }
  }

  await evictIfNeeded(cache, counts)
  await chrome.storage.local.set({ [CACHE_KEY]: cache, [QUEUE_KEY]: queue })
}

/** Dequeue the next best phrase from the display queue. */
export async function dequeueNextPhrase() {
  const stored = await chrome.storage.local.get([QUEUE_KEY, COUNTS_KEY, RECENT_KEY])
  const queue   = stored[QUEUE_KEY]  ?? []
  const counts  = stored[COUNTS_KEY] ?? {}
  const recent  = stored[RECENT_KEY] ?? []

  if (queue.length === 0) return null

  // Filter out recently shown phrases (anti-repeat window)
  const eligible = queue.filter(p => !recent.includes(buildKey(p)))
  const pool = eligible.length > 0 ? eligible : queue   // fallback if all are recent

  // Simple random selection for Phase 1 (weighted selection in Phase 2)
  const idx = Math.floor(Math.random() * pool.length)
  const chosen = pool[idx]
  const chosenKey = buildKey(chosen)

  // Remove from queue
  const newQueue = queue.filter(q => buildKey(q) !== chosenKey)

  // Update recent window
  const newRecent = [chosenKey, ...recent].slice(0, RECENT_WINDOW)

  await chrome.storage.local.set({
    [QUEUE_KEY]:  newQueue,
    [RECENT_KEY]: newRecent
  })

  return chosen
}

/** Record that a phrase was displayed to the user. */
export async function recordSelection(key) {
  const { [COUNTS_KEY]: counts = {} } = await chrome.storage.local.get(COUNTS_KEY)
  counts[key] = (counts[key] ?? 0) + 1
  await chrome.storage.local.set({ [COUNTS_KEY]: counts })
}

/** Returns how many phrases are currently in the display queue. */
export async function getQueueLength() {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY)
  return queue.length
}

/** Clear the entire cache (e.g., on language settings change). */
export async function clearCache() {
  await chrome.storage.local.remove([CACHE_KEY, QUEUE_KEY, COUNTS_KEY, RECENT_KEY])
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
export function buildKey(phrase, nativeLang, targetLang) {
  // Accept either a full phrase object or separate args
  if (typeof phrase === 'object') {
    return `${phrase.native_lang ?? 'ja'}-${phrase.target_lang ?? 'en'}::${phrase.phrase.toLowerCase().trim()}`
  }
  return `${nativeLang}-${targetLang}::${phrase.toLowerCase().trim()}`
}

async function evictIfNeeded(cache, counts) {
  const json = JSON.stringify(cache)
  if (json.length <= MAX_BYTES) return

  // Sort by selection_count DESC (most-seen first = evict first)
  const entries = Object.entries(cache).sort((a, b) => {
    const ca = counts[a[0]] ?? 0
    const cb = counts[b[0]] ?? 0
    return cb - ca
  })

  // Remove entries until we're back under limit
  while (JSON.stringify(cache).length > MAX_BYTES * 0.8 && entries.length > 0) {
    const [evictKey] = entries.shift()
    delete cache[evictKey]
  }
}
