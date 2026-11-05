/**
 * 驱动 DSH：一次调用 = 一轮对话。
 *
 * 用 `dsh --profile <p> --json [--session-id <id>] "<消息>"`，解析 NDJSON：
 *   {"type":"session","sessionId":...}  首行，拿到会话身份
 *   {"type":"final","text":...}         末行，模型的最终答复
 * 每轮一个子进程（约 3–5 秒），换来的是零常驻状态、崩了也不影响下一轮。
 */
import { spawn } from 'node:child_process'

export function runTurn({ profile, cwd, sessionId, text, timeoutMs, env }) {
  return new Promise((resolve) => {
    const args = ['--profile', profile, '--json']
    if (sessionId) args.push('--session-id', sessionId)
    args.push(text)

    const child = spawn('dsh', args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ ok: false, error: 'timeout', stderr: err })
    }, timeoutMs)

    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: String(e?.message || e), stderr: err })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      let session = sessionId || ''
      let final = ''
      let lastError = ''
      for (const line of out.split('\n')) {
        const s = line.trim()
        if (!s) continue
        let ev
        try {
          ev = JSON.parse(s)
        } catch {
          continue
        }
        if (ev.type === 'session' && ev.sessionId) session = ev.sessionId
        else if (ev.type === 'final' && typeof ev.text === 'string') final = ev.text
        else if (ev.type === 'error') lastError = ev.message || JSON.stringify(ev)
      }

      if (code !== 0 || !final) {
        resolve({ ok: false, error: lastError || `exit ${code}`, stderr: err, sessionId: session })
        return
      }
      resolve({ ok: true, text: final.trim(), sessionId: session })
    })
  })
}
