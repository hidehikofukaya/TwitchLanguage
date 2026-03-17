/**
 * Twitch chat observer.
 * Monitors the chat DOM and maintains a rolling window of raw comment strings.
 */

const BUFFER_SIZE = 100
const FLUSH_INTERVAL_MS = 5000   // push comments to SW every 5 s

let commentBuffer = []
let observer = null
let flushTimer = null

export function startObserver(onCommentsReady) {
  waitForChatContainer().then(container => {
    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          const text = extractCommentText(node)
          if (text) {
            commentBuffer.push(text)
            if (commentBuffer.length > BUFFER_SIZE) {
              commentBuffer = commentBuffer.slice(-BUFFER_SIZE)
            }
          }
        }
      }
    })

    observer.observe(container, { childList: true, subtree: false })

    // Periodically forward the buffer to the service worker
    flushTimer = setInterval(() => {
      if (commentBuffer.length > 0) {
        onCommentsReady([...commentBuffer])
      }
    }, FLUSH_INTERVAL_MS)
  })
}

export function stopObserver() {
  observer?.disconnect()
  observer = null
  clearInterval(flushTimer)
  flushTimer = null
  commentBuffer = []
}

export function getCommentSnapshot() {
  return [...commentBuffer]
}

// ──────────────────────────────────────────────
// DOM helpers
// ──────────────────────────────────────────────
function waitForChatContainer(maxWaitMs = 15000) {
  return new Promise((resolve, reject) => {
    const SELECTOR = '[data-a-target="chat-scroller"] .simplebar-content, .chat-list--default'
    const existing = document.querySelector(SELECTOR)
    if (existing) return resolve(existing)

    const poll = setInterval(() => {
      const el = document.querySelector(SELECTOR)
      if (el) {
        clearInterval(poll)
        resolve(el)
      }
    }, 500)

    setTimeout(() => {
      clearInterval(poll)
      reject(new Error('Chat container not found'))
    }, maxWaitMs)
  })
}

function extractCommentText(node) {
  if (!(node instanceof Element)) return null

  // Twitch chat message container
  const msgEl = node.querySelector?.('[data-a-target="chat-message-text"]')
    ?? (node.matches?.('[data-a-target="chat-message-text"]') ? node : null)

  if (!msgEl) return null

  // Collect text nodes and emote alt-text
  const parts = []
  msgEl.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      parts.push(child.textContent)
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      // Emotes have alt text
      const alt = child.querySelector?.('img')?.alt
      if (alt) parts.push(alt)
      else parts.push(child.textContent)
    }
  })

  const text = parts.join('').trim()
  return text.length > 0 ? text : null
}
