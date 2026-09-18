/**
 * 给**桌面版**截图
 *
 * tools/shot.mjs 截的是浏览器预览（跑 vite preview + 起 Chrome）。
 * 但有些东西只有真 Electron 里才有 —— 真终端（PTY）、托盘、原生对话框、
 * 内嵌 webview。那些用浏览器预览截图验证不了，会一直是「没验证过」。
 *
 * 这个脚本的做法：带 --remote-debugging-port 启动便携版 exe，
 * 用 CDP 连上去执行一段 JS（切标签、点点按钮），再截图。
 *
 * 用法：
 *   node tools/shot-electron.mjs                       # 默认截「终端」标签
 *   node tools/shot-electron.mjs --out=shots/electron
 *   node tools/shot-electron.mjs --js="document.title"
 *   node tools/shot-electron.mjs --js-file=tmp/probe.js   # 长脚本（避开命令行长度上限）
 *   node tools/shot-electron.mjs --keep                # 截完不退出（手动接着看）
 *   node tools/shot-electron.mjs --type="echo hi"      # 往终端里真的敲一串字再截图
 *
 * --type 是验证「键盘 → PTY → 回显」这条回路用的：走 CDP 的
 * Input.dispatchKeyEvent（真键盘事件），不是直接改 DOM。
 *
 * 前置：先 npm run package（要有 dist-portable/PersonalAgent/PersonalAgent.exe）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
/*
 * 用哪个便携版。默认 dist-portable/PersonalAgent —— 破坏性测试时要指向
 * 隔离副本（test-env/），否则改的是副本、测的是真身，白测。
 * 也能用环境变量 PA_EXE（脚本里拼路径时比命令行方便）。
 */
const EXE = resolve(
  process.env.PA_EXE ??
    process.argv.find((a) => a.startsWith('--exe='))?.slice(6) ??
    resolve(ROOT, 'dist-portable', 'PersonalAgent', 'PersonalAgent.exe'),
)
const OUT_DIR = resolve(
  process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'shots/electron',
)
const PORT = Number(process.env.CDP_PORT ?? 9336)
const KEEP = process.argv.includes('--keep')

/** 截图前执行的 JS。默认切到「终端」标签，等 shell 打出提示符 */
const DEFAULT_SCRIPT = `
  (function () {
    const tabs = [...document.querySelectorAll('button')]
    const tab = tabs.find((b) => b.getAttribute('aria-label') === '终端' || b.title === '终端' || b.textContent.trim() === '终端')
    if (tab) tab.click()
    return tab ? 'clicked' : 'tab not found'
  })()
`
/* 长脚本走 --js-file=：--js= 直接写在命令行里会撞上 Windows 参数长度上限
   （写长一点就整个字符串被截断，症状是「脚本没执行」而不是报错） */
const JS_FILE = process.argv.find((a) => a.startsWith('--js-file='))?.slice(10) ?? ''
const SCRIPT =
  process.argv.find((a) => a.startsWith('--js='))?.slice(5) ??
  (JS_FILE ? readFileSync(JS_FILE, 'utf8') : null) ??
  (process.argv.find((a) => a.startsWith('--connect')) ? '' : DEFAULT_SCRIPT)

/** 要往终端里敲的内容（不含回车，回车另外发） */
const TYPE = process.argv.find((a) => a.startsWith('--type='))?.slice(7) ?? ''
/*
 * --tabs=通用,外观,对话
 *
 * 一次启动把设置里每个标签各拍一张。为什么加：逐个标签开一次应用
 * 要半分钟，还要人守着 —— 而「检查所有标签的布局」本来就该是脚本干的活。
 * 名字必须和左侧导航上显示的一模一样。
 */
const TABS = (process.argv.find((a) => a.startsWith('--tabs='))?.slice(7) ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)

if (!existsSync(EXE)) {
  console.error(`找不到便携版：${EXE}\n先跑 npm run package`)
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

/* ── CDP 小客户端（和 shot.mjs 同一套写法）────────────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)))
      else slot.resolve(msg.result)
    })
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等 Electron 把调试端口开起来，并找到一个 page 类型的 target */
async function findTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error('等不到调试端口（Electron 起来了吗？）')
}

/* ── 主流程 ─────────────────────────────────────────────── */

const app = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
  cwd: dirname(EXE),
  stdio: 'ignore',
  detached: false,
})

let cdp
try {
  const target = await findTarget()
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  /* 等界面渲染完（要等 localStorage 里的会话读出来） */
  await sleep(2500)

  if (SCRIPT) {
    const result = await cdp.send('Runtime.evaluate', { expression: SCRIPT, awaitPromise: true })
    console.log('执行脚本 →', result.result?.value ?? '(无返回值)')
  }

  /* 终端要等 shell 起来并打出提示符 */
  await sleep(2200)

  if (TYPE) {
    /* 先把焦点点进终端 */
    await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(function () {
        const host = document.querySelector('.xterm-helper-textarea') || document.querySelector('.xterm')
        if (host) host.focus()
        return document.activeElement?.className ?? 'none'
      })()`,
    })

    /*
     * `;;` 分段，每段敲完回车。
     * 分段之间要等 —— 开 python REPL 那种程序要好几百毫秒才出提示符，
     * 不等的话后一行会被当成前一行的续行。
     */
    for (const segment of TYPE.split(';;')) {
      for (const ch of segment) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
        await sleep(25)
      }
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        text: '\r',
        windowsVirtualKeyCode: 13,
      })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        windowsVirtualKeyCode: 13,
      })
      console.log(`已敲入：${segment}`)
      await sleep(1400)
    }
  }

  /*
   * --tabs 模式：打开设置，逐个标签点一遍各拍一张。
   * 拍完就返回，不再走下面那套「终端调试」的输出。
   */
  if (TABS.length > 0) {
    const openSettings = `(function () {
      var b = [...document.querySelectorAll('button')].find(function (x) {
        return /设置/.test(x.getAttribute('aria-label') || '')
      })
      if (b) b.click()
      return !!b
    })()`
    await cdp.send('Runtime.evaluate', { expression: openSettings, returnByValue: true })
    await sleep(1500)

    for (const tabName of TABS) {
      const clicked = await cdp.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(function () {
          var t = [...document.querySelectorAll('nav button')].find(function (x) {
            return (x.textContent || '').trim() === ${JSON.stringify(tabName)}
          })
          if (!t) return 'missing'
          t.click()
          var body = document.querySelector('.settings-body')
          if (body) body.scrollTop = 0
          return 'ok'
        })()`,
      })
      await sleep(1200)

      const one = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const out = resolve(OUT_DIR, `tab-${tabName}.png`)
      writeFileSync(out, Buffer.from(one.data, 'base64'))
      console.log(`截图 → tab-${tabName}.png（${clicked?.result?.value ?? '?'}）`)
    }
    app.kill()
    process.exit(0)
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = resolve(OUT_DIR, 'electron-终端.png')
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log(`截图 → ${file}`)

  /* 顺手报一下页面里的关键状态，比人眼看图更可靠 */
  const probe = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      title: document.title,
      xtermCount: document.querySelectorAll('.xterm').length,
      xtermRows: document.querySelectorAll('.xterm-rows > div').length,
      firstLines: [...document.querySelectorAll('.xterm-rows > div')].slice(0, 3)
        .map(d => d.textContent.trim()).filter(Boolean),
    })`,
  })
  if (probe.result?.value) {
    console.log('页面探针 →', probe.result.value)
  } else {
    console.log('页面探针 → (取不到)', JSON.stringify(probe).slice(0, 200))
  }
} catch (error) {
  console.error('失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  if (!KEEP) {
    try {
      cdp?.ws.close()
    } catch {
      /* 忽略 */
    }
    app.kill()
  }
}
