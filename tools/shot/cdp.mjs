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
import vm from 'node:vm'

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

/* ── 3. 可靠性三件套 ──────────────────────────────────────────
 * 来由：2026-10-03 那一夜，真机脚本连着三轮报的是**脚本自己的错**，每一次都要人肉分辨
 * 「这次是真的还是脚本又错了」（见 docs/improvement-checklist.md「测试脚本自身的可靠性」）。
 * 三个反复踩到的坑，在这里各钉一个 helper：
 *   ⓐ 模板字符串里的 `\n` 变成真换行 → 发到页面里报 `SyntaxError: missing /`，
 *      看起来像产品崩了。→ `evaluate` 发之前先用 `checkExpression` 编译一遍。
 *   ⓑ `(function(){ ... })` 漏了 `return` → 判据恒 undefined，测试「通过」但什么都没测。
 *      → 返回 undefined 时 `evaluate` 明确警告。
 *   ⓒ 假模型 server / 起的子进程忘了关 → node 一直不退出，脚本挂住。
 *      → `makeCleanup` 注册退出清理，一个 finally 管完。
 */

/** 端口找 page target（连**已经开着**的实例，不 spawn —— dev 或打包版都行） */
async function findPageTarget(port, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://'),
      )
      if (page) return page
      last = `端口开着，但没有页面 target（现有：${list.map((t) => t.type).join('、') || '无'}）`
    } catch (error) {
      last = `${error instanceof Error ? error.message : error}`
    }
    await sleep(400)
  }
  throw new Error(
    `等不到调试端口 ${port}：${last}\n` +
      '（dev 实例：先 npm run dev，默认 9222；打包版：带 --remote-debugging-port 启动。' +
      '不确定开没开就先跑 `node tools/cdp.mjs --port=' +
      port +
      ' --wait` 看一眼。）',
  )
}

/** 表达式在当前 Node 里编译一遍 —— 语法错就别发出去（ⓐ） */
function checkExpression(expression) {
  const text = String(expression ?? '')
  if (!text.trim()) return { ok: false, error: '表达式是空的' }
  try {
    new vm.Script(text, { filename: 'cdp-evaluate.js' })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 在页面里跑一段表达式，并**把「脚本自己的错」和「页面真的抛错」分开报**（ⓐⓑ）。
 * @param {{ send: Function }} cdp connect() 的产物
 * @param {string} expression 要执行的 JS
 * @param {{ label?: string, allowUndefined?: boolean }} [opts]
 *        label 出现在报错里（「我做了什么」）；allowUndefined=true 时不再对 undefined 示警
 */
async function evaluate(cdp, expression, { label = '脚本', allowUndefined = false } = {}) {
  const check = checkExpression(expression)
  if (!check.ok) {
    throw new Error(
      `${label}：表达式**语法就有错**，没发到页面 —— ${check.error}\n` +
        '（这一条以前会变成页面里的 SyntaxError，让人以为是产品崩了。先修脚本。）',
    )
  }
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result?.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知'
    throw new Error(`${label}：页面里抛了异常 —— ${String(detail).split('\n')[0]}`)
  }
  const value = result?.result?.value
  if (value === undefined && !allowUndefined) {
    console.warn(`[cdp] ⚠ ${label}：返回了 undefined —— 是不是漏了 return？（判据恒 undefined 是踩过的坑）`)
  }
  return value
}

/**
 * 退出清理：注册的子进程 / server 在进程结束时按**倒序**关掉（ⓒ）。
 * 用法：
 *   const clean = makeCleanup()
 *   const server = spawn(...); clean.add(() => server.kill())
 *   // 正常结束、抛错、Ctrl-C 都会走到 clean
 */
function makeCleanup() {
  const tasks = []
  let done = false
  const run = () => {
    if (done) return
    done = true
    for (const task of tasks.reverse()) {
      try {
        task()
      } catch {
        /* 清理失败不掩盖真正的错误 */
      }
    }
  }
  process.on('exit', run)
  process.once('SIGINT', () => {
    run()
    process.exit(130)
  })
  return { add: (fn) => tasks.push(fn), run }
}

export { launchChrome, waitForDevtools, connect, sleep, findPageTarget, checkExpression, evaluate, makeCleanup }
