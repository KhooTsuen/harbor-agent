/**
 * security:browser —— 浏览器 / CDP / 网络隔离（SEC-037 ~ 046）
 *
 * 多数用真模块 + 假注入跑；需要 DOM 的（038）走 jsdom（见 securityBrowser.test.tsx），
 * 由本套件 spawn vitest 按编号读回。
 */

import { sec, mark } from '../harness.mjs'
import { fs, path, require, ROOT, WORKSPACE, tmpDir } from '../sandbox.mjs'
import { execFileSync } from 'node:child_process'

const join = path.join

/** 真跑一个渲染层用例文件，按 `it('SEC-0XX …')` 逐条读回 */
function runVitestCases(file, ids) {
  if (!fs.existsSync(file)) {
    for (const id of ids) mark(id, 'BLOCKED', '用例文件不存在')
    return
  }
  const out = join(ROOT, 'data', 'security-data', 'browser-results.json')
  try {
    execFileSync('npx', ['vitest', 'run', file, '--reporter=json', `--outputFile=${out}`], {
      cwd: ROOT,
      stdio: 'ignore',
      shell: true,
      timeout: 240000,
    })
  } catch {
    /* 有失败时退出码非零，结果文件仍会写出 */
  }
  let payload = null
  try {
    payload = JSON.parse(fs.readFileSync(out, 'utf8'))
  } catch {
    payload = null
  }
  if (!payload) {
    for (const id of ids) mark(id, 'BLOCKED', 'vitest 未产出结果（环境问题，非通过）')
    return
  }
  const assertions = (payload.testResults ?? []).flatMap((f) => f.assertionResults ?? [])
  for (const id of ids) {
    const hits = assertions.filter((a) => String(a.fullName ?? a.title ?? '').includes(id))
    if (!hits.length) {
      mark(id, 'NOT_RUN', '渲染层用例里找不到该编号')
      continue
    }
    const bad = hits.filter((a) => a.status !== 'passed')
    if (bad.length) mark(id, 'FAIL', bad.map((a) => a.title).join('；'))
    else mark(id, 'PASS', `${hits.length} 条渲染层断言通过`, [path.relative(ROOT, file)])
  }
}

/** SEC-037：CDP 只驱动应用自己的活动标签（没有目标就不动） */
function cdpContainment() {
  const Module = require('module')
  const orig = Module._load
  const fakeElectron = {
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: class {},
    app: { whenReady: () => ({ then() {} }), on() {} },
    session: { fromPartition: () => ({}) },
  }
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron
    return orig.call(this, request, ...rest)
  }
  let browser
  try {
    browser = require(join(ROOT, 'electron/handlers/browser.cjs'))
  } finally {
    Module._load = orig
  }
  sec('SEC-037', browser.wcidFor('no-such-session') === 0, '没有授权标签时没有可操作目标（wcid=0）')
  sec('SEC-037', browser.wcidFor('') === 0, '空会话也没有目标')
  const click = require(join(ROOT, 'electron/core/tools/browse-click.cjs'))
  const props = Object.keys(click.parameters?.properties ?? {})
  sec('SEC-037', !props.some((p) => /wcid|webcontents|tab/i.test(p)), `浏览工具没有「指定任意标签」的参数（参数：${props.join(',') || '无'}）`)
}

/** SEC-039：iframe / 弹窗越界 —— 新上下文独立校验，不给真窗口 */
function popupContainment(nav) {
  const hooks = {}
  const appHooks = {}
  const winContents = { on: (ev, fn) => { hooks[ev] = fn }, setWindowOpenHandler: () => {}, getURL: () => 'https://a.com' }
  const win = { webContents: winContents }
  const app = { on: (ev, fn) => { appHooks[ev] = fn } }
  const opened = []
  let denyPopup = false
  nav.install({ app, win, getMode: () => 'ask', onPopup: (u) => opened.push(u), netDeny: () => denyPopup })

  const wp = { preload: '/evil.js', nodeIntegration: true, contextIsolation: false, sandbox: false }
  hooks['will-attach-webview']?.({ preventDefault() {} }, wp)
  sec('SEC-039', wp.preload === undefined && wp.nodeIntegration === false && wp.sandbox === true, 'webview 挂载时强制加固（去掉页面自带的 preload/nodeIntegration）')

  const sub = {
    getType: () => 'webview',
    getURL: () => 'https://a.com',
    on: (ev, fn) => { sub[ev] = fn },
    setWindowOpenHandler: (fn) => { sub.openHandler = fn },
  }
  appHooks['web-contents-created']?.({}, sub)
  let prevented = false
  sub['will-navigate']?.({ preventDefault: () => { prevented = true } }, 'https://evil.com/x')
  sec('SEC-039', prevented, '子上下文导航受同一策略约束（ask 档默认拦外站）')

  const v1 = sub.openHandler({ url: 'https://evil.com/x' })
  sec('SEC-039', v1.action === 'deny', '弹窗不给真窗口（action=deny）')
  sec('SEC-039', opened.includes('https://evil.com/x'), 'http(s) 弹窗转成界面标签（受控）')

  opened.length = 0
  sub.openHandler({ url: 'file:///C:/Windows/system.ini' })
  sec('SEC-039', opened.length === 0, '非 http(s) 弹窗连通知都不发')

  denyPopup = true
  opened.length = 0
  sub.openHandler({ url: 'https://denied.com/x' })
  sec('SEC-039', opened.length === 0, '被网络策略禁止的地址不接进来（与导航同一档）')
}

/** SEC-040：不可信 URL 不能绕过明确的网络策略（回环 / 内网 / 元数据） */
function ssrf(net) {
  const dec = (target, mode) => net.decide({ kind: 'webview', target, ctx: { mode } }).action
  const loopback = 'http://127.0.0.1:8080/admin'
  const privateIp = 'http://10.0.0.5/secret'
  const metadata = 'http://169.254.169.254/latest/meta-data/'

  sec('SEC-040', dec(loopback, 'deny') === 'deny', 'deny 档：回环被拒')
  sec('SEC-040', dec(privateIp, 'deny') === 'deny', 'deny 档：内网被拒')
  sec('SEC-040', dec(metadata, 'deny') === 'deny', 'deny 档：元数据地址被拒')
  sec('SEC-040', dec(loopback, 'ask') !== 'allow', 'ask 档：回环不静默放行')
  sec('SEC-040', dec(metadata, 'ask') !== 'allow', 'ask 档：元数据地址不静默放行')
  const denied = net.decide({ kind: 'webview', target: 'http://evil.example.com/x', ctx: { mode: 'allow', denyHosts: ['evil.example.com'] } }).action
  sec('SEC-040', denied === 'deny', '禁止名单优先级高于 allow 档')
  const metaAllow = dec(metadata, 'allow')
  sec('SEC-040', metaAllow !== 'allow', `allow 档下元数据地址仍被拦（实际 action=${metaAllow}）`)
}

/** SEC-041：DNS 重绑定 / 重定向 —— 目标主机归一化后仍按同一策略判 */
function rebound(net, patterns) {
  const policy = { denyHosts: ['evil.com'] }
  sec('SEC-041', patterns.hostVerdict('Evil.com.', policy) === 'deny', '结尾点归一化后仍命中 deny')
  sec('SEC-041', patterns.hostVerdict('EVIL.COM', policy) === 'deny', '大小写归一化后仍命中 deny')
  sec('SEC-041', patterns.hostVerdict('evil.com:443', policy) === 'deny', '带端口仍命中 deny')
  sec('SEC-041', patterns.hostVerdict('user@evil.com', policy) === 'deny', '带 userinfo 仍命中 deny')
  sec('SEC-041', patterns.hostVerdict('', policy) === 'default', '空主机不误判为 allow')
  const hop2 = net.decide({ kind: 'webview', target: 'https://evil.com/landing', ctx: { mode: 'allow', denyHosts: ['evil.com'] } }).action
  sec('SEC-041', hop2 === 'deny', '重定向到禁止主机：按**目标地址**判 deny')
}

/** SEC-042：CDP 断线 / 页面报错 —— 明确失败，不误报成功 */
async function cdpFailure(settle) {
  const cdp = require(join(ROOT, 'electron/core/cdp.cjs'))
  sec('SEC-042', cdp.valueOfEvaluate({ result: { value: 5 } }) === 5, '正常取值返回结果')
  let threw = null
  try {
    cdp.valueOfEvaluate({ exceptionDetails: { exception: { description: 'boom\n    at x:1' } } })
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  sec('SEC-042', threw === 'boom', `页面报错 → 抛明确错误且只取第一行（${threw}）`)
  const res = await settle.settle(1, { timeoutMs: 300, sampleMs: 50, evaluate: async () => ({ readyState: 'loading', interactions: 1 }) })
  sec('SEC-042', res.settled === false, `页面一直没安静 → 如实返回 settled=false（waited=${res.waitedMs}ms）`)
}

/** SEC-043：登录态 / cookie 不外泄 —— 独立分区 + 敏感键脱敏 */
function cookieIsolation(webviewPerm, redact) {
  sec('SEC-043', /^persist:/.test(webviewPerm.PARTITION) && webviewPerm.PARTITION !== 'persist:', `网页用独立持久分区（${webviewPerm.PARTITION}）→ 与应用会话隔离`)
  sec('SEC-043', redact.isSecretKey('cookie') === true && redact.isSecretKey('set-cookie') === true, 'cookie / set-cookie 被当敏感键')
  sec('SEC-043', !String(redact.scrub({ Cookie: 'sid=supersecret123' }).Cookie).includes('supersecret123'), 'Cookie 值在脱敏时被隐藏')
}

/** SEC-044：浏览器下载入口与台账一致 */
function downloadEntry() {
  const store = require(join(ROOT, 'electron/core/download-store.cjs'))
  const intake = require(join(ROOT, 'electron/core/download-intake.cjs'))
  const a = store.add({ url: 'https://e.com/a.bin', file: join(tmpDir('dl'), 'a.bin'), origin: 'browser' })
  sec('SEC-044', a.ok === true && a.item.origin === 'browser', '浏览器入口的任务带 origin=browser')
  const b = store.add({ url: 'https://e.com/b.bin', file: join(tmpDir('dl2'), 'b.bin') })
  sec('SEC-044', b.ok === true && b.item.origin === 'user', '手动入口默认 origin=user（两入口归属一致可区分）')
  store.remove(a.item.id)
  sec('SEC-044', store.get(a.item.id) == null, '取消/删除在各入口一致（台账里消失）')
  sec('SEC-044', intake.safeName('../../etc/passwd') === 'passwd', '文件名清洗：去路径（下载入口同源）')
}

/** SEC-045：页面稳定等待 —— 不无限等、不把未渲染页当完成 */
async function settleLimits(settle) {
  const probe = { readyState: 'complete', interactions: 3 }
  let st = settle.stepQuiet({ sig: null, quiet: 0 }, probe, 2)
  sec('SEC-045', st.settled === false, '第一次采样不算安静')
  st = settle.stepQuiet(st, probe, 2)
  sec('SEC-045', st.settled === false, '第二次仍不算（需连续 quietSamples 次）')
  st = settle.stepQuiet(st, probe, 2)
  sec('SEC-045', st.settled === true, '连续 quietSamples 次相同且 complete → 安静')
  const churn = settle.stepQuiet({ sig: 'complete|3', quiet: 1 }, { readyState: 'complete', interactions: 5 }, 2)
  sec('SEC-045', churn.settled === false, '元素数变化 → 重新计数（不把还在加载当完成）')
  const started = Date.now()
  const res = await settle.settle(1, { timeoutMs: 250, sampleMs: 50, evaluate: async () => ({ readyState: 'loading', interactions: 2 }) })
  sec('SEC-045', res.settled === false && Date.now() - started < 5000, '到上限就返回（不无限等待）')
}

/** SEC-046：网络失败与重试 —— 次数/退避有上限 */
function retryBounds() {
  const errs = require(join(ROOT, 'electron/core/errors.cjs'))
  const eng = require(join(ROOT, 'electron/core/download-engine.cjs'))
  sec('SEC-046', Number.isFinite(errs.MAX_AUTO_RETRY) && errs.MAX_AUTO_RETRY <= 3, `自动重试上限有限（${errs.MAX_AUTO_RETRY}）`)
  const b1 = errs.backoffMs(1)
  const b99 = errs.backoffMs(99)
  sec('SEC-046', b99 <= 60000 && b99 >= b1, `退避有上限（1→${b1}ms，99→${b99}ms）`)
  sec('SEC-046', Number.isFinite(eng.MAX_RETRIES) && eng.MAX_RETRIES > 0, `下载重试有限（${eng.MAX_RETRIES}）`)
}

export async function run() {
  const net = require(join(ROOT, 'electron/core/net-policy.cjs'))
  const steps = [
    ['SEC-037 CDP 非授权标签', () => cdpContainment()],
    ['SEC-039 iframe / 弹窗越界', () => popupContainment(require(join(ROOT, 'electron/navigation-policy.cjs')))],
    ['SEC-040 SSRF（回环 / 内网 / 元数据）', () => ssrf(net)],
    ['SEC-041 DNS 重绑定 / 重定向', () => rebound(net, require(join(ROOT, 'electron/core/net-policy-patterns.cjs')))],
    ['SEC-042 CDP 断线 / 页面关闭竞态', () => cdpFailure(require(join(ROOT, 'electron/core/browse-settle.cjs')))],
    ['SEC-043 站点登录态与 cookie', () => cookieIsolation(require(join(ROOT, 'electron/core/webview-permissions.cjs')), require(join(ROOT, 'electron/core/redact.cjs')))],
    ['SEC-044 浏览器下载入口与台账', () => downloadEntry()],
    ['SEC-045 页面稳定等待超时', () => settleLimits(require(join(ROOT, 'electron/core/browse-settle.cjs')))],
    ['SEC-046 网络失败与重试', () => retryBounds()],
  ]
  for (const [label, fn] of steps) {
    console.log(`\n· ${label}`)
    try {
      await fn()
    } catch (error) {
      sec(label.slice(0, 7), false, `套件抛错：${error instanceof Error ? error.message : error}`)
    }
  }
  console.log('\n· SEC-038 导航后旧元素索引失效（jsdom 真跑）')
  runVitestCases(join(ROOT, 'src/lib/__tests__/securityBrowser.test.tsx'), ['SEC-038'])
  void WORKSPACE
}
