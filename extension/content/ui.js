/**
 * Overlay UI for TwitchLaunguage.
 *
 * Shows a draggable card in the bottom-right corner with:
 *   - Phrase + translation
 *   - Nuance + example
 *   - "Next phrase" button (coin cost)
 *   - Coin balance
 *   - Small cache-status indicator
 */

const OVERLAY_ID   = 'tl-overlay'
const CARD_ID      = 'tl-card'

let overlayEl = null

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────
export function initUI() {
  if (document.getElementById(OVERLAY_ID)) return
  createOverlay()
}

export function showPhrase(phrase, balance) {
  ensureOverlay()
  setStatus('ready')
  setBalance(balance)

  const card = document.getElementById(CARD_ID)
  card.innerHTML = `
    <div class="tl-phrase">${escHtml(phrase.phrase)}</div>
    <div class="tl-translation">${escHtml(phrase.translation)}</div>
    <div class="tl-nuance">${escHtml(phrase.nuance)}</div>
    <div class="tl-example">${escHtml(phrase.example)}</div>
    ${phrase.similar?.length
      ? `<div class="tl-similar">類似: ${phrase.similar.map(escHtml).join(' / ')}</div>`
      : ''}
  `
  // Brief highlight animation
  card.classList.remove('tl-flash')
  void card.offsetWidth
  card.classList.add('tl-flash')
}

export function showNoCoins() {
  ensureOverlay()
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

export function setCacheStatus(status) {
  const indicator = document.getElementById('tl-status-dot')
  if (!indicator) return

  const MAP = {
    ready:    { label: '●',  title: '準備完了',     cls: 'tl-s-ready' },
    fetching: { label: '⟳',  title: 'フレーズを取得中...', cls: 'tl-s-fetching' },
    low:      { label: '◐',  title: 'フレーズを補充中...', cls: 'tl-s-low' },
    error:    { label: '△',  title: '取得に失敗しました',  cls: 'tl-s-error' },
    empty:    { label: '◐',  title: 'フレーズがありません', cls: 'tl-s-low' }
  }

  const cfg = MAP[status] ?? MAP.ready
  indicator.textContent = cfg.label
  indicator.title       = cfg.title
  indicator.className   = `tl-status-dot ${cfg.cls}`
}

export function setBalance(balance) {
  const el = document.getElementById('tl-balance')
  if (el) el.textContent = `🪙 ${balance}`
}

export function destroyUI() {
  document.getElementById(OVERLAY_ID)?.remove()
  overlayEl = null
}

// ──────────────────────────────────────────────
// Internal
// ──────────────────────────────────────────────
function ensureOverlay() {
  if (!document.getElementById(OVERLAY_ID)) createOverlay()
}

function createOverlay() {
  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.innerHTML = `
    <div class="tl-header">
      <span class="tl-logo">TwitchLaunguage</span>
      <span id="tl-status-dot" class="tl-status-dot tl-s-ready" title="準備完了">●</span>
      <span id="tl-balance" class="tl-balance">🪙 --</span>
      <button id="tl-next-btn" class="tl-next-btn" title="次のフレーズへ (🪙1)">▶</button>
      <button id="tl-close-btn" class="tl-close-btn" title="閉じる">✕</button>
    </div>
    <div id="${CARD_ID}" class="tl-card">
      <div class="tl-empty">配信を開くとフレーズが表示されます</div>
    </div>
  `
  document.body.appendChild(overlay)
  overlayEl = overlay

  makeDraggable(overlay)

  document.getElementById('tl-next-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'NEXT_PHRASE' })
  })
  document.getElementById('tl-close-btn').addEventListener('click', () => {
    overlay.style.display = 'none'
  })
}

function setStatus(status) {
  setCacheStatus(status)
}

function makeDraggable(el) {
  let startX, startY, startLeft, startTop, dragging = false

  const header = el.querySelector('.tl-header')
  header.addEventListener('mousedown', e => {
    dragging = true
    startX = e.clientX
    startY = e.clientY
    const rect = el.getBoundingClientRect()
    startLeft = rect.left
    startTop  = rect.top
    e.preventDefault()
  })

  document.addEventListener('mousemove', e => {
    if (!dragging) return
    el.style.left = `${startLeft + e.clientX - startX}px`
    el.style.top  = `${startTop  + e.clientY - startY}px`
    el.style.right = 'auto'
    el.style.bottom = 'auto'
  })

  document.addEventListener('mouseup', () => { dragging = false })
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
