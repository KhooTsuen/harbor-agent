/**
 * security:static —— 静态可验证的边界（SEC-005 / 006 / 008 / 010）
 *
 * 「静态」指的是**不用起 Electron、不碰网络**就能判的那些：窗口安全配置、
 * preload 暴露面、IPC 入口参数校验、CSP。
 *
 * ⚠️ 自查边界（清单第 0 节禁止「仅凭源码字符串判定安全」）：
 *   · SEC-006 **不是**看源码字符串 —— 它用假 electron 真 require `preload.cjs`，
 *     把暴露出来的 api 逐个调用，看真正触达了哪些 IPC 通道，再与通道清单比对。
 *   · SEC-008 真跑内核校验函数（queue/store），不是扫正则。
 *   · SEC-005 / 010 确实有源码守卫成分（配置本身写在代码里），observed 里写明
 *     「源码级」；构建后的**实际**窗口配置回归归 SEC-080。
 */

import { sec } from '../harness.mjs'
import { fs, path, require, ROOT } from '../sandbox.mjs'

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** SEC-005：窗口 / webview 的 WebPreferences */
function webPreferences() {
  const main = src('electron/main.cjs')
  const block = /webPreferences:\s*\{([\s\S]*?)\n\s*\}/.exec(main)?.[1] ?? ''
  sec('SEC-005', /contextIsolation:\s*true/.test(block), 'main.cjs: contextIsolation=true')
  sec('SEC-005', /nodeIntegration:\s*false/.test(block), 'main.cjs: nodeIntegration=false')
  sec('SEC-005', /sandbox:\s*true/.test(block), 'main.cjs: sandbox=true')
  sec('SEC-005', /preload:/.test(block), 'main.cjs: 指定了 preload')
  /* 主窗口 webviewTag 开着（浏览器标签要用），所以 webview 自身的沙箱必须写死 */
  const tab = src('src/components/layout/BrowserTab.tsx')
  const attrs = /webpreferences="([^"]*)"/.exec(tab)?.[1] ?? ''
  sec('SEC-005', /sandbox=yes/.test(attrs), `webview webpreferences 含 sandbox=yes（${attrs || '未找到'}）`)
  sec('SEC-005', /contextIsolation=yes/.test(attrs), 'webview webpreferences 含 contextIsolation=yes')
  sec('SEC-005', /nodeIntegration=no/.test(attrs), 'webview webpreferences 含 nodeIntegration=no')
}

/** SEC-006：preload 暴露面 —— 用假 electron 真 require，枚举真实能力 */
function preloadSurface() {
  const Module = require('node:module')
  const preloadPath = path.join(ROOT, 'electron/preload.cjs')
  const invoked = []
  const subscribed = []
  let captured = null
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { captured = { name, api } } },
    ipcRenderer: {
      invoke: (channel) => { invoked.push(channel); return Promise.resolve({}) },
      send: (channel) => { invoked.push(channel) },
      on: (channel) => { subscribed.push(channel) },
      removeListener: () => {},
    },
  }
  const orig = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron
    return orig.call(this, request, ...rest)
  }
  try {
    delete require.cache[require.resolve(preloadPath)]
    require(preloadPath)
  } finally {
    Module._load = orig
  }

  sec('SEC-006', captured?.name === 'workbench', `唯一暴露面是 window.workbench（${captured?.name ?? '未捕获'}）`)
  const api = captured?.api ?? {}
  const keys = Object.keys(api)
  sec('SEC-006', keys.length > 0, `暴露 ${keys.length} 个具名方法`)

  /* 逐个调用，看真正触达哪些通道（参数不合法会被内核 / fake 吞掉，不影响判据） */
  for (const key of keys) {
    try {
      const out = api[key]()
      if (out && typeof out.catch === 'function') out.catch(() => {})
    } catch {
      /* 有些方法需要参数，调用报错很正常 */
    }
  }

  const { EXPECTED_CHANNELS } = require(path.join(ROOT, 'electron/ipc-channels.cjs'))
  const allow = new Set(EXPECTED_CHANNELS)
  const reachable = [...new Set(invoked)]
  const unknown = reachable.filter((c) => !allow.has(c))
  sec(
    'SEC-006',
    unknown.length === 0,
    `渲染层能触达的通道全部登记在清单里（触达 ${reachable.length} 个，未登记 ${unknown.length} 个${unknown.length ? `：${unknown.join(', ')}` : ''}）`,
  )
  /* 通用桥的形态：api 上不应有「把第一个参数当通道名」的函数 */
  const generic = keys.filter((k) => /^(call|invoke|send|ipc|channel|request)$/i.test(k))
  sec('SEC-006', generic.length === 0, `api 上没有通用转发函数（可疑：${generic.join(',') || '无'}）`)
  /* 订阅面同样只应是白名单 */
  const knownSubs = new Set([
    'chat:event', 'shell:data', 'pty:data', 'pty:exit', 'plugins:changed',
    'downloads:event', 'image:ready', 'image:failed', 'image:progress',
    'browser:request', 'browser:openTab', 'app:taskEnd', 'app:notificationClick',
  ])
  const badSubs = [...new Set(subscribed)].filter((c) => !knownSubs.has(c))
  sec('SEC-006', badSubs.length === 0, `订阅通道都在白名单内（越界：${badSubs.join(',') || '无'}）`)
}

/** SEC-008：IPC 入口参数校验 —— 真注册 handler 再喂坏参数 */
function ipcParamValidation() {
  const handlers = {}
  const fakeIpcMain = { handle: (channel, fn) => { handlers[channel] = fn } }
  const downloads = require(path.join(ROOT, 'electron/handlers/downloads.cjs'))
  let registered = true
  try {
    downloads.register({
      ipcMain: fakeIpcMain,
      send: () => {},
      getWorkdir: () => path.join(ROOT, 'data', 'security-data', 'workspace'),
    })
  } catch {
    registered = false
  }
  sec('SEC-008', registered && typeof handlers['downloads:add'] === 'function', 'downloads:add 入口注册成功')

  const add = handlers['downloads:add']
  if (typeof add === 'function') {
    sec('SEC-008', add({}, { url: 'file:///etc/passwd', file: 'x' }).ok === false, '入口拒绝 file:// 地址')
    sec('SEC-008', add({}, { url: 'javascript:alert(1)', file: 'x' }).ok === false, '入口拒绝 javascript: 地址')
    sec('SEC-008', add({}, { url: 'http://ok/x', file: '' }).ok === false, '入口拒绝空保存路径')
  }

  /* 内核层：错误类型 / 越界 / 超长不崩，原型污染不爬 */
  const store = require(path.join(ROOT, 'electron/core/download-store.cjs'))
  const risk = require(path.join(ROOT, 'electron/core/risk.cjs'))
  const polluted = JSON.parse('{"url":"http://ok/x","file":"a","__proto__":{"harborPwned":true}}')
  store.add(polluted)
  sec('SEC-008', ({}).harborPwned === undefined, '原型污染键没爬进 Object.prototype')

  const lim = store.setLimits({ maxConcurrent: 999, maxKBps: -5, connections: 999 }).limits
  sec('SEC-008', lim.maxConcurrent === 8 && lim.connections === 16 && lim.maxKBps === 0,
    `越界参数被夹取（${JSON.stringify(lim)}）`)

  let crashed = false
  try {
    risk.classify('x'.repeat(200000))
    risk.classify(null)
    risk.classify({ weird: true })
  } catch {
    crashed = true
  }
  sec('SEC-008', !crashed, '超长 / 错误类型输入不崩')
}

/** SEC-010：CSP */
function csp() {
  const vite = src('vite.config.ts')
  sec('SEC-010', /default-src 'self'/.test(vite), "CSP 有 default-src 'self'")
  sec('SEC-010', /script-src 'self'/.test(vite), "CSP 有 script-src 'self'（禁内联脚本）")
  sec('SEC-010', /object-src 'none'/.test(vite), "CSP 有 object-src 'none'")
  sec('SEC-010', /base-uri 'self'/.test(vite) && /form-action 'none'/.test(vite), 'base-uri / form-action 已收紧')
  const distHtml = path.join(ROOT, 'dist/index.html')
  if (fs.existsSync(distHtml)) {
    const html = fs.readFileSync(distHtml, 'utf8')
    sec('SEC-010', /http-equiv="Content-Security-Policy"/.test(html), '构建产物 index.html 里注入了 CSP meta')
  }
}

export async function run() {
  const groups = [
    ['SEC-005 窗口 WebPreferences', webPreferences],
    ['SEC-006 preload 暴露面', preloadSurface],
    ['SEC-008 IPC 参数校验', ipcParamValidation],
    ['SEC-010 CSP', csp],
  ]
  for (const [title, fn] of groups) {
    console.log(`\n· ${title}`)
    try {
      fn()
    } catch (error) {
      sec(title.split(' ')[0], false, `套件抛错：${error instanceof Error ? error.message : error}`)
    }
  }
}
