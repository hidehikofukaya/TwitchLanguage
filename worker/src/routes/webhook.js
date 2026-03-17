/**
 * POST /webhook/stripe
 * Handles checkout.session.completed to credit coins.
 *
 * Coin packs are Stripe Payment Links with metadata:
 *   user_id:    <supabase user uuid>
 *   coin_amount: "30" | "100" | "250"
 */
export async function handleStripeWebhook(request, env, supabase) {
  const sig = request.headers.get('stripe-signature')
  const body = await request.text()

  // Verify Stripe signature
  let event
  try {
    event = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return new Response(`Webhook signature invalid: ${err.message}`, { status: 400 })
  }

  if (event.type !== 'checkout.session.completed') {
    return new Response('ignored', { status: 200 })
  }

  const session = event.data.object

  // client_reference_id is encoded as "userId|coinAmount"
  const clientRef = session.client_reference_id ?? ''
  const pipeIdx   = clientRef.lastIndexOf('|')
  const userId    = pipeIdx > 0 ? clientRef.slice(0, pipeIdx) : null
  const coinAmount = pipeIdx > 0 ? parseInt(clientRef.slice(pipeIdx + 1), 10) : 0

  if (!userId || !coinAmount || coinAmount <= 0) {
    console.error('webhook: missing client_reference_id', { clientRef })
    return new Response('missing client_reference_id', { status: 400 })
  }

  const { error } = await supabase.rpc('add_coins', {
    p_user_id:      userId,
    p_amount:       coinAmount,
    p_reason:       'purchase',
    p_stripe_event: event.id
  })

  if (error) {
    console.error('add_coins failed:', error)
    return new Response('DB error', { status: 500 })
  }

  return new Response('ok', { status: 200 })
}

// ──────────────────────────────────────────────
// Stripe signature verification (Web Crypto API)
// ──────────────────────────────────────────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) throw new Error('No signature')

  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('='))
  )
  const timestamp = parts['t']
  const signature = parts['v1']

  if (!timestamp || !signature) throw new Error('Malformed signature header')

  const signed = `${timestamp}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed))
  const computed = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  if (computed !== signature) throw new Error('Signature mismatch')

  // Reject events older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    throw new Error('Timestamp too old')
  }
}
