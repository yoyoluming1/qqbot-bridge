/**
 * QQ ↔ DSH 桥接。
 *
 * 一条消息进来 → 找到/新建它对应的 DSH 会话 → 跑一轮 → 把回复发回去。
 * 另外有一个「主动性」定时器：心情引擎攒出「想找人说话」的冲动时，替它开口。
 * 目标：一个人设、一个号、认真聊天。没有工具面（bot profile 里已禁用）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient, extractText } from './onebot.js'
import { createSessionStore } from './sessions.js'
import { runTurn } from './dsh.js'
import { appendMemories, extractMemories } from './memory.js'
import { buildPrompt, canSpeak, pickUrge, readMoodState } from './proactive.js'
import { createGroupStore } from './groups.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const sessions = createSessionStore(join(ROOT, 'data', 'sessions.json'))
const groups = createGroupStore(join(ROOT, 'data', 'groups.json'))

const log = (...args) => console.log(new Date().toISOString(), ...args)

const selfIds = new Set()
const peerQueues = new Map()
const rateWindow = new Map()

/* ── 主动性状态：哪些冲动说过了、上次开口是什么时候 ───────────────── */
const proactiveFile = join(ROOT, 'data', 'proactive.json')
let proactiveState = { handled: [], lastSentAt: {}, sentByDay: {} }
try {
  proactiveState = { ...proactiveState, ...JSON.parse(readFileSync(proactiveFile, 'utf8')) }
} catch {
  /* 第一次跑：用默认值 */
}

function saveProactiveState() {
  mkdirSync(dirname(proactiveFile), { recursive: true })
  const tmp = `${proactiveFile}.tmp`
  writeFileSync(tmp, JSON.stringify(proactiveState, null, 2) + '\n', 'utf8')
  renameSync(tmp, proactiveFile)
}

const onebot = createClient({
  ws: config.napcat.ws,
  http: config.napcat.http,
  token: config.napcat.token,
})

function peerKeyOf(event) {
  return event.message_type === 'group' ? `group:${event.group_id}` : `private:${event.user_id}`
}

function allowed(event) {
  const policy = config.policy
  if (event.message_type === 'private') return policy.allowUsers.includes(event.user_id)
  if (event.message_type === 'group') {
    if (!policy.allowGroups.includes(event.group_id)) return false
    if (!policy.groupRequireAt) return true
    if (Array.isArray(event.message)) {
      return event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event.self_id))
    }
    return String(event.raw_message || '').includes(`@${event.self_id}`)
  }
  return false
}

function rateLimited(key) {
  const max = config.policy.maxPerPeerPerMinute
  const now = Date.now()
  const hits = (rateWindow.get(key) || []).filter((t) => now - t < 60_000)
  if (hits.length >= max) {
    rateWindow.set(key, hits)
    return true
  }
  hits.push(now)
  rateWindow.set(key, hits)
  return false
}

/** 同一 peer 串行跑，避免两轮抢同一个 session */
function enqueue(key, task) {
  const prev = peerQueues.get(key) || Promise.resolve()
  const next = prev
    .then(task)
    .catch((err) => log('[queue] task failed', key, err))
    .finally(() => {
      if (peerQueues.get(key) === next) peerQueues.delete(key)
    })
  peerQueues.set(key, next)
  return next
}

function splitReply(text) {
  const max = config.policy.maxReplyChars
  if (text.length <= max) return [text]
  const chunks = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

async function send(event, text) {
  const chunks = splitReply(text)
  for (const chunk of chunks) {
    if (event.message_type === 'group') {
      await onebot.call('send_group_msg', { group_id: event.group_id, message: chunk })
    } else {
      await onebot.call('send_private_msg', { user_id: event.user_id, message: chunk })
    }
  }
}

/** 跑一轮并把结果发出去（主动 / 被动共用） */
async function speak(peer, taskText, { sessionId, proactive = false } = {}) {
  const started = Date.now()
  const result = await runTurn({
    profile: config.dsh.profile,
    cwd: config.dsh.cwd,
    sessionId,
    text: taskText,
    timeoutMs: config.dsh.timeoutMs,
    env: config.dsh.env,
  })

  if (!result.ok) {
    log('[fail]', peer.key, result.error, (result.stderr || '').slice(0, 300))
    if (!proactive) await send(peer.event, '唔……我这边卡了一下，等我缓过来再跟我说一遍好不好？').catch(() => {})
    return null
  }

  sessions.set(peer.key, result.sessionId)

  const { text: reply, memories } = extractMemories(result.text)
  if (memories.length) {
    const n = appendMemories(config.memory.inboxPath, memories)
    log('[mem]', peer.key, `候选 ${n} 条，等人确认`, JSON.stringify(memories).slice(0, 120))
  }
  log(proactive ? '[proactive-out]' : '[out]', peer.key, `${Date.now() - started}ms`, JSON.stringify(reply).slice(0, 120))
  if (reply) await send(peer.event, reply).catch((err) => log('[send] failed', peer.key, err))
  return reply
}

function mentionsBot(event) {
  if (Array.isArray(event.message)) {
    return event.message.some((s) => s?.type === 'at' && String(s.data?.qq) === String(event.self_id))
  }
  return String(event.raw_message || '').includes(`@${event.self_id}`)
}

async function handleMessage(event) {
  if (selfIds.has(event.user_id)) return

  // 群：静态白名单 ∪ 自动登记。autoJoinGroups 打开时，任何群第一次 @ 它即入册（重启不丢）
  if (event.message_type === 'group' && !config.policy.allowGroups.includes(event.group_id)) {
    if (!config.policy.autoJoinGroups || !mentionsBot(event)) {
      log('[skip] not allowed', peerKeyOf(event), event.user_id)
      return
    }
    if (groups.register(event.group_id, { via: 'auto' })) {
      log('[groups] 自动登记群', event.group_id, '（第一次被 @）')
    }
  } else if (!allowed(event)) {
    log('[skip] not allowed', peerKeyOf(event), event.user_id)
    return
  }

  // 每群每日上限，防止被拉进热闹群后刷屏
  if (event.message_type === 'group' && !groups.allowDaily(event.group_id, config.policy.maxGroupRepliesPerDay)) {
    log('[skip] group daily cap', event.group_id)
    return
  }

  let text = extractText(event.message, event.raw_message)
  // 群里 @ 它的那段会变成 "@1903415582"，别喂给模型
  if (event.message_type === 'group') {
    text = text.replace(/@\d+/g, ' ').replace(/\s+/g, ' ').trim()
    // 群聊里必须标明是谁说的：否则多个人混成一个「你」，它会张冠李戴
    const who = event.sender?.card || event.sender?.nickname || String(event.user_id)
    text = `[${who}] ${text}`
  }
  if (text.length < config.policy.minReplyChars) return
  if (/^\[(图片|表情|语音|视频)\]$/.test(text)) return

  const key = peerKeyOf(event)
  if (rateLimited(key)) {
    log('[skip] rate limited', key)
    return
  }

  log('[in]', key, JSON.stringify(text).slice(0, 120))
  await enqueue(key, () => speak({ key, event }, text, { sessionId: sessions.get(key) }))
}

/** 主动开口：心情引擎有冲动 → 看时辰/配额 → 说一句 */
export async function tick(now = Date.now()) {
  const state = readMoodState(config.memory.moodStatePath)
  const urge = pickUrge(state, proactiveState.handled, now)
  if (!urge) return { spoke: false, why: 'no fresh urge' }

  const day = new Date(now).toISOString().slice(0, 10)
  proactiveState.sentByDay[day] = proactiveState.sentByDay[day] || 0

  const peers = config.policy.allowUsers
  const lastSentAt = Math.max(0, ...peers.map((u) => proactiveState.lastSentAt[`private:${u}`] || 0))
  const verdict = canSpeak({ now, config, lastSentAt, sentToday: proactiveState.sentByDay[day] })
  if (!verdict.ok) {
    log('[proactive] 忍住', verdict.why, '·', urge.text)
    return { spoke: false, why: verdict.why, urge }
  }

  for (const uin of peers) {
    const key = `private:${uin}`
    const event = { message_type: 'private', user_id: uin }
    await enqueue(key, async () => {
      const reply = await speak({ key, event }, buildPrompt(urge, now), {
        sessionId: sessions.get(key),
        proactive: true,
      })
      if (!reply) return
      proactiveState.handled = [...proactiveState.handled, urge.at].slice(-50)
      proactiveState.lastSentAt[key] = now
      proactiveState.sentByDay[day] += 1
      saveProactiveState()
      log('[proactive] 开口了 ·', JSON.stringify(urge.text).slice(0, 80))
    })
  }
  return { spoke: true, urge }
}

/* ── 启动 ────────────────────────────────────────────────────────── */
if (process.argv.includes('--tick')) {
  tick().then((r) => {
    log('[tick]', JSON.stringify({ spoke: r.spoke, why: r.why ?? '', urge: r.urge?.text ?? '' }))
    process.exit(0)
  })
} else {
  onebot.connect({
    onStatus: (status) => log('[ws]', status),
    onEvent: (event) => {
      if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') {
        selfIds.add(event.self_id)
        log('[ws] bot uin', event.self_id)
        return
      }
      if (event.post_type === 'message') {
        handleMessage(event).catch((err) => log('[handle] failed', err))
      }
    },
  })

  if (config.proactive?.enabled) {
    const every = (config.proactive.checkEveryMinutes || 10) * 60_000
    log('[proactive] 已启用，每', config.proactive.checkEveryMinutes, '分钟看一次冲动')
    setInterval(() => tick().catch((err) => log('[proactive] tick failed', err)), every)
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('[exit]', signal)
      onebot.close()
      process.exit(0)
    })
  }
}
