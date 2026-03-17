/**
 * TwitchLaunguage - Cloudflare Worker
 * API gateway that hides the OpenAI API key and manages coin state.
 *
 * Routes:
 *   POST /auth/register
 *   GET  /coins/balance
 *   POST /coins/consume
 *   POST /phrases/batch
 *   POST /webhook/stripe
 */

import { createClient } from '@supabase/supabase-js'
import { handleRegister, handleDeleteAccount, handleRefreshToken } from './routes/auth.js'
import { handlePhrasesBatch } from './routes/phrases.js'
import { handleBalance, handleConsume, handleDebugSetBalance } from './routes/coins.js'
import { handleStripeWebhook } from './routes/webhook.js'

// ──────────────────────────────────────────────
// CORS headers for Chrome Extension origin
// ──────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    try {
      return await routeRequest(request, env)
    } catch (err) {
      console.error('[Worker] Unhandled error:', err?.message ?? err)
      return new Response(
        JSON.stringify({ ok: false, error: err?.message ?? 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }
  }
}

async function routeRequest(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    // Token refresh – no JWT auth needed
    if (path === '/auth/refresh' && request.method === 'POST') {
      const res = await handleRefreshToken(request, env)
      return addCors(res)
    }

    // Stripe webhook doesn't need JWT auth
    if (path === '/webhook/stripe' && request.method === 'POST') {
      const supabase = createSupabaseAdmin(env)
      const res = await handleStripeWebhook(request, env, supabase)
      return addCors(res)
    }

    // All other routes require a valid Supabase JWT
    const userId = await authenticate(request, env)
    if (!userId) {
      return addCors(new Response(
        JSON.stringify({ ok: false, error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      ))
    }

    const supabase = createSupabaseAdmin(env)
    let response

    if (path === '/auth/register' && request.method === 'POST') {
      response = await handleRegister(request, env, userId, supabase)

    } else if (path === '/auth/account' && request.method === 'DELETE') {
      response = await handleDeleteAccount(request, env, userId, supabase)

    } else if (path === '/coins/balance' && request.method === 'GET') {
      response = await handleBalance(request, env, userId, supabase)

    } else if (path === '/coins/consume' && request.method === 'POST') {
      response = await handleConsume(request, env, userId, supabase)

    } else if (path === '/phrases/batch' && request.method === 'POST') {
      response = await handlePhrasesBatch(request, env, userId, supabase)

    } else if (path === '/debug/set-balance' && request.method === 'POST') {
      response = await handleDebugSetBalance(request, env, userId, supabase)

    } else {
      response = new Response(
        JSON.stringify({ ok: false, error: 'Not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    return addCors(response)
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function createSupabaseAdmin(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Verify the Supabase-issued JWT via supabase.auth.getUser().
 * Works with both legacy HMAC and new ECC P-256 signed tokens.
 * Returns the user's UUID or null if invalid/expired.
 *
 * Retries up to 3 times with 500ms / 1000ms backoff to handle
 * Supabase session propagation delay right after OAuth sign-in.
 */
async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null

  const DELAYS = [0, 500, 1000]
  for (let i = 0; i < DELAYS.length; i++) {
    if (DELAYS[i] > 0) await new Promise(r => setTimeout(r, DELAYS[i]))
    try {
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)
      const { data, error } = await supabase.auth.getUser(token)
      if (data?.user) return data.user.id
      if (error?.status === 401) return null
    } catch {}
  }
  return null
}

function addCors(response) {
  const next = new Response(response.body, response)
  Object.entries(CORS_HEADERS).forEach(([k, v]) => next.headers.set(k, v))
  return next
}
