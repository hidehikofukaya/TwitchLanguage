/**
 * POST   /auth/register       – create profile, grant 10 coins (idempotent)
 * DELETE /auth/account        – permanently delete the authenticated user
 */

// ──────────────────────────────────────────────
// POST /auth/register
// ──────────────────────────────────────────────
export async function handleRegister(request, env, userId, supabase) {
  // Check if already registered
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle()

  if (existing) {
    return jsonResponse({ ok: true, alreadyRegistered: true })
  }

  // Create profile
  const { error: profileError } = await supabase
    .from('profiles')
    .insert({ id: userId })

  if (profileError) {
    return jsonResponse({ ok: false, error: 'Failed to create profile' }, 500)
  }

  // Grant 10 coins via atomic RPC
  const { data: balance, error: coinError } = await supabase
    .rpc('add_coins', {
      p_user_id:      userId,
      p_amount:       10,
      p_reason:       'registration',
      p_stripe_event: null
    })

  if (coinError) {
    return jsonResponse({ ok: false, error: 'Failed to grant coins' }, 500)
  }

  return jsonResponse({ ok: true, alreadyRegistered: false, balance })
}

// ──────────────────────────────────────────────
// POST /auth/refresh  (no JWT auth required)
// ──────────────────────────────────────────────
export async function handleRefreshToken(request, env) {
  let body = {}
  try { body = await request.json() } catch {}

  const { refresh_token } = body
  if (!refresh_token) {
    return jsonResponse({ ok: false, error: 'Missing refresh_token' }, 400)
  }

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_ANON_KEY
    },
    body: JSON.stringify({ refresh_token })
  })

  const data = await res.json()
  if (!data.access_token) {
    return jsonResponse({ ok: false, error: 'Session expired. Please log in again.' }, 401)
  }

  return jsonResponse({
    ok:            true,
    jwt:           data.access_token,
    refresh_token: data.refresh_token ?? refresh_token,
    expires_in:    data.expires_in ?? 3600
  })
}

// ──────────────────────────────────────────────
// DELETE /auth/account
// ──────────────────────────────────────────────
export async function handleDeleteAccount(request, env, userId, supabase) {
  // Delete user from Supabase Auth (cascades to profiles/coins via FK or RLS)
  const { error } = await supabase.auth.admin.deleteUser(userId)

  if (error) {
    return jsonResponse({ ok: false, error: 'Failed to delete account' }, 500)
  }

  return jsonResponse({ ok: true })
}

// ──────────────────────────────────────────────
// Shared helper
// ──────────────────────────────────────────────
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
