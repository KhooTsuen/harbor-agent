/**
 * security:ipc —— Electron 渲染与 IPC 安全（SEC-001 ~ 012）
 *
 * 归属本套件的：001 / 002 / 003 / 004 / 007 / 009 / 011 / 012
 * （005 / 006 / 008 / 010 在 `static` —— 它们静态可判，那边一次做完）。
 *
 * 001~004 与 012 是**渲染层**的事，必须在 jsdom + 真渲染器里跑 —— 用源码字符串判
 * 「有没有危险标签」是清单第 0 节明令禁止的。它们由
 * `src/lib/__tests__/securityHtml.test.tsx` 承载，本套件用 vitest 真跑它、
 * 按 `it('SEC-00X …')` 逐条读回结果（`runRender`）。
 */

import { fs, path, require, ROOT } from '../sandbox.mjs'
import { mark, sec } from '../harness.mjs'
import { execFileSync } from 'node:child_process'

const join = path.join
const RENDER_TEST = join(ROOT, 'src/lib/__tests__/securityHtml.test.tsx')
const RENDER_IDS = ['SEC-001', 'SEC-002', 'SEC-003', 'SEC-004', 'SEC-012']

/**
 * 真跑 vitest，把 `it('SEC-00X …')` 的逐条结果读回来。
 * 用 json reporter 精确到 case，而不是「整个文件过了就算过」——
 * 后者会让一个 case 的失败被另一个的通过盖住。
 */
function runRender() {
  if (!fs.existsSync(RENDER_TEST)) {
    for (const id of RENDER_IDS) mark(id, 'BLOCKED', '渲染层用例文件不存在')
    return
  }
  const out = join(ROOT, 'data', 'security-data', 'render-results.json')
  try {
    execFileSync('npx', ['vitest', 'run', RENDER_TEST, '--reporter=json', `--outputFile=${out}`], {
      cwd: ROOT,
      stdio: 'ignore',
      shell: true,
      timeout: 240000,
    })
  } catch {
    /* 有失败时 vitest 退出码非零 —— 结果文件仍然会写出来，下面照读 */
  }
  let payload = null
  try {
    payload = JSON.parse(fs.readFileSync(out, 'utf8'))
  } catch {
    payload = null
  }
  if (!payload) {
    for (const id of RENDER_IDS) mark(id, 'BLOCKED', 'vitest 未产出结果（环境问题，非通过）')
    return
  }
  const assertions = (payload.testResults ?? []).flatMap((f) => f.assertionResults ?? [])
  for (const id of RENDER_IDS) {
    const hits = assertions.filter((a) => String(a.fullName ?? a.title ?? '').includes(id))
    if (hits.length === 0) {
      mark(id, 'NOT_RUN', '渲染层用例里找不到该编号')
      continue
    }
    const bad = hits.filter((a) => a.status !== 'passed')
    if (bad.length) mark(id, 'FAIL', bad.map((a) => a.title).join('；'))
    else mark(id, 'PASS', `${hits.length} 条渲染层断言通过`, [path.relative(ROOT, RENDER_TEST)])
  }
}

/**
 * SEC-002 加强：默认配置下不可信内容不该执行脚本（清单第 1 节）。
 * 渲染层有一条 HTML 直通（`RawHtml.tsx`）—— 直通开启时 `onerror` 会执行。
 * 这里断言「默认必须关闭」（渲染层另有真渲染断言）。
 */
function rawHtmlDefault() {
  const raw = fs.readFileSync(join(ROOT, 'src/components/chat/markdown/RawHtml.tsx'), 'utf8')
  const enabled = /const DEFAULT_ENABLED = true/.test(raw)
  sec('SEC-002', !enabled,
    `默认不开启 HTML 直通（当前 DEFAULT_ENABLED=${enabled ? 'true（onerror 会执行）' : 'false'}；见 RawHtml.tsx 文件头）`)
}

/** SEC-007：IPC sender 来源校验 —— 真跑 `wrapInvokeHandlers` 的包装层 */
async function senderCheck() {
  const rh = require(join(ROOT, 'electron/register-handlers.cjs'))
  const registered = {}
  const fakeIpc = { handle: (channel, fn) => { registered[channel] = fn } }
  const winWebContents = { id: 7 }
  const isTrusted = (event) => Boolean(event?.sender) && event.sender === winWebContents
  rh.wrapInvokeHandlers(fakeIpc, isTrusted)

  fakeIpc.handle('demo:op', () => 'done')

  let trusted = null
  try {
    trusted = await registered['demo:op']({ sender: winWebContents })
  } catch (error) {
    trusted = `throw:${error.message}`
  }
  sec('SEC-007', trusted === 'done', `受信来源（主窗口）调用放行（结果=${trusted}）`)

  let rejected = false
  try {
    await registered['demo:op']({ sender: { id: 99 } })
  } catch {
    rejected = true
  }
  sec('SEC-007', rejected, '非受信来源（别的 webContents）调用被拒绝')

  /* 接线钉子：registerHandlers 真的把判据传给了包装层（不能只是定义了函数） */
  const src = fs.readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')
  sec('SEC-007', /wrapInvokeHandlers\(ipcMain,\s*isTrustedEvent\)/.test(src), 'registerHandlers 把来源判据接进了包装层')
}

/** SEC-009：外部链接与导航 —— 只有 http/https/mailto 能交给系统；非 http(s) 一律拦 */
function linksAndNav(urlPolicy, navPolicy) {
  const bad = [
    'file:///C:/Windows/system.ini',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'vbscript:msgbox(1)',
    'ms-msdt:/id',
  ]
  for (const target of bad) {
    sec('SEC-009', urlPolicy.isOpenableExternal(target) === false, `${target.slice(0, 34)} 不交给系统打开`)
  }
  sec('SEC-009', urlPolicy.isOpenableExternal('https://example.com/x') === true, 'https 放行（不误伤）')
  sec('SEC-009', urlPolicy.isOpenableExternal('mailto:a@b.com') === true, 'mailto 放行（不误伤）')

  /* 真调 openExternalSafe：file: 绝不能碰 shell.openExternal */
  const opened = []
  const shell = { openExternal: (u) => { opened.push(u) } }
  urlPolicy.openExternalSafe(shell, 'file:///C:/Windows/system.ini', 'sec-test')
  sec('SEC-009', opened.length === 0, 'openExternalSafe 对 file: 不调用 shell.openExternal')
  urlPolicy.openExternalSafe(shell, 'https://example.com/x', 'sec-test')
  sec('SEC-009', opened.length === 1, 'openExternalSafe 对 https 真交给系统')

  /* 导航策略：任何档位下非 http(s) 都 block（协议检查排在 allow 之前） */
  for (const mode of ['ask', 'allow', 'block']) {
    sec('SEC-009', navPolicy.decide('file:///C:/x', 'https://a.com', mode).action === 'block', `${mode} 档：file: 被 block`)
    sec('SEC-009', navPolicy.decide('javascript:alert(1)', 'https://a.com', mode).action === 'block', `${mode} 档：javascript: 被 block`)
    sec('SEC-009', navPolicy.decide('data:text/html,x', 'https://a.com', mode).action === 'block', `${mode} 档：data: 被 block`)
  }
  sec('SEC-009', navPolicy.decide('https://evil.com', 'https://a.com', 'allow', true).action === 'block', '网络策略明确禁止时，导航策略的 allow 不算数')
  sec('SEC-009', navPolicy.decide('https://a.com/next', 'https://a.com', 'ask').action === 'allow', '同站点跳转放行（不误伤）')
}

/** SEC-011：窗口关掉之后，旧来源不能再调敏感 IPC（fail-closed） */
function closedWindowIpc(rh) {
  const wc = { id: 7, isDestroyed: () => false }
  const liveWin = { isDestroyed: () => false, webContents: wc }
  const deadWin = { isDestroyed: () => true, webContents: wc }

  sec('SEC-011', rh.trustedSender(() => liveWin, { sender: wc }) === true, '主窗口在：主窗口 webContents 放行')
  sec('SEC-011', rh.trustedSender(() => null, { sender: wc }) === false, '窗口已关（拿不到窗口）：拒绝')
  sec('SEC-011', rh.trustedSender(() => deadWin, { sender: wc }) === false, '窗口已销毁：拒绝')
  sec('SEC-011', rh.trustedSender(() => liveWin, { sender: { id: 99 } }) === false, '别的来源（非主窗口）：拒绝')
  const deadWc = { id: 8, isDestroyed: () => true }
  sec('SEC-011', rh.trustedSender(() => ({ isDestroyed: () => false, webContents: deadWc }), { sender: deadWc }) === false, '主窗口在但 webContents 已销毁：拒绝')
  sec('SEC-011', rh.trustedSender(() => liveWin, {}) === false, '没有 sender 的畸形事件：拒绝')

  const src = fs.readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')
  sec('SEC-011', /wrapInvokeHandlers\(ipcMain,\s*isTrustedEvent\)/.test(src), 'registerHandlers 把来源判据接进了包装层')
}

export async function run() {
  console.log('\n· SEC-001~004 / 012 渲染层 XSS 与 UI 隔离（vitest 真跑）')
  runRender()
  rawHtmlDefault()

  console.log('\n· SEC-007 IPC sender 校验')
  try {
    await senderCheck()
  } catch (error) {
    sec('SEC-007', false, `套件抛错：${error instanceof Error ? error.message : error}`)
  }

  console.log('\n· SEC-009 外部链接与导航')
  try {
    linksAndNav(
      require(join(ROOT, 'electron/core/url-policy.cjs')),
      require(join(ROOT, 'electron/navigation-policy.cjs')),
    )
  } catch (error) {
    sec('SEC-009', false, `套件抛错：${error instanceof Error ? error.message : error}`)
  }

  console.log('\n· SEC-011 窗口关闭后权限失效')
  try {
    closedWindowIpc(require(join(ROOT, 'electron/register-handlers.cjs')))
  } catch (error) {
    sec('SEC-011', false, `套件抛错：${error instanceof Error ? error.message : error}`)
  }
}
