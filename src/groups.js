/**
 * 群白名单的「自动登记」。
 *
 * 静态白名单写在 config.json 里（需要人拍板的那些群）；动态登记写在这份文件里 ——
 * 任何群第一次 @ 它，自动入册并持久化，重启不丢。
 * 目的：加一个新群不用再改配置、重启服务。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function createGroupStore(file) {
  mkdirSync(dirname(file), { recursive: true })

  let state = { groups: {}, daily: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object') state = { groups: raw.groups || {}, daily: raw.daily || {} }
  } catch {
    /* 第一次跑 */
  }

  function save() {
    const tmp = join(dirname(file), `.groups-${Date.now()}.tmp`)
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  }

  const today = () => new Date().toISOString().slice(0, 10)

  return {
    has(id) {
      return Boolean(state.groups[String(id)])
    },
    /** 自动入册；返回 true 表示这次是新登记的 */
    register(id, meta = {}) {
      const key = String(id)
      if (state.groups[key]) return false
      state.groups[key] = { addedAt: Date.now(), ...meta }
      save()
      return true
    },
    /** 该群今天还能不能说话 */
    allowDaily(id, max) {
      if (!max) return true
      const day = today()
      const k = String(id)
      const row = state.daily[k]
      const count = row && row.day === day ? row.count : 0
      if (count >= max) return false
      state.daily[k] = { day, count: count + 1 }
      save()
      return true
    },
    all() {
      return state.groups
    },
  }
}
