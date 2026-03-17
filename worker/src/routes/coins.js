/**
 * GET  /coins/balance  → { balance: number }
 * POST /coins/consume  → { ok: boolean, balance: number }
 *
 * Coin consumption MUST succeed before the caller displays a phrase.
 * If consume returns ok:false the caller must NOT display and must NOT charge.
 */

export async function handleBalance(request, env, userId, supabase) {
  const { data, error } = await supabase
    .from('coin_balances')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    return jsonResponse({ ok: false, error: 'DB error' }, 500)
  }

  return jsonResponse({ ok: true, balance: data?.balance ?? 0 })
}

export async function handleDebugSetBalance(request, env, userId, supabase) {
  const DEBUG_BALANCE = 999
  const { error } = await supabase
    .from('coin_balances')
    .upsert({ user_id: userId, balance: DEBUG_BALANCE }, { onConflict: 'user_id' })

  if (error) return jsonResponse({ ok: false, error: 'DB error' }, 500)
  return jsonResponse({ ok: true, balance: DEBUG_BALANCE })
}

export async function handleConsume(request, env, userId, supabase) {
  const { data: newBalance, error } = await supabase
    .rpc('consume_coin', { p_user_id: userId })

  if (error) {
    return jsonResponse({ ok: false, error: 'DB error' }, 500)
  }

  if (newBalance === -1) {
    return jsonResponse({ ok: false, reason: 'insufficient_coins', balance: 0 })
  }

  return jsonResponse({ ok: true, balance: newBalance })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
