/**
 * API client for the Cloudflare Worker backend.
 * All calls include a valid Supabase JWT, auto-refreshing if expired.
 */

const WORKER_URL = 'https://twitchlaunguage-api.hide2dev.workers.dev'

/**
 * Returns a valid JWT, refreshing it silently if it has expired (or will
 * expire within 60 seconds). Falls back to the stored token if refresh fails.
 */
async function getValidJwt() {
  const { jwt, refreshToken, tokenExpiresAt } = await chrome.storage.local.get([
    'jwt', 'refreshToken', 'tokenExpiresAt'
  ])

  // Token still valid with 60s safety buffer
  if (jwt && tokenExpiresAt && Date.now() < tokenExpiresAt - 60_000) return jwt

  // Attempt silent refresh via Worker proxy (keeps anon key server-side)
  if (refreshToken) {
    try {
      const res = await fetch(`${WORKER_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      })
      const result = await res.json()
      if (result.ok && result.jwt) {
        await chrome.storage.local.set({
          jwt:             result.jwt,
          refreshToken:    result.refresh_token ?? refreshToken,
          tokenExpiresAt:  Date.now() + (result.expires_in ?? 3600) * 1000
        })
        return result.jwt
      }
    } catch (e) {
      console.error('[TL] Token refresh failed:', e)
    }
  }

  return jwt ?? null   // Return whatever we have; Worker will 401 if truly invalid
}

async function apiFetch(path, options = {}) {
  const jwt = await getValidJwt()
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...(options.headers ?? {})
    }
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    console.error(`[TL] Non-JSON response from ${path} (HTTP ${res.status}):`, text.slice(0, 120))
    return { ok: false, error: `Server error (HTTP ${res.status}). Worker may not be deployed.` }
  }
}

/** Register user and receive 10 coins. */
export async function register() {
  return apiFetch('/auth/register', { method: 'POST' })
}

/** Get current coin balance from server. */
export async function fetchBalance() {
  return apiFetch('/coins/balance')
}

/**
 * Atomically consume 1 coin.
 * Returns { ok: true, balance } or { ok: false, reason: 'insufficient_coins' }
 */
export async function consumeCoin() {
  return apiFetch('/coins/consume', { method: 'POST' })
}

/** Permanently delete the authenticated user's account. */
export async function deleteAccount() {
  return apiFetch('/auth/account', { method: 'DELETE' })
}

/**
 * Send a batch of Twitch comments to generate phrase explanations.
 * Returns { ok: true, phrases: PhraseExplanation[] }
 */
export async function fetchPhrases(comments, nativeLang, metadata = {}) {
  return apiFetch('/phrases/batch', {
    method: 'POST',
    body: JSON.stringify({ comments, nativeLang, metadata })
  })
}
