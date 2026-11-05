/**
 * peer → DSH 会话映射。
 *
 * 一个 QQ 私聊 / 一个群 = 一个 DSH session。这张表是整个机器人「记得刚才聊过什么」的唯一来源，
 * 丢了就等于失忆，所以要原子写（先写临时文件再 rename）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function createSessionStore(file) {
  mkdirSync(dirname(file), { recursive: true })

  let map = {}
  try {
    map = JSON.parse(readFileSync(file, 'utf8'))
    if (!map || typeof map !== 'object' || Array.isArray(map)) map = {}
  } catch {
    map = {}
  }

  function save() {
    const tmp = join(dirname(file), `.${Date.now()}.tmp`)
    writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  }

  return {
    get(peerKey) {
      return map[peerKey]?.sessionId ?? ''
    },
    set(peerKey, sessionId) {
      if (!sessionId) return
      if (map[peerKey]?.sessionId === sessionId) {
        map[peerKey].lastActive = Date.now()
        return
      }
      map[peerKey] = { sessionId, lastActive: Date.now() }
      save()
    },
    touch(peerKey) {
      if (map[peerKey]) map[peerKey].lastActive = Date.now()
    },
    all() {
      return map
    },
  }
}
