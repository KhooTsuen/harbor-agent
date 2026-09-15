/**
 * CDP 小客户端（浏览器预览截图用）
 *
 * 从 shot.mjs 拆出来的（那边过 300 行了）。
 *
 * 为什么要自己写：`chrome --screenshot` 只能截初始状态，点不了按钮。
 * 走 DevTools Protocol 就能先执行一段 JS（切主题、开弹窗、点标签）再截图。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/* ── 1. 起 Chrome（headless + 远程调试）───────────────────── */

function launchChrome({ chromePath, port }) {
  const CHROME = chromePath
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`)
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + resolve(`.chrome-profile-${port}`),
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )
  return child
}

async function waitForDevtools(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error('DevTools 端口一直没就绪')
}

/* ── 2. 极简 CDP 客户端 ───────────────────────────────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else ok(msg.result)
      }
    })
  }

  send(method, params = {}) {
    this.id += 1
    const id = this.id
    return new Promise((ok, reject) => {
      this.pending.set(id, { resolve: ok, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 30_000)
    })
  }
}

async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((ok, err) => {
    ws.addEventListener('open', ok, { once: true })
    ws.addEventListener('error', () => err(new Error('WebSocket 连接失败')), { once: true })
  })
  return new Cdp(ws)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export { launchChrome, waitForDevtools, connect, sleep }
