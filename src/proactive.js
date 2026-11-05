/**
 * 主动性：让它在该说话的时候自己开口。
 *
 * 触发源不是硬编的定时器，而是 fish-mood 自己写进 state.json 的 `urges` ——
 * 情绪引擎本来就会产生「想分享 / 想找人 / 想修复」的冲动（带 until 过期时间），
 * 以前没人接住它。这个模块负责：读冲动 → 判断该不该发 → 组织一句「主动开口」的任务。
 */
import { readFileSync } from 'node:fs'

export function readMoodState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 取一条还没过期、还没说过的冲动（最新的优先）
 *  fish-mood 的 urges 有时是单个对象、有时是数组，两种都吃。 */
export function pickUrge(state, handled = [], now = Date.now()) {
  if (!state || !state.urges) return null
  const list = Array.isArray(state.urges) ? state.urges : [state.urges]
  const fresh = list
    .filter((u) => u && typeof u === 'object' && u.until > now && u.at && !handled.includes(u.at))
    .sort((a, b) => b.at - a.at)
  return fresh[0] || null
}

/** 现在该不该开口 */
export function canSpeak({ now, config, lastSentAt, sentToday }) {
  const p = config.proactive
  if (!p?.enabled) return { ok: false, why: 'proactive disabled' }

  const hour = new Date(now).getHours()
  const [start, end] = p.quietHours
  const quiet = start > end ? hour >= start || hour < end : hour >= start && hour < end
  if (quiet) return { ok: false, why: `quiet hours ${start}-${end}` }

  if (sentToday >= p.maxPerDay) return { ok: false, why: 'daily cap' }
  if (lastSentAt && now - lastSentAt < p.minGapMinutes * 60_000) return { ok: false, why: 'too soon' }
  return { ok: true }
}

/**
 * 交给模型的「主动开口」任务。
 *
 * 2026-11-05 调整（触发来源：真机截图）：上一版只说「你想主动找对方说一句话」，
 * 结果她开口第一句是「怎么突然跑来了」—— 把「我先找你」说成了「你来了」。
 * 现在明确：这是我主动发起的，用打招呼/问候的口吻，不要被动语态，不要追问。
 */
export function buildPrompt(urge, now) {
  const hm = new Date(now).toTimeString().slice(0, 5)
  return [
    '（这不是回复对方——对方没给你发消息。是你自己现在想找 ta。）',
    `现在是 ${hm}。你心里挂着一件事：${urge.text}。`,
    '像平时发微信那样主动打个招呼、问候一句，一到两句话，语气轻松。',
    '要求：',
    '- 用「我先找你」的口吻；别说「你来了」「怎么突然跑来了」这种把人当客人的话',
    '- 可以自然带一句你挂着的这件事，但别说教、别追问细节',
    '- 不问「在吗」，不解释这条指令',
  ].join('\n')
}
