/**
 * Popup script.
 * Handles auth state, coin display, purchase links, and settings.
 */

const PAYMENT_LINKS = {
  30:   'https://buy.stripe.com/test_4gM8wP1f89979iZfRLabK00',
  100:  'https://buy.stripe.com/test_cNifZh5vofxv7aRgVPabK01',
  1000: 'https://buy.stripe.com/test_8x2cN5bTM5WV0Mt5d7abK02'
}

const SUPABASE_URL = 'https://opbilttrjwowvqpbvctv.supabase.co'

// ──────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────
async function init() {
  const { jwt, settings = {} } = await chrome.storage.local.get(['jwt', 'settings'])

  show('section-loading', false)

  if (!jwt) {
    show('section-auth')
    document.getElementById('btn-register').addEventListener('click', onRegister)
    return
  }

  // Decode display name from JWT
  const userName = decodeUserName(jwt)
  document.getElementById('account-name').textContent = userName
  show('account-menu-wrap')

  setupAccountMenu(jwt)
  show('section-main')
  applySettings(settings)
  updateBadge(settings.enabled !== false)

  // REGISTER first (idempotent). Must complete before refreshBalance so that
  // first-login coin grant exists in DB before we read it.
  await chrome.runtime.sendMessage({ type: 'REGISTER' }).catch(() => {})

  await refreshBalance()
  setupBuyButtons(jwt)
  setupSaveButton()
  setupInstantToggle(settings)
  setupShowOverlayButton()
}

// ──────────────────────────────────────────────
// Account menu
// ──────────────────────────────────────────────
function setupAccountMenu() {
  const btn      = document.getElementById('btn-account')
  const dropdown = document.getElementById('account-dropdown')

  btn.addEventListener('click', e => {
    e.stopPropagation()
    dropdown.classList.toggle('hidden')
  })

  // Close on outside click
  document.addEventListener('click', () => dropdown.classList.add('hidden'))

  document.getElementById('btn-logout').addEventListener('click', onLogout)
  document.getElementById('btn-delete-account').addEventListener('click', onDeleteAccount)
}

async function onLogout() {
  await chrome.storage.local.remove(['jwt', 'refreshToken', 'tokenExpiresAt', 'registered'])
  await chrome.runtime.sendMessage({ type: 'SAVE_JWT', jwt: null })
  location.reload()
}

async function onDeleteAccount() {
  const confirmed = confirm(
    '本当にアカウントを削除しますか？\n\n' +
    'コイン残量・設定・履歴がすべて削除され、この操作は取り消せません。'
  )
  if (!confirmed) return

  const btn = document.getElementById('btn-delete-account')
  btn.disabled = true
  btn.textContent = '削除中...'

  try {
    const res = await chrome.runtime.sendMessage({ type: 'DELETE_ACCOUNT' })
    if (!res?.ok) throw new Error(res?.error ?? '削除に失敗しました')
    location.reload()
  } catch (err) {
    btn.disabled = false
    btn.textContent = 'アカウントを削除'
    alert(`アカウントの削除に失敗しました: ${err.message}`)
  }
}

// ──────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────
async function onRegister() {
  const btn = document.getElementById('btn-register')
  btn.disabled = true
  btn.textContent = '認証中...'

  try {
    // Run OAuth entirely in the service worker so it survives popup focus loss
    const res = await chrome.runtime.sendMessage({ type: 'INITIATE_OAUTH' })
    if (!res?.ok) throw new Error(res?.error ?? 'OAuth に失敗しました')

    // REGISTER is best-effort; init() will retry on next open if it fails
    await chrome.runtime.sendMessage({ type: 'REGISTER' }).catch(() => {})

    location.reload()

  } catch (err) {
    btn.disabled = false
    btn.textContent = 'Googleで登録'
    alert(`登録に失敗しました: ${err.message}`)
  }
}

// ──────────────────────────────────────────────
// Coin balance
// ──────────────────────────────────────────────
async function refreshBalance() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_BALANCE' })
  const balance = res?.balance ?? 0
  document.getElementById('coin-balance').textContent = balance
}

// ──────────────────────────────────────────────
// Purchase buttons
// ──────────────────────────────────────────────
function setupBuyButtons(jwt) {
  let userId = ''
  try {
    const [, payload] = jwt.split('.')
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    userId = decoded.sub ?? ''
  } catch {}

  ;[30, 100, 1000].forEach(coins => {
    const btn = document.getElementById(`buy-${coins}`)
    if (!btn) return
    const url = `${PAYMENT_LINKS[coins]}?client_reference_id=${encodeURIComponent(userId)}`
    btn.addEventListener('click', e => {
      e.preventDefault()
      chrome.tabs.create({ url })
    })
  })
}

// ──────────────────────────────────────────────
// Settings
// ──────────────────────────────────────────────
function applySettings(settings) {
  if (settings.nativeLang)  document.getElementById('sel-native').value   = settings.nativeLang
  if (settings.intervalSec) document.getElementById('sel-interval').value = String(settings.intervalSec)
  document.getElementById('toggle-enabled').checked = settings.enabled !== false
}

/** Instant ON/OFF toggle – no save button needed */
function setupInstantToggle(settings) {
  const toggle = document.getElementById('toggle-enabled')
  toggle.addEventListener('change', async () => {
    const { settings: current = {} } = await chrome.storage.local.get('settings')
    const next = { ...current, enabled: toggle.checked }
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: next })
    updateBadge(toggle.checked)
  })
}

function setupShowOverlayButton() {
  document.getElementById('btn-show-overlay').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'SHOW_OVERLAY' })
    window.close()
  })
}

function setupSaveButton() {
  document.getElementById('btn-save').addEventListener('click', async () => {
    const settings = {
      nativeLang:  document.getElementById('sel-native').value,
      intervalSec: parseInt(document.getElementById('sel-interval').value, 10),
      enabled:     document.getElementById('toggle-enabled').checked
    }
    const res = await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings })
    if (res?.ok) {
      const btn = document.getElementById('btn-save')
      btn.textContent = '保存しました ✓'
      updateBadge(settings.enabled)
      setTimeout(() => { btn.textContent = '設定を保存' }, 1500)
    }
  })
}

// ──────────────────────────────────────────────
// Debug panel
// ──────────────────────────────────────────────
const WORKER_URL = 'https://twitchlaunguage-api.hide2dev.workers.dev'

function dbgLog(label, data) {
  const out = document.getElementById('debug-output')
  if (!out) return
  const ts = new Date().toISOString().slice(11, 23)
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  out.textContent += `[${ts}] ${label}\n${body}\n\n`
  out.scrollTop = out.scrollHeight
}

async function setupDebugPanel() {
  document.getElementById('btn-debug-toggle').addEventListener('click', () => {
    const sec = document.getElementById('section-debug')
    sec.classList.toggle('hidden')
    if (!sec.classList.contains('hidden')) runDbgStorage()
  })

  document.getElementById('dbg-copy').addEventListener('click', async () => {
    const text = document.getElementById('debug-output').textContent
    await navigator.clipboard.writeText(text)
    const btn = document.getElementById('dbg-copy')
    btn.textContent = 'COPIED!'
    setTimeout(() => { btn.textContent = 'COPY' }, 1500)
  })

  document.getElementById('dbg-clear').addEventListener('click', () => {
    document.getElementById('debug-output').textContent = ''
  })

  document.getElementById('dbg-storage').addEventListener('click', runDbgStorage)

  document.getElementById('dbg-balance').addEventListener('click', async () => {
    dbgLog('→ GET_BALANCE (via SW)', '')
    const res = await chrome.runtime.sendMessage({ type: 'GET_BALANCE' }).catch(e => ({ error: e.message }))
    dbgLog('← GET_BALANCE', res)
  })

  document.getElementById('dbg-register').addEventListener('click', async () => {
    dbgLog('→ REGISTER (via SW)', '')
    const res = await chrome.runtime.sendMessage({ type: 'REGISTER' }).catch(e => ({ error: e.message }))
    dbgLog('← REGISTER', res)
  })

  document.getElementById('dbg-refresh').addEventListener('click', async () => {
    const { refreshToken } = await chrome.storage.local.get('refreshToken')
    if (!refreshToken) { dbgLog('Refresh', 'refreshToken が storage にありません'); return }
    dbgLog('→ POST /auth/refresh', { refresh_token: refreshToken.slice(0, 10) + '…' })
    try {
      const res = await fetch(`${WORKER_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      })
      const data = await res.json()
      dbgLog(`← /auth/refresh (${res.status})`, {
        ...data,
        jwt: data.jwt ? data.jwt.slice(0, 30) + '…' : undefined
      })
    } catch (e) {
      dbgLog('← /auth/refresh ERROR', e.message)
    }
  })

  document.getElementById('dbg-delete').addEventListener('click', async () => {
    dbgLog('→ DELETE_ACCOUNT (via SW)', '')
    const res = await chrome.runtime.sendMessage({ type: 'DELETE_ACCOUNT' }).catch(e => ({ error: e.message }))
    dbgLog('← DELETE_ACCOUNT', res)
  })

  document.getElementById('dbg-coins').addEventListener('click', async () => {
    dbgLog('→ POST /debug/set-balance', '')
    const { jwt } = await chrome.storage.local.get('jwt')
    if (!jwt) { dbgLog('Coins×999', 'JWTがありません'); return }
    try {
      const res = await fetch(`${WORKER_URL}/debug/set-balance`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}` }
      })
      const data = await res.json()
      dbgLog(`← /debug/set-balance (${res.status})`, data)
      if (data.ok) {
        document.getElementById('coin-balance').textContent = data.balance
      }
    } catch (e) {
      dbgLog('← /debug/set-balance ERROR', e.message)
    }
  })

  document.getElementById('dbg-alarms').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'DBG_GET_ALARMS' }).catch(e => ({ error: e.message }))
    dbgLog('Alarms', res.alarms?.length ? res.alarms : '(none)')
  })

  document.getElementById('dbg-force-display').addEventListener('click', async () => {
    dbgLog('→ Force Display Tick', '')
    const res = await chrome.runtime.sendMessage({ type: 'DBG_FORCE_DISPLAY' }).catch(e => ({ error: e.message }))
    dbgLog('← Force Display', res)
  })

  document.getElementById('dbg-reschedule').addEventListener('click', async () => {
    dbgLog('→ Reschedule Alarms', '')
    const res = await chrome.runtime.sendMessage({ type: 'DBG_RESCHEDULE_ALARMS' }).catch(e => ({ error: e.message }))
    dbgLog('← Reschedule', res)
  })

  document.getElementById('dbg-oauth').addEventListener('click', () => {
    const redirectUrl = chrome.identity.getRedirectURL()
    const authUrl = `${SUPABASE_URL}/auth/v1/authorize?` + new URLSearchParams({
      provider: 'google', redirect_to: redirectUrl
    })
    dbgLog('OAuth設定', { redirectUrl, authUrl })
  })
}

async function runDbgStorage() {
  const data = await chrome.storage.local.get([
    'jwt', 'refreshToken', 'tokenExpiresAt', 'registered', 'settings'
  ])
  const now = Date.now()
  const exp = data.tokenExpiresAt
  const info = {
    jwt:            data.jwt ? `${data.jwt.slice(0, 30)}… (${data.jwt.length}文字)` : 'なし',
    refreshToken:   data.refreshToken ? `${data.refreshToken.slice(0, 10)}… (存在)` : 'なし',
    tokenExpiresAt: exp ? new Date(exp).toLocaleString('ja-JP') : 'なし',
    tokenStatus:    !exp ? '不明' : now > exp ? '期限切れ ❌' : `有効 ✓ (残り${Math.floor((exp - now) / 60000)}分)`,
    registered:     data.registered ?? false,
    settings:       data.settings ?? {}
  }
  dbgLog('Storage状態', info)
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function updateBadge(enabled) {
  const badge = document.getElementById('status-badge')
  badge.textContent = enabled ? 'ON' : 'OFF'
  badge.className = 'badge ' + (enabled ? 'badge-on' : 'badge-off')
}

function decodeUserName(jwt) {
  try {
    const [, payload] = jwt.split('.')
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return decoded.user_metadata?.full_name
      ?? decoded.user_metadata?.name
      ?? decoded.email
      ?? 'アカウント'
  } catch {
    return 'アカウント'
  }
}

function show(id, visible = true) {
  document.getElementById(id)?.classList.toggle('hidden', !visible)
}

setupDebugPanel()
init()
