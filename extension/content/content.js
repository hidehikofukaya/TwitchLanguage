/**
 * TwitchLaunguage - Content Script (single file, no ES module imports)
 * observer.js + ui.js + content.js を統合
 */

// ══════════════════════════════════════════════
// observer.js
// ══════════════════════════════════════════════
const BUFFER_SIZE = 100
const FLUSH_INTERVAL_MS = 5000

let commentBuffer = []
let chatObserver = null
let flushTimer = null

function startObserver(onCommentsReady) {
  waitForChatContainer().then(container => {
    chatObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          const data = extractCommentData(node)
          if (data) {
            commentBuffer.push(data)
            if (commentBuffer.length > BUFFER_SIZE) {
              commentBuffer = commentBuffer.slice(-BUFFER_SIZE)
            }
          }
        }
      }
    })
    chatObserver.observe(container, { childList: true, subtree: true })
    tlLog('info', 'chat observer attached, subtree:true')

    flushTimer = setInterval(() => {
      if (!isContextValid()) { stopObserver(); return }
      tlLog('info', `flush tick: buffer=${commentBuffer.length}`)
      if (commentBuffer.length > 0) {
        onCommentsReady([...commentBuffer])
      }
    }, FLUSH_INTERVAL_MS)
  }).catch(err => {
    tlLog('error', `startObserver failed: ${err.message}`)
  })
}

function stopObserver() {
  chatObserver?.disconnect()
  chatObserver = null
  clearInterval(flushTimer)
  flushTimer = null
  commentBuffer = []
}

// Selectors tried in order — broad fallbacks at the bottom
const CHAT_SELECTORS = [
  '[data-test-selector="chat-scrollable-area__message-container"]',
  '[data-a-target="chat-scroller"] .simplebar-scroll-content',
  '[data-a-target="chat-scroller"] .simplebar-content',
  '[data-a-target="chat-scroller"]',
  '.chat-list--default .simplebar-scroll-content',
  '.chat-list--default .simplebar-content',
  '.chat-list--default',
  '.chat-list .simplebar-scroll-content',
  '.chat-list .simplebar-content',
  '.chat-list',
  // broad class-wildcard fallbacks
  'div[class*="chat-list"]',
  'div[class*="chatRoom"] ul',
  '.stream-chat [class*="chat-list"]',
]

function findChatContainer() {
  for (const sel of CHAT_SELECTORS) {
    try {
      const el = document.querySelector(sel)
      if (el) {
        tlLog('info', `chat container found: ${sel}`)
        return el
      }
    } catch {}
  }
  // Last resort: log all elements with "chat" in class for diagnosis
  const all = [...document.querySelectorAll('[class*="chat"]')]
    .map(el => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`)
    .slice(0, 10)
  tlLog('warn', `chat not found. Elements with "chat" class: ${all.join(', ') || 'none'}`)
  return null
}

function waitForChatContainer(maxWaitMs = 30000) {
  return new Promise((resolve, reject) => {
    const existing = findChatContainer()
    if (existing) return resolve(existing)

    tlLog('info', 'waiting for chat container...')
    const poll = setInterval(() => {
      const el = findChatContainer()
      if (el) { clearInterval(poll); resolve(el) }
    }, 1000)

    setTimeout(() => {
      clearInterval(poll)
      tlLog('error', 'chat container not found after timeout')
      reject(new Error('Chat container not found'))
    }, maxWaitMs)
  })
}

const MSG_SELECTORS = [
  '[data-a-target="chat-message-text"]',
  '[data-test-selector="chat-message-text"]',
  '.chat-line__message span.text-fragment',
  '.message',
]

const USERNAME_SELECTORS = [
  '[data-a-user]',
  '.chat-author__display-name',
  '.chat-line__username',
  '[data-test-selector="message-username"]',
]

/** Returns { text, username, timestamp } or null */
function extractCommentData(node) {
  if (!(node instanceof Element)) return null

  let msgEl = null
  for (const sel of MSG_SELECTORS) {
    msgEl = node.querySelector?.(sel)
      ?? (node.matches?.(sel) ? node : null)
    if (msgEl) break
  }
  if (!msgEl) return null

  const parts = []
  msgEl.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      parts.push(child.textContent)
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const alt = child.querySelector?.('img')?.alt
      parts.push(alt ?? child.textContent)
    }
  })
  const text = parts.join('').trim()
  if (!text) return null

  let username = null
  for (const sel of USERNAME_SELECTORS) {
    const el = node.querySelector?.(sel)
    if (el) {
      username = el.getAttribute('data-a-user') ?? el.textContent?.trim() ?? null
      if (username) break
    }
  }

  return { text, username, timestamp: new Date().toISOString() }
}

// ══════════════════════════════════════════════
// ui.js
// ══════════════════════════════════════════════
const OVERLAY_ID = 'tl-overlay'
const CARD_ID    = 'tl-card'

// ── Debug log ──────────────────────────────────
function tlLog(level, msg, data) {
  const out = document.getElementById('tl-debug-output')
  if (!out) return
  const ts = new Date().toISOString().slice(11, 23)
  const icon = level === 'error' ? '❌' : level === 'warn' ? '⚠' : '·'
  const body = data !== undefined ? ' ' + JSON.stringify(data) : ''
  out.textContent += `[${ts}] ${icon} ${msg}${body}\n`
  const lines = out.textContent.split('\n')
  if (lines.length > 600) out.textContent = lines.slice(-500).join('\n')
  out.scrollTop = out.scrollHeight
}

function initUI() {
  if (document.getElementById(OVERLAY_ID)) return
  createOverlay()
}

function formatTime(iso) {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

/** Highlight all case-insensitive occurrences of phrase within already-escaped HTML text. */
function highlightPhraseInText(text, phrase) {
  const escapedText = escHtml(text)
  if (!phrase) return escapedText
  const escapedPhrase = escHtml(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escapedText.replace(
    new RegExp(escapedPhrase, 'gi'),
    '<span class="tl-phrase-highlight">$&</span>'
  )
}

function showPhrase(phrase, balance) {
  ensureOverlay()
  setCacheStatus('ready')
  setBalance(balance)
  tlLog('info', 'SHOW_PHRASE', { phrase: phrase.phrase, balance })

  const src = phrase.source_comment
  const sourceMeta = src
    ? `${src.username ? escHtml(src.username) + ' · ' : ''}${formatTime(src.timestamp)}`
    : ''
  const sourceText = src?.text
    ? highlightPhraseInText(src.text, phrase.phrase)
    : '—'
  const sourceHtml = `<div class="tl-source-comment">
      ${sourceMeta ? `<span class="tl-source-meta">${sourceMeta}</span>` : ''}
      <span class="tl-source-text">${sourceText}</span>
    </div>`

  const uncertainBadge = phrase.uncertain
    ? `<span class="tl-uncertain-badge">⚠ 意味未確認</span>`
    : ''

  const pronunciationHtml = phrase.pronunciation
    ? `<span class="tl-pronunciation">${escHtml(phrase.pronunciation)}</span>`
    : ''

  const card = document.getElementById(CARD_ID)
  card.innerHTML = `
    ${sourceHtml}
    <div class="tl-phrase-row">
      <span class="tl-phrase">${escHtml(phrase.phrase)}</span>
      ${pronunciationHtml}
      ${uncertainBadge}
    </div>
    <div class="tl-translation">${escHtml(phrase.translation)}</div>
    <div class="tl-nuance">${escHtml(phrase.nuance)}</div>
    <div class="tl-example">${escHtml(phrase.example)}</div>
    ${phrase.example_translation
      ? `<div class="tl-example-translation">${escHtml(phrase.example_translation)}</div>`
      : ''}
  `
  card.classList.remove('tl-flash')
  void card.offsetWidth
  card.classList.add('tl-flash')
}

function showNoCoins() {
  ensureOverlay()
  tlLog('warn', 'コインが不足しています')
  const card = document.getElementById(CARD_ID)
  card.innerHTML = `
    <div class="tl-empty">
      コインがなくなりました 🪙<br>
      <a class="tl-buy-link" href="#" id="tl-buy-btn">コインを購入</a>
    </div>
  `
  document.getElementById('tl-buy-btn')?.addEventListener('click', e => {
    e.preventDefault()
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP' })
  })
}

function setCacheStatus(status) {
  const indicator = document.getElementById('tl-status-dot')
  if (!indicator) return
  const MAP = {
    ready:    { label: '●', title: '準備完了',           cls: 'tl-s-ready' },
    fetching: { label: '⟳', title: 'フレーズを取得中...', cls: 'tl-s-fetching' },
    low:      { label: '◐', title: 'フレーズを補充中...', cls: 'tl-s-low' },
    error:    { label: '△', title: '取得に失敗しました',   cls: 'tl-s-error' },
    empty:    { label: '◐', title: 'フレーズがありません', cls: 'tl-s-low' }
  }
  const cfg = MAP[status] ?? MAP.ready
  indicator.textContent = cfg.label
  indicator.title       = cfg.title
  indicator.className   = `tl-status-dot ${cfg.cls}`
  if (status !== 'ready') tlLog('info', `cache: ${status}`)
}

function setBalance(balance) {
  const el = document.getElementById('tl-balance')
  if (el) el.textContent = `🪙 ${balance}`
}

function destroyUI() {
  document.getElementById(OVERLAY_ID)?.remove()
}

function ensureOverlay() {
  const el = document.getElementById(OVERLAY_ID)
  if (el) {
    el.style.display = ''   // 隠れていても必ず再表示
  } else {
    createOverlay()
  }
}

function createOverlay() {
  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.innerHTML = `
    <div class="tl-header">
      <span class="tl-logo">TwitchLaunguage</span>
      <span id="tl-status-dot" class="tl-status-dot tl-s-ready" title="準備完了">●</span>
      <span id="tl-balance" class="tl-balance">🪙 --</span>
      <label class="tl-toggle" title="フレーズ表示 ON/OFF">
        <input type="checkbox" id="tl-enabled-toggle" checked>
        <span class="tl-toggle-track"></span>
      </label>
      <div class="tl-acct-wrap">
        <button id="tl-acct-btn" class="tl-hdr-btn" title="アカウント">⚙</button>
        <div id="tl-acct-menu" class="tl-acct-menu tl-hidden">
          <div id="tl-acct-name" class="tl-acct-name">---</div>
          <button id="tl-logout-btn" class="tl-menu-item">ログアウト</button>
        </div>
      </div>
      <button id="tl-dbg-btn" class="tl-hdr-btn" title="デバッグログ">≡</button>
      <button id="tl-close-btn" class="tl-close-btn" title="閉じる">✕</button>
    </div>
    <div id="${CARD_ID}" class="tl-card">
      <div class="tl-empty">配信を開くとフレーズが表示されます</div>
    </div>
    <div id="tl-debug-panel" class="tl-debug-panel tl-hidden">
      <div class="tl-debug-toolbar">
        <span class="tl-debug-title">Debug Log</span>
        <button id="tl-dbg-clear" class="tl-dbg-clear">CLR</button>
      </div>
      <pre id="tl-debug-output" class="tl-debug-output"></pre>
    </div>
  `
  document.body.appendChild(overlay)
  makeDraggable(overlay)
  bindOverlayEvents(overlay)
  loadOverlayState()
  tlLog('info', 'overlay initialized')
}

function bindOverlayEvents(overlay) {
  // Toggle ON/OFF
  const toggle = document.getElementById('tl-enabled-toggle')
  toggle.addEventListener('change', async () => {
    if (!isContextValid()) return
    try {
      const { settings: cur = {} } = await chrome.storage.local.get('settings')
      const next = { ...cur, enabled: toggle.checked }
      await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: next })
      tlLog('info', `フレーズ表示: ${toggle.checked ? 'ON' : 'OFF'}`)
    } catch {}
  })

  // Sync toggle when storage changes (e.g. popup toggle)
  chrome.storage.onChanged.addListener((changes) => {
    if (!isContextValid()) return
    if (changes.settings?.newValue) {
      const enabled = changes.settings.newValue.enabled !== false
      if (toggle.checked !== enabled) toggle.checked = enabled
    }
  })

  // Account button / dropdown
  const acctBtn  = document.getElementById('tl-acct-btn')
  const acctMenu = document.getElementById('tl-acct-menu')
  acctBtn.addEventListener('click', e => {
    e.stopPropagation()
    acctMenu.classList.toggle('tl-hidden')
  })
  document.addEventListener('click', () => acctMenu.classList.add('tl-hidden'))

  document.getElementById('tl-logout-btn').addEventListener('click', async () => {
    if (!isContextValid()) return
    acctMenu.classList.add('tl-hidden')
    try {
      await chrome.runtime.sendMessage({ type: 'LOGOUT' })
    } catch {}
    tlLog('info', 'ログアウトしました')
    document.getElementById(CARD_ID).innerHTML =
      '<div class="tl-empty">ログアウトしました。<br>ポップアップから再ログインしてください。</div>'
    setBalance('--')
    toggle.checked = false
  })

  // Debug panel
  const dbgPanel = document.getElementById('tl-debug-panel')
  document.getElementById('tl-dbg-btn').addEventListener('click', () => {
    dbgPanel.classList.toggle('tl-hidden')
  })
  document.getElementById('tl-dbg-clear').addEventListener('click', () => {
    document.getElementById('tl-debug-output').textContent = ''
  })

  // Close
  document.getElementById('tl-close-btn').addEventListener('click', () => {
    overlay.style.display = 'none'
  })
}

async function loadOverlayState() {
  if (!isContextValid()) return
  // Load enabled toggle state
  const { settings = {}, jwt } = await chrome.storage.local.get(['settings', 'jwt'])
  const toggle = document.getElementById('tl-enabled-toggle')
  if (toggle) toggle.checked = settings.enabled !== false

  // Load account name from JWT
  if (jwt) {
    try {
      const [, payload] = jwt.split('.')
      const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
      const name = decoded.user_metadata?.full_name
        ?? decoded.user_metadata?.name
        ?? decoded.email
        ?? 'アカウント'
      const el = document.getElementById('tl-acct-name')
      if (el) el.textContent = name
    } catch {}
  }
}

function makeDraggable(el) {
  let startX, startY, startLeft, startTop, dragging = false
  const header = el.querySelector('.tl-header')
  header.addEventListener('mousedown', e => {
    if (e.target.closest('button, label, input')) return
    dragging = true
    startX = e.clientX; startY = e.clientY
    const rect = el.getBoundingClientRect()
    startLeft = rect.left; startTop = rect.top
    e.preventDefault()
  })
  document.addEventListener('mousemove', e => {
    if (!dragging) return
    el.style.left   = `${startLeft + e.clientX - startX}px`
    el.style.top    = `${startTop  + e.clientY - startY}px`
    el.style.right  = 'auto'
    el.style.bottom = 'auto'
  })
  document.addEventListener('mouseup', () => { dragging = false })
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ══════════════════════════════════════════════
// content.js (エントリポイント)
// ══════════════════════════════════════════════

/** 拡張機能のコンテキストがまだ有効か確認（再読み込み後に無効になる） */
function isContextValid() {
  try { return !!chrome.runtime?.id } catch { return false }
}
let currentPath = location.pathname

function isChannelPage() {
  return /^\/[^/]+\/?$/.test(location.pathname) && location.pathname !== '/'
}

const STREAM_TITLE_SELECTORS = [
  '[data-a-target="stream-title"]',
  'p[data-a-target="stream-status-text"]',
  'h2.tw-title',
  '[class*="stream-info"] h2',
]

const GAME_TITLE_SELECTORS = [
  '[data-a-target="stream-game-link"]',
  'a[href*="/directory/game/"]',
  'a[href*="/directory/category/"]',
  '[class*="game-link"]',
]

// Twitch shows broadcast language as a tag or link near the stream info.
// Multiple selector candidates to cover DOM changes across Twitch versions.
const STREAM_LANG_SELECTORS = [
  'a[href*="/directory/all/lang="]',          // language directory link
  '[data-test-selector="language-tag"] a',    // language tag element
  '[data-a-target="language-toggle"] span',   // language toggle button
  '.language-select-rework__option--selected',// legacy language select
]

// Twitch locale → BCP47 lang code mapping (display name fallback)
const TWITCH_LANG_NAMES = {
  '日本語': 'ja', 'japanese': 'ja',
  'english': 'en', '英語': 'en',
  '한국어': 'ko', 'korean': 'ko',
  '中文': 'zh', 'chinese': 'zh',
  'español': 'es', 'spanish': 'es',
  'français': 'fr', 'french': 'fr',
  'deutsch': 'de', 'german': 'de',
  'português': 'pt', 'portuguese': 'pt',
  'русский': 'ru', 'russian': 'ru',
}

/**
 * Detect the dominant language from comment text.
 * Used as fallback when DOM-based detection fails.
 */
function detectLangFromComments(comments) {
  const text = comments.map(c => typeof c === 'string' ? c : c.text).join('')
  const kana   = (text.match(/[\u3040-\u30ff]/g) || []).length   // hiragana/katakana → ja only
  const hangul = (text.match(/[\uAC00-\uD7AF]/g) || []).length   // Korean
  const cjk    = (text.match(/[\u4e00-\u9fff]/g) || []).length   // CJK (shared ja/zh)
  const latin  = (text.match(/[a-zA-Z]/g)        || []).length
  const total  = kana + hangul + cjk + latin
  if (total < 10) return null
  if (kana > 0)                    return 'ja'   // kana is unique to Japanese
  if (hangul / total > 0.2)        return 'ko'
  if (cjk    / total > 0.3)        return 'zh'
  if (latin  / total > 0.5)        return 'en'
  return null
}

function getStreamMetadata(comments = []) {
  let streamTitle = null
  for (const sel of STREAM_TITLE_SELECTORS) {
    const el = document.querySelector(sel)
    const text = el?.textContent?.trim()
    if (text) { streamTitle = text.slice(0, 80); break }
  }

  let gameTitle = null
  for (const sel of GAME_TITLE_SELECTORS) {
    const el = document.querySelector(sel)
    const text = el?.textContent?.trim()
    if (text) { gameTitle = text.slice(0, 60); break }
  }

  // 1. Try DOM-based language detection
  let streamLang = null
  for (const sel of STREAM_LANG_SELECTORS) {
    const el = document.querySelector(sel)
    if (!el) continue
    // Try href first (e.g. /directory/all/lang=ja)
    const href = el.getAttribute('href') ?? ''
    const m = href.match(/[?&]lang=([a-z]{2})/)
    if (m) { streamLang = m[1]; break }
    // Try text content (e.g. "日本語")
    const name = el.textContent?.trim().toLowerCase()
    if (name && TWITCH_LANG_NAMES[name]) { streamLang = TWITCH_LANG_NAMES[name]; break }
  }

  // 2. Fall back to comment text analysis
  if (!streamLang && comments.length > 0) {
    streamLang = detectLangFromComments(comments)
  }

  return { streamTitle, gameTitle, streamLang }
}

// ══════════════════════════════════════════════
// Supabase Realtime – coin balance push
// ══════════════════════════════════════════════
const SUPABASE_REALTIME_URL = 'wss://opbilttrjwowvqpbvctv.supabase.co/realtime/v1/websocket'
const SUPABASE_ANON_KEY     = 'sb_publishable_pzZ2FVQU2eapMjk0qqWqfA_17HYg3nd'

let realtimeWs             = null
let realtimeHeartbeatTimer = null
let realtimeReconnectTimer = null

function startBalanceRealtime(userId, jwt) {
  closeBalanceRealtime()

  const ws = new WebSocket(
    `${SUPABASE_REALTIME_URL}?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`
  )
  realtimeWs = ws
  let ref = 0

  ws.onopen = () => {
    tlLog('info', 'Realtime: connected')
    ws.send(JSON.stringify({
      topic:    'realtime:coins',
      event:    'phx_join',
      payload:  {
        config: {
          postgres_changes: [{
            event:  'UPDATE',
            schema: 'public',
            table:  'coin_balances',
            filter: `user_id=eq.${userId}`
          }]
        },
        access_token: jwt
      },
      ref:      String(++ref),
      join_ref: '1'
    }))
    realtimeHeartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }))
      }
    }, 25_000)
  }

  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.event === 'postgres_changes') {
        const balance = msg.payload?.data?.record?.balance
        if (balance != null) {
          tlLog('info', 'Realtime: balance pushed', { balance })
          setBalance(balance)
        }
      }
    } catch {}
  }

  ws.onclose = () => {
    closeBalanceRealtime()
    if (isContextValid()) {
      tlLog('info', 'Realtime: disconnected – reconnecting in 5s')
      realtimeReconnectTimer = setTimeout(() => startBalanceRealtime(userId, jwt), 5_000)
    }
  }

  ws.onerror = () => ws.close()
}

function closeBalanceRealtime() {
  if (realtimeHeartbeatTimer) { clearInterval(realtimeHeartbeatTimer);  realtimeHeartbeatTimer = null }
  if (realtimeReconnectTimer) { clearTimeout(realtimeReconnectTimer);   realtimeReconnectTimer = null }
  if (realtimeWs) {
    realtimeWs.onclose = null  // prevent reconnect loop during teardown
    realtimeWs.close()
    realtimeWs = null
  }
}

function decodeUserId(jwt) {
  try {
    const [, payload] = jwt.split('.')
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub ?? null
  } catch { return null }
}

// ══════════════════════════════════════════════
// Boot / teardown
// ══════════════════════════════════════════════
function boot() {
  initUI()
  startObserver(comments => {
    if (!isContextValid()) { stopObserver(); return }
    try {
      const channel = location.pathname.split('/')[1]?.toLowerCase().replace(/[^a-z0-9_]/g, '') ?? ''
      const metadata = getStreamMetadata(comments)
      tlLog('info', 'comments updated', { count: comments.length, channel, ...metadata })
      chrome.runtime.sendMessage({ type: 'UPDATE_COMMENTS', comments, channel, metadata })
    } catch {}
  })
  // Fetch balance once immediately, then subscribe for push updates
  try {
    chrome.runtime.sendMessage({ type: 'GET_BALANCE' }, res => {
      if (res?.balance != null) setBalance(res.balance)
    })
  } catch {}
  chrome.storage.local.get(['jwt'], ({ jwt }) => {
    const userId = jwt ? decodeUserId(jwt) : null
    if (userId) startBalanceRealtime(userId, jwt)
  })
  tlLog('info', 'boot: observer started')
}

function teardown() {
  stopObserver()
  destroyUI()
  closeBalanceRealtime()
}

function onNavigate() {
  const next = location.pathname
  if (next === currentPath) return
  currentPath = next
  teardown()
  if (isChannelPage()) setTimeout(boot, 800)
}

// SPA navigation
const origPush = history.pushState.bind(history)
history.pushState = (...args) => { origPush(...args); onNavigate() }
window.addEventListener('popstate', onNavigate)

// Messages from service worker
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isContextValid()) return
  switch (msg.type) {
    case 'SHOW_PHRASE':   showPhrase(msg.phrase, msg.balance); break
    case 'NO_COINS':      showNoCoins(); setBalance(0); break
    case 'CACHE_STATUS':  setCacheStatus(msg.status); break
    case 'TL_LOG':        tlLog(msg.level ?? 'info', `[SW] ${msg.msg}`, msg.data); break
    case 'SHOW_OVERLAY': {
      tlLog('info', 'SHOW_OVERLAY received')
      const overlay = document.getElementById(OVERLAY_ID)
      if (overlay) {
        overlay.style.display = ''
        tlLog('info', 'overlay re-shown (was hidden)')
      } else {
        createOverlay()
        tlLog('info', 'overlay created (was missing)')
      }
      break
    }
  }
})

// Boot
if (isChannelPage()) boot()
