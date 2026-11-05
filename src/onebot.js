/**
 * OneBot 11 传输层：连 NapCat 的 WebSocket 收事件，走 HTTP 发消息。
 *
 * 0.2 版的教训（2026-11-05 真机）：
 *   第一版只把重连挂在 `onclose` 上。但连接失败时，有的实现只发 `error` 不发 `close`，
 *   于是重试链断在第一次 —— 进程还活着、systemd 显示 active，实际上永远不会再连。
 *   现在：`error` 和 `close` 都触发重连，且用 single-flight 防重复建连；
 *   另外加看门狗：超过 WATCHDOG_MS 没连上就主动退出，让 systemd 拉起干净进程。
 */

const WATCHDOG_MS = Number(process.env.QQBOT_WATCHDOG_MS || 5 * 60_000)

export function createClient({ ws, http, token }) {
  let socket = null
  let connected = false
  let closed = false
  let connecting = false
  let backoff = 1000
  let lastConnectedAt = Date.now()
  let reconnectTimer = null

  const auth = token ? { Authorization: `Bearer ${token}` } : {}

  function scheduleReconnect(onEvent, onStatus, reason) {
    if (closed || reconnectTimer) return
    onStatus?.(`reconnect in ${Math.round(backoff / 1000)}s (${reason})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      backoff = Math.min(backoff * 2, 30_000)
      open(onEvent, onStatus)
    }, backoff)
  }

  function open(onEvent, onStatus) {
    if (closed || connecting || connected) return
    connecting = true

    let s
    try {
      s = new WebSocket(ws, { headers: auth })
    } catch (err) {
      connecting = false
      onStatus?.(`ctor failed: ${err?.message || err}`)
      scheduleReconnect(onEvent, onStatus, 'ctor')
      return
    }
    socket = s

    s.onopen = () => {
      connecting = false
      connected = true
      backoff = 1000
      lastConnectedAt = Date.now()
      onStatus?.('connected')
    }

    s.onerror = () => {
      connecting = false
      // 关键修复：error 也要能触发重连，不能只等 close
      onStatus?.('error')
      scheduleReconnect(onEvent, onStatus, 'error')
    }

    s.onclose = () => {
      connecting = false
      connected = false
      onStatus?.('closed')
      scheduleReconnect(onEvent, onStatus, 'closed')
    }

    s.onmessage = (ev) => {
      lastConnectedAt = Date.now()   // 心跳/消息都算「活着」
      let data
      try {
        data = JSON.parse(ev.data)
      } catch {
        return
      }
      try {
        onEvent?.(data)
      } catch (err) {
        console.error('[onebot] handler error:', err)
      }
    }
  }

  function connect({ onEvent, onStatus }) {
    open(onEvent, onStatus)

    // 看门狗：长时间连不上就不要在坏状态里硬撑
    setInterval(() => {
      if (closed) return
      const stale = Date.now() - lastConnectedAt
      if (!connected && stale > WATCHDOG_MS) {
        console.error(`[onebot] watchdog: ${Math.round(stale / 1000)}s 未连上，主动退出让 systemd 重启`)
        process.exit(1)
      }
    }, 30_000).unref?.()

    // 半死连接检测：连接标记还在但心跳沉默，主动断掉重来
    setInterval(() => {
      if (closed || !connected) return
      // NapCat 的 WS 默认 30s 心跳；90s 没有任何消息视为假活
      if (Date.now() - lastConnectedAt > 90_000) {
        console.error('[onebot] 心跳沉默 90s，重建连接')
        try { socket?.close() } catch { /* ignore */ }
      }
    }, 30_000).unref?.()
  }

  async function call(action, payload) {
    const res = await fetch(`${http}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
    const json = await res.json().catch(() => null)
    if (!json || json.status !== 'ok' || json.retcode !== 0) {
      throw new Error(`onebot ${action} failed: ${JSON.stringify(json)}`)
    }
    return json.data
  }

  return {
    connect,
    call,
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { socket?.close() } catch { /* 已关闭 */ }
    },
  }
}

/** 把 OneBot 的 message 字段压成纯文本；图片/表情用占位符保留语义 */
export function extractText(message, rawMessage) {
  if (Array.isArray(message)) {
    const parts = []
    for (const seg of message) {
      if (!seg || typeof seg !== 'object') continue
      if (seg.type === 'text') parts.push(seg.data?.text ?? '')
      else if (seg.type === 'image') parts.push('[图片]')
      else if (seg.type === 'face') parts.push('[表情]')
      else if (seg.type === 'record') parts.push('[语音]')
      else if (seg.type === 'video') parts.push('[视频]')
      else if (seg.type === 'at') parts.push(`@${seg.data?.qq ?? ''}`)
    }
    return parts.join('').trim()
  }
  if (typeof message === 'string') return message.replace(/\[CQ:[^\]]+\]/g, '').trim()
  if (typeof rawMessage === 'string') return rawMessage.trim()
  return ''
}
