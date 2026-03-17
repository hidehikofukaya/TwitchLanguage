/**
 * TwitchLaunguage - Service Worker (Manifest V3)
 *
 * Responsibilities:
 *   1. Pre-fetch phrase explanations from the API every 2 min (background)
 *   2. Drive the display timer (sends SHOW_PHRASE to content script)
 *   3. Handle coin consumption before each display
 *   4. Notify content script of cache status changes
 */

import {
  storePhrases, dequeueNextPhrase, recordSelection,
  getQueueLength, clearCache, buildKey
} from './cache.js'
import { fetchPhrases, consumeCoin, fetchBalance, register, deleteAccount } from './api-client.js'

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────
const SUPABASE_URL         = 'https://opbilttrjwowvqpbvctv.supabase.co'
const DISPLAY_ALARM        = 'tl_display'
const PREFETCH_ALARM  = 'tl_prefetch'
const DEFAULT_INTERVAL_SEC = 60    // display interval in seconds
const MAX_LLM_INTERVAL_SEC = 120   // max 2 min between LLM calls
const LOW_CACHE_THRESHOLD  = 3     // early-trigger if queue < this

// ──────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings()
  scheduleAlarms(settings.intervalSec ?? DEFAULT_INTERVAL_SEC)
})

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings()
  scheduleAlarms(settings.intervalSec ?? DEFAULT_INTERVAL_SEC)
})

// ──────────────────────────────────────────────
// Alarm handlers
// ──────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === DISPLAY_ALARM)  await onDisplayTick()
  if (alarm.name === PREFETCH_ALARM) await onPrefetchTick()
})

async function onDisplayTick() {
  try {
    const settings = await getSettings()
    if (settings.enabled === false) {
      swLog('info', 'display tick: skipped (disabled)')
      return
    }

    const queueLen = await getQueueLength()
    swLog('info', `display tick: queueLen=${queueLen}`)

    // Early prefetch trigger if cache is running low
    if (queueLen <= LOW_CACHE_THRESHOLD) {
      notifyContentScript({ type: 'CACHE_STATUS', status: 'low' })
      await onPrefetchTick()
    }

    const phrase = await dequeueNextPhrase()
    if (!phrase) {
      swLog('info', 'display tick: no phrase in queue')
      notifyContentScript({ type: 'CACHE_STATUS', status: 'empty' })
      return
    }

    swLog('info', `display tick: dequeued "${phrase.phrase}"`)

    // Consume coin BEFORE displaying (server-authoritative)
    const coinResult = await consumeCoin()
    swLog('info', 'coin consumed', { balance: coinResult.balance, ok: coinResult.ok })

    if (!coinResult.ok) {
      // Put phrase back by re-storing it
      await storePhrases([phrase])
      notifyContentScript({ type: 'NO_COINS', balance: coinResult.balance ?? 0 })
      return
    }

    // Success: display phrase and record selection
    const key = buildKey(phrase)
    await recordSelection(key)

    // Record to explained history for duplicate-suppression and future history view
    const { currentChannel = '' } = await chrome.storage.local.get('currentChannel')
    if (currentChannel) await addToExplainedHistory(currentChannel, phrase)

    swLog('info', `SHOW_PHRASE → "${phrase.phrase}"`)
    await notifyContentScript({
      type:    'SHOW_PHRASE',
      phrase,
      balance: coinResult.balance
    })
  } catch (err) {
    swLog('error', `onDisplayTick error: ${err.message}`)
  }
}

async function onPrefetchTick() {
  const settings = await getSettings()
  if (settings.enabled === false) return

  // Respect max LLM call frequency — set timestamp immediately to prevent race condition
  const { lastLlmCall = 0 } = await chrome.storage.local.get('lastLlmCall')
  const elapsed = (Date.now() - lastLlmCall) / 1000
  if (elapsed < MAX_LLM_INTERVAL_SEC) {
    swLog('info', `prefetch skip: cooldown ${Math.round(elapsed)}/${MAX_LLM_INTERVAL_SEC}s`)
    return
  }
  await chrome.storage.local.set({ lastLlmCall: Date.now() })

  const { currentChannel = '', currentMetadata = {} } = await chrome.storage.local.get(['currentChannel', 'currentMetadata'])
  const currentComments = await getCurrentComments()

  // Supplement with rolling cache to reach up to 100 comments
  let candidateComments = currentComments
  if (currentChannel && currentComments.length < 100) {
    const rollingKey = `rolling_comments_${currentChannel}`
    const { [rollingKey]: rolling = [] } = await chrome.storage.local.get(rollingKey)
    const currentKeys = new Set(currentComments.map(c =>
      `${(typeof c === 'string' ? '' : c.timestamp) ?? ''}::${typeof c === 'string' ? c : c.text}`
    ))
    const supplement = rolling
      .filter(c => !currentKeys.has(`${c.timestamp ?? ''}::${c.text}`))
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
      .slice(0, 100 - currentComments.length)
    candidateComments = [...currentComments, ...supplement]
  }

  // Filter out recently explained phrases; fall back to unfiltered if result < 10
  const commentsToSend = await filterExplainedComments(candidateComments, currentChannel)

  swLog('info', `prefetch: candidates=${candidateComments.length}, after_filter=${commentsToSend.length}`)

  if (commentsToSend.length < 10) {
    swLog('warn', `prefetch abort: not enough comments after filtering (${commentsToSend.length})`)
    return
  }

  notifyContentScript({ type: 'CACHE_STATUS', status: 'fetching' })

  try {
    const result = await fetchPhrases(
      commentsToSend,
      settings.nativeLang ?? 'ja',
      currentMetadata
    )

    swLog('info', 'phrases fetched', { count: result.phrases?.length ?? 0 })

    if (result.ok && result.phrases?.length > 0) {
      await storePhrases(result.phrases)
    }

    notifyContentScript({ type: 'CACHE_STATUS', status: 'ready' })
  } catch (err) {
    swLog('error', 'prefetch failed', err.message)
    console.error('[TL] prefetch error:', err)
    notifyContentScript({ type: 'CACHE_STATUS', status: 'error' })
  }
}

// ──────────────────────────────────────────────
// Message handler (from content script / popup)
// ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(err => {
      console.error('[TL] Unhandled message error:', err)
      sendResponse({ ok: false, error: err.message })
    })
  return true   // keep channel open for async
})

async function handleMessage(msg, sender) {
  swLog('info', `MSG: ${msg.type}`)
  switch (msg.type) {
    case 'NEXT_PHRASE':
      await onDisplayTick()
      return { ok: true }

    case 'UPDATE_COMMENTS': {
      const channel  = msg.channel  ?? ''
      const metadata = msg.metadata ?? {}
      // Clear phrase queue when channel changes to prevent stale phrases from leaking
      const { currentChannel: prevChannel = '' } = await chrome.storage.local.get('currentChannel')
      if (channel && channel !== prevChannel) {
        await clearCache()
        swLog('info', `channel changed: ${prevChannel} → ${channel}, phrase queue cleared`)
      }
      await chrome.storage.local.set({ currentComments: msg.comments, currentChannel: channel, currentMetadata: metadata })
      if (channel && Array.isArray(msg.comments) && msg.comments.length > 0) {
        await appendToRollingCache(channel, msg.comments)
      }
      return { ok: true }
    }

    case 'GET_BALANCE': {
      const res = await fetchBalance()
      return { balance: res.balance ?? 0 }
    }

    case 'INITIATE_OAUTH':
      return await handleInitiateOAuth()

    case 'REGISTER': {
      const res = await register()
      if (res.ok) {
        await chrome.storage.local.set({ registered: true })
      }
      return res
    }

    case 'UPDATE_SETTINGS': {
      await chrome.storage.local.set({ settings: msg.settings })
      await clearCache()
      chrome.alarms.clearAll(() => {
        scheduleAlarms(msg.settings.intervalSec ?? DEFAULT_INTERVAL_SEC)
      })
      return { ok: true }
    }

    case 'DELETE_ACCOUNT': {
      const res = await deleteAccount()
      if (res.ok) await chrome.storage.local.clear()
      return res
    }

    case 'SAVE_JWT':
      if (msg.jwt === null) {
        await chrome.storage.local.remove(['jwt', 'refreshToken', 'tokenExpiresAt'])
      } else {
        await chrome.storage.local.set({ jwt: msg.jwt })
      }
      return { ok: true }

    case 'LOGOUT':
      await chrome.storage.local.remove(['jwt', 'refreshToken', 'tokenExpiresAt', 'registered'])
      return { ok: true }

    case 'SHOW_OVERLAY':
      await notifyContentScript({ type: 'SHOW_OVERLAY' })
      return { ok: true }

    case 'DBG_GET_ALARMS': {
      const alarms = await chrome.alarms.getAll()
      return { alarms: alarms.map(a => ({
        name: a.name,
        scheduledTime: new Date(a.scheduledTime).toISOString(),
        periodInMinutes: a.periodInMinutes
      }))}
    }

    case 'DBG_FORCE_DISPLAY':
      await onDisplayTick()
      return { ok: true }

    case 'DBG_RESCHEDULE_ALARMS': {
      const settings = await getSettings()
      await new Promise(resolve => chrome.alarms.clearAll(resolve))
      scheduleAlarms(settings.intervalSec ?? DEFAULT_INTERVAL_SEC)
      const alarms = await chrome.alarms.getAll()
      swLog('info', 'alarms rescheduled', alarms.map(a => a.name))
      return { ok: true, alarms: alarms.map(a => a.name) }
    }

    default:
      return { ok: false, error: 'unknown message' }
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function scheduleAlarms(intervalSec) {
  const intervalMin = intervalSec / 60

  chrome.alarms.create(DISPLAY_ALARM, {
    delayInMinutes: intervalMin,
    periodInMinutes: intervalMin
  })
  chrome.alarms.create(PREFETCH_ALARM, {
    delayInMinutes: MAX_LLM_INTERVAL_SEC / 60,
    periodInMinutes: MAX_LLM_INTERVAL_SEC / 60
  })
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings')
  return settings
}

async function getCurrentComments() {
  const { currentComments = [] } = await chrome.storage.local.get('currentComments')
  return currentComments
}

/** Append new comments to per-channel rolling cache (24h TTL, max 500 entries). */
async function appendToRollingCache(channel, newComments) {
  const key = `rolling_comments_${channel}`
  const { [key]: existing = [] } = await chrome.storage.local.get(key)

  const now = Date.now()
  const TTL_MS = 24 * 60 * 60 * 1000

  const pruned = existing.filter(c => {
    const ts = c.timestamp ? new Date(c.timestamp).getTime() : 0
    return now - ts < TTL_MS
  })

  const existingKeys = new Set(pruned.map(c => `${c.timestamp ?? ''}::${c.text}`))
  const toAdd = newComments
    .map(c => typeof c === 'string' ? { text: c, username: null, timestamp: null } : c)
    .filter(c => !existingKeys.has(`${c.timestamp ?? ''}::${c.text}`))

  const merged = [...pruned, ...toAdd].slice(-500)
  await chrome.storage.local.set({ [key]: merged })
}

/**
 * Filter comments containing recently-explained phrases.
 * "Recent" = last 20 explained OR within 72 hours (union).
 * Falls back to unfiltered list if result would be < 10.
 */
async function filterExplainedComments(comments, channel) {
  if (!channel || comments.length === 0) return comments

  const histKey = `explained_history_${channel}`
  const { [histKey]: history = [] } = await chrome.storage.local.get(histKey)
  if (history.length === 0) return comments

  const now = Date.now()
  const TTL_72H = 72 * 60 * 60 * 1000
  const sorted = [...history].sort((a, b) => new Date(b.explained_at) - new Date(a.explained_at))

  const recentPhrases = new Set()
  sorted.forEach((p, i) => {
    const age = now - new Date(p.explained_at).getTime()
    if (i < 20 || age < TTL_72H) recentPhrases.add(p.phrase.toLowerCase())
  })

  if (recentPhrases.size === 0) return comments

  const filtered = comments.filter(c => {
    const text = (typeof c === 'string' ? c : c.text).toLowerCase()
    return ![...recentPhrases].some(phrase => text.includes(phrase))
  })

  return filtered.length >= 10 ? filtered : comments
}

/** Append a displayed phrase to per-channel explained history (90-day TTL). */
async function addToExplainedHistory(channel, phrase) {
  const key = `explained_history_${channel}`
  const { [key]: history = [] } = await chrome.storage.local.get(key)

  const TTL_90D = 90 * 24 * 60 * 60 * 1000
  const now = Date.now()
  const pruned = history.filter(p => now - new Date(p.explained_at).getTime() < TTL_90D)

  pruned.push({
    phrase:         phrase.phrase,
    pronunciation:  phrase.pronunciation  ?? null,
    translation:    phrase.translation,
    nuance:         phrase.nuance,
    example:        phrase.example,
    similar:        phrase.similar        ?? [],
    source_comment: phrase.source_comment ?? null,
    explained_at:   new Date().toISOString(),
    channel
  })

  await chrome.storage.local.set({ [key]: pruned })
}

async function handleInitiateOAuth() {
  try {
    const redirectUrl = chrome.identity.getRedirectURL()
    const authUrl = `${SUPABASE_URL}/auth/v1/authorize?` + new URLSearchParams({
      provider:    'google',
      redirect_to: redirectUrl
    })

    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, url => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else if (!url) reject(new Error('コールバック URL が空です'))
        else resolve(url)
      })
    })

    // Parse tokens – support both implicit (#access_token) and PKCE (?code) responses
    const cb    = new URL(responseUrl)
    const hash  = new URLSearchParams(cb.hash.slice(1))
    const query = cb.searchParams
    const accessToken = hash.get('access_token') ?? query.get('access_token')

    if (!accessToken) {
      const errParam = hash.get('error') ?? query.get('error')
      const code     = hash.get('code')  ?? query.get('code')
      if (errParam) return { ok: false, error: `OAuth エラー: ${errParam}` }
      if (code)     return { ok: false, error: `PKCE フローが検出されました。Supabase の Auth 設定で Implicit Grant を有効にしてください。(code=${code.slice(0, 8)}…)` }
      return { ok: false, error: `access_token が取得できませんでした (URL: ${responseUrl.slice(0, 120)})` }
    }

    const refreshToken   = hash.get('refresh_token') ?? query.get('refresh_token') ?? ''
    const expiresIn      = parseInt(hash.get('expires_in') ?? query.get('expires_in') ?? '3600', 10)
    const tokenExpiresAt = Date.now() + expiresIn * 1000

    await chrome.storage.local.set({ jwt: accessToken, refreshToken, tokenExpiresAt })
    return { ok: true }

  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function swLog(level, msg, data) {
  const prefix = level === 'error' ? '[ERR]' : level === 'warn' ? '[WARN]' : '[INFO]'
  console.log(`[TL SW] ${prefix} ${msg}`, data ?? '')
  notifyContentScript({ type: 'TL_LOG', level, msg, data })
}

async function notifyContentScript(msg) {
  const tabs = await chrome.tabs.query({ url: 'https://www.twitch.tv/*' })
  await Promise.all(
    tabs.map(tab => chrome.tabs.sendMessage(tab.id, msg).catch(() => {}))
  )
}
