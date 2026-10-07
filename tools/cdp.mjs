/**
 * 真机探针 CLI —— 连**已经开着**的实例（不负责启动它）
 *
 * 来由：以前真机验证靠 tmp/ 里一堆一次性脚本（probe-1.js、verify-x.mjs…），
 * 每个都把 CDP 连接逻辑抄一遍，而且 tmp/ 被 gitignore —— 沉淀不下来，
 * 下一轮又从零写，于是「测试脚本自己的 bug 伪装成产品的问题」反复出现
 * （见 docs/improvement-checklist.md「测试脚本自身的可靠性」）。
 * 现在把它做成仓库内的一等工具：连接、语法预检、异常报错、退出清理都走
 * tools/shot/cdp.mjs 那一套 **唯一实现**。
 *
 * 用法：
 *   node tools/cdp.mjs --wait                          # 只看端口开没开、有哪些 target
 *   node tools/cdp.mjs --js="document.title"
 *   node tools/cdp.mjs --js-file=tmp/probe.js          # 长脚本走文件（避开命令行长度上限）
 *   node tools/cdp.mjs --label=登录态 --js="!!localStorage.getItem('x')"
 *   node tools/cdp.mjs --js=... --shot=shots/x.png     # 先跑脚本再截图
 *   node tools/cdp.mjs --reload                        # 整页重载（改完渲染层强制刷新）
 *
 * 端口：dev 实例默认 9222；打包版用 --remote-debugging-port 起，再 --port=<那个端口>。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { connect, findPageTarget, evaluate, makeCleanup } from './shot/cdp.mjs'

const arg = (name, fallback = '') =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

const PORT = Number(arg('port', '9222'))
const WAIT = process.argv.includes('--wait')
const RELOAD = process.argv.includes('--reload')
const SHOT = arg('shot')
const JS_FILE = arg('js-file')
const JS_INLINE = arg('js')
const LABEL = arg('label', '探针')

const log = (...parts) => console.error('[cdp]', ...parts)
const clean = makeCleanup()

const target = await findPageTarget(PORT, { timeoutMs: 8000 })
log('目标 →', target.url)
if (WAIT) process.exit(0)

const cdp = await connect(target.webSocketDebuggerUrl)
clean.add(() => cdp.ws.close())
log('已连接')

if (RELOAD) {
  await cdp.send('Page.enable')
  await cdp.send('Page.reload', { ignoreCache: true })
  await new Promise((resolve) => {
    const onMsg = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Page.loadEventFired') {
        cdp.ws.removeEventListener('message', onMsg)
        resolve()
      }
    }
    cdp.ws.addEventListener('message', onMsg)
    setTimeout(resolve, 20000)
  })
  log('重载完成')
  clean.run()
  process.exit(0)
}

const script = JS_FILE ? readFileSync(JS_FILE, 'utf8') : JS_INLINE
if (script) {
  /* 走 evaluate：语法错 / 页面异常都会明确报出来，不会伪装成产品的问题 */
  const value = await evaluate(cdp, script, { label: LABEL })
  console.log(typeof value === 'string' ? value : JSON.stringify(value))
}

if (SHOT) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(dirname(SHOT), { recursive: true })
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  log('截图 →', SHOT)
}

clean.run()
