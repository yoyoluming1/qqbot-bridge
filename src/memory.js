/**
 * 记忆候选的代笔层。
 *
 * 模型没有文件权限（bot profile 里工具全禁），所以它只能「说」要记什么，
 * 由桥接替它写进 whale-persona 的收件箱。写入的条目一律是 `proposed` ——
 * 真正生效还得人跑 `node scripts/memory.mjs confirm <序号>`，这是插件的硬闸门，桥接绕不过去也不该绕。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MARKER = /^%%\s*记住\s*%%\s*(.*)$/

/** 从回复里拆出记忆指令；返回 { text, memories } */
export function extractMemories(reply) {
  const memories = []
  const kept = []
  for (const line of String(reply).split('\n')) {
    const m = MARKER.exec(line.trim())
    if (m) {
      // 模型有时只回一个光秃秃的 %%记住%%（没内容），那行也要剥掉，否则会漏给用户
      const body = m[1].trim()
      if (body) memories.push(body)
    } else {
      kept.push(line)
    }
  }
  return { text: kept.join('\n').trim(), memories }
}

export function appendMemories(inboxPath, memories) {
  if (!memories.length) return 0
  mkdirSync(dirname(inboxPath), { recursive: true })
  const at = new Date().toISOString()
  let written = 0
  for (const text of memories) {
    if (!text) continue
    const row = { text, at, status: 'proposed' }
    try {
      appendFileSync(inboxPath, JSON.stringify(row) + '\n', 'utf8')
      written += 1
    } catch (err) {
      console.error('[memory] append failed:', err?.message || err)
    }
  }
  return written
}
