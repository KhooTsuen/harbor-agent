/**
 * 自检 / M04 第 2 步：点击与验证（`browser.click` / `browser.verify`）
 *
 * 守四块：
 *   ① **注入函数**（`extension/lib/act.js`）：**自包含**（引用模块级东西则注入后
 *      ReferenceError，单测抓不到）+ **判定逻辑**（版本校验 / 证据 / verify 四类期望）。
 *      判定用**假全局真跑**（minimal window / document / location），比只扫源码强一档。
 *   ② **渲染**（`core/ext-observe.cjs` 的 `renderAction`）：「点了」≠「生效」。
 *   ③ **下行通道 + 两道闸**（`core/ext-command.cjs`）：click 前先校验版本，
 *      旧引用**根本不发指令**（发了才说「过期」没用 —— 错的可能已经点出去了）。
 *   ④ **接线**（协议 / 分派 / 桥 / host / SW / native）。
 */

import { readFileSync, join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const ACT = join(ROOT, 'harbor-edge/extension/lib/act.js')

/** 把 ESM 源码里的 `export function xxx` 抠出来在 Node 里跑（自检不启浏览器） */
function loadAct() {
  const src = readFileSync(ACT, 'utf8').replace(/^export\s+/gm, '')
  const mod = { exports: {} }
  /* ★ 手动挂 exports：`export function f` 去掉 `export` 后是函数声明，不会自动进 module.exports */
  const tail = '\nmodule.exports = { clickElement, verifyPage }\n'
  // eslint-disable-next-line no-new-func
  new Function('module', 'window', 'document', 'location', src + tail)(
    mod,
    fakeWin.window,
    fakeWin.document,
    fakeWin.location,
  )
  return mod.exports
}

/** 假全局：够 clickElement / verifyPage 跑判定分支（不碰真 DOM） */
const fakeWin = {
  window: null,
  document: null,
  location: null,
}

/** 造一套假页面环境（`refs` 里放 `[ref, {deref}]` 项） */
function makeEnv({ version = 'v1', refs = [], nodes = 5, textLen = 10, url = 'http://x/', title = 'T', els = {} } = {}) {
  const map = new Map()
  for (const [ref, el] of refs) map.set(ref, { deref: () => el })
  fakeWin.window = { __harborObs: { version, refs: map, at: 0 } }
  fakeWin.document = {
    querySelectorAll: (sel) => new Array(Number(els[sel] ?? 0)).fill({}),
    body: { innerText: 'x'.repeat(textLen) },
    title,
  }
  fakeWin.location = { href: url }
  return fakeWin
}

export async function run() {
  /* ── ① 自包含铁律（静态扫） ── */
  group('M04-2 · 注入函数必须自包含（executeScript 会 toString 后注入）')

  const actSrc = readFileSync(ACT, 'utf8')
  check('★ 导出的是具名函数（executeScript 的 func 要它）', /export function clickElement/.test(actSrc) && /export function verifyPage/.test(actSrc))

  /* 把两个函数体抠出来，扫里面有没有引用模块级的顶层 const 名 */
  const topConsts = [...actSrc.matchAll(/^const\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  check('★ 顶层没有会被「泄漏」进函数体的常量（有的话下面那条更有意义）', topConsts.length === 0, topConsts.join(',') || '(无顶层 const)')

  const bodyOf = (name) => {
    const at = actSrc.indexOf(`export function ${name}(`)
    if (at < 0) return ''
    /* 从函数头往后取到下一个顶层 export（够覆盖函数体） */
    const rest = actSrc.slice(at + 10)
    const next = rest.search(/\nexport\s/)
    return next > 0 ? rest.slice(0, next) : rest
  }
  const cBody = bodyOf('clickElement')
  const vBody = bodyOf('verifyPage')
  check('★ clickElement 里没有 require / import 语句', !/\brequire\s*\(|\bimport\s/.test(cBody))
  check('★ verifyPage 里没有 require / import 语句', !/\brequire\s*\(|\bimport\s/.test(vBody))
  check(
    '★ 两个函数都只用 window / document / location 三个全局（不引别的模块级）',
    !/\bcollectPageContext\b/.test(cBody) && !/\bMAX_\w+\b/.test(cBody) && !/\bMAX_\w+\b/.test(vBody),
  )

  /* ── ② 判定逻辑（假全局真跑） ── */
  group('M04-2 · clickElement 的判定（版本校验 / 证据）')

  const live = { isConnected: true, click() {} }
  makeEnv({ version: 'v1', refs: [['v1.1', live]] })
  let act = loadAct()

  const badRef = await act.clickElement('v9.1', { settleMs: 0 })
  check('★★ 版本对不上 → 拒绝执行（page-changed）', badRef.ok === false && badRef.reason === 'page-changed', JSON.stringify(badRef.reason))
  check('★ 拒绝时带上「引用是第几版 / 当前第几版」', badRef.refVersion === 'v9' && badRef.version === 'v1', `${badRef.refVersion} vs ${badRef.version}`)
  check('★ 拒绝时的人话要求「重新观察」', /重新观察/.test(String(badRef.message)))

  const missing = await act.clickElement('v1.9', { settleMs: 0 })
  check('★ 版本对但 ref 不在表里（或元素已摘） → not-found', missing.ok === false && missing.reason === 'not-found', missing.reason)

  /* 真·「还没观察过」= 页面上根本没有 window.__harborObs（M03 从没跑过） */
  fakeWin.window = {}
  fakeWin.document = { querySelectorAll: () => [], body: { innerText: '' }, title: '' }
  fakeWin.location = { href: 'http://x/' }
  act = loadAct()
  const noObs = await act.clickElement('v1.1', { settleMs: 0 })
  check('★ 还没观察过 → no-observation（不瞎点）', noObs.ok === false && noObs.reason === 'no-observation', noObs.reason)

  /* 正常点：假元素记录被点过 */
  let clicked = 0
  const el = { isConnected: true, click() { clicked += 1 } }
  makeEnv({ version: 'v1', refs: [['v1.1', el]], nodes: 5, textLen: 10 })
  act = loadAct()
  const okClick = await act.clickElement('v1.1', { settleMs: 0 })
  check('★ 版本对 + 元素在 → 真点了（调到了 el.click）', clicked === 1 && okClick.ok === true, `clicked=${clicked}`)
  check('★★ 返回里带 evidence（不是只回「点击成功」）', Boolean(okClick.evidence) && 'urlChanged' in okClick.evidence && 'domChanged' in okClick.evidence && 'targetStillThere' in okClick.evidence, Object.keys(okClick.evidence || {}).join(','))
  check('★ evidence 带前后值（能说出「怎么变」而不是只有「变了」）', 'nodesBefore' in okClick.evidence && 'nodesAfter' in okClick.evidence && 'urlBefore' in okClick.evidence, `${okClick.evidence.nodesBefore}→${okClick.evidence.nodesAfter}`)
  check('★ 还带 checks 逐条列出（模型好读）', Array.isArray(okClick.checks) && okClick.checks.some((c) => c.name === 'dom-changed'), (okClick.checks || []).map((c) => c.name).join(','))

  /* DOM 真变了 → domChanged 为真 */
  const el2 = { isConnected: true, click() { fakeWin.document.body.innerText = 'y'.repeat(99) } }
  makeEnv({ version: 'v1', refs: [['v1.1', el2]], nodes: 5, textLen: 10 })
  act = loadAct()
  const changed = await act.clickElement('v1.1', { settleMs: 0 })
  check('★★ 点完 DOM 变了 → domChanged=true（这就是「状态证据」）', changed.evidence.domChanged === true, `${changed.evidence.textLenBefore}→${changed.evidence.textLenAfter}`)

  group('M04-2 · verifyPage 的判定（四类期望）')

  makeEnv({ url: 'http://x/done?ok=1', title: 'T', els: { '#done': 2 } })
  fakeWin.document.body.innerText = '提交成功 请稍候'
  act = loadAct()

  const v1 = await act.verifyPage({ text: '提交成功' })
  check('★ 文本包含 → 命中', v1.matched === true && v1.checks[0].name === 'text-contains', JSON.stringify(v1.checks[0]))
  const v2 = await act.verifyPage({ text: '不存在的字' })
  check('★ 文本不包含 → 不命中（不放过）', v2.matched === false, JSON.stringify(v2.checks[0]))
  const v3 = await act.verifyPage({ url: '/done' })
  check('★ URL 包含 → 命中', v3.matched === true, JSON.stringify(v3.checks[0]))
  const v4 = await act.verifyPage({ urlEquals: 'http://x/other' })
  check('★ URL 完全相等 → 不等就不命中', v4.matched === false, JSON.stringify(v4.checks[0]))
  const v5 = await act.verifyPage({ selector: '#done' })
  check('★ 元素出现（选择器命中 2 个）→ 命中', v5.matched === true, JSON.stringify(v5.checks[0]))
  const v6 = await act.verifyPage({ selectorGone: '#done' })
  check('★ 元素消失（实际还有 2 个）→ 不命中', v6.matched === false, JSON.stringify(v6.checks[0]))

  const v7 = await act.verifyPage({})
  check('★ 一条期望都没给 → matched=false（**不假装验过**）', v7.matched === false && v7.ok === true, `matched=${v7.matched}`)

  const v8 = await act.verifyPage({ url: '/done', text: '提交成功' })
  check('★ 多条期望**全部**满足才 matched', v8.matched === true && v8.checks.length === 2, `checks=${v8.checks.length}`)

  /* ── ③ 渲染（「点了」≠「生效」） ── */
  group('M04-2 · renderAction 渲染（点了不等于生效）')

  const { renderAction } = require(join(ROOT, 'electron/core/ext-observe.cjs'))

  const clickMd = renderAction('click', {
    ok: true,
    ref: 'v1.3',
    settledMs: 400,
    evidence: { urlChanged: true, urlBefore: 'http://a/', urlAfter: 'http://a/next', titleChanged: false, titleBefore: 'T', titleAfter: 'T', domChanged: true, nodesBefore: 10, nodesAfter: 14, textLenBefore: 20, textLenAfter: 33, targetStillThere: false },
  }).markdown
  check('★ 点击结果渲染成**前后对比表**', /\|.*之前.*\|.*之后/.test(clickMd), clickMd.split('\n').find((l) => /\|/.test(l)) ?? '')
  check('★★ 明确写「点了 ≠ 你要的效果发生了」（不许让模型误判成功）', /不等于你要的效果/.test(clickMd))
  check('★ 变化的前后值都摆出来了（能看出「怎么变」）', clickMd.includes('10 节点') && clickMd.includes('14 节点'))
  check('★ 结论区分「有变化」与「一点没变」', /有变化/.test(clickMd))

  const staleMd = renderAction('click', { ok: false, reason: 'page-changed', ref: 'old.1', refVersion: 'old', version: 'new', message: '页面已经变了' }).markdown
  check('★★ 引用失效渲染成「没有执行」+ 要求重新观察', /没有执行/.test(staleMd) && /重新观察/.test(staleMd))
  check('★ 失效时把两版版本号都写上', staleMd.includes('old') && staleMd.includes('new'))

  const failMd = renderAction('click', { ok: false, error: '执行不了这个操作：X' }).markdown
  check('★ 执行失败也说清原因（不是一片安静）', /执行失败/.test(failMd) && failMd.includes('X'))

  /* ★★ 导航型点击：结果回不来时必须说清「**不代表没点上**」+ 指向 verify */
  const noResMd = renderAction('click', {
    ok: false,
    reason: 'no-result',
    message: '点击指令已经发出去了，但页面在把结果送回来之前就变了',
  }).markdown
  check('★★ 结果回不来时说清「不代表没点上」（否则模型会重试 → 点两次）', /不代表没点上/.test(noResMd))
  check('★ 并指向下一步：用 verify 确认、不要直接重试', /verify/.test(noResMd) && /不要直接重试/.test(noResMd))
  /* ★ 判定（不猜）：拿标签 url 的前后对比说「跳转到了哪」 */
  const navigatedMd = renderAction('click', {
    ok: false,
    reason: 'no-result',
    navigated: true,
    urlAfter: 'http://x/next',
  }).markdown
  check('★ 判定了确实是跳转时，把**跳转到的地址**写出来（硬证据，不是猜）', /页面跳转到了/.test(navigatedMd) && navigatedMd.includes('http://x/next'))

  /* 判定用的是扩展侧能读到的东西（chrome.tabs.get 读 url 前后对比），不是猜 */
  const runSrcForNav = readFileSync(join(ROOT, 'harbor-edge/extension/lib/command-run.js'), 'utf8')
  check('★★ 「是不是导航了」靠**读标签 url 前后对比**判定（不是猜）', /chrome\.tabs\.get/.test(runSrcForNav) && /navigated\s*=/.test(runSrcForNav))

  const verifyMd = renderAction('verify', {
    ok: true,
    matched: false,
    checks: [{ name: 'text-contains', expected: '成功', actual: '不包含', pass: false }],
  }).markdown
  check('★ verify 渲染逐条期望（含「命中」列）', /\|.*期望.*\|.*实际.*\|.*命中/.test(verifyMd), '')
  check('★ 有不符的期望时写明', /有不符的期望/.test(verifyMd))

  /* ── ④ 下行通道 + 两道闸 ── */
  group('M04-2 · ext-command 的 click / verify（两道闸 / 下行通道）')

  const EC = require(join(ROOT, 'electron/core/ext-command.cjs'))
  const P = require(join(ROOT, 'electron/core/ext-protocol.cjs'))

  /** 造一个「假桥」：收到 push 就按 command 自动回一条回执（模拟扩展那侧），真跑 `call()` 配对链路 */
  function makeBridge(handler) {
    const cmd = EC.createCommand({ getBridge: () => bridge, log: { info() {}, warn() {} } })
    const bridge = {
      push(kind, payload) {
        if (kind === P.KIND.PAGE_COMMAND) {
          /* 同步回执（真机上是异步的，这里为了测配对够用） */
          queueMicrotask(() => cmd.handleResult({ id: payload.id, result: handler(payload) }))
        }
        return { ok: true, sent: 1, connections: 1 }
      },
    }
    return cmd
  }

  const seen = []
  const c1 = makeBridge((p) => {
    seen.push(p.command)
    if (p.command === 'get-elements') {
      return { ok: true, url: 'http://x/', title: 'T', pageVersion: 'v1', elements: [{ ref: 'v1.1', role: 'button' }] }
    }
    return { ok: true, ref: 'v1.1', evidence: { urlChanged: false, domChanged: true, nodesBefore: 1, nodesAfter: 2, textLenBefore: 1, textLenAfter: 2, targetStillThere: true } }
  })
  const okc = await c1.click({ ref: 'v1.1' })
  check('★ click 先要一份「当前页面」（校验版本用）', seen[0] === 'get-elements', seen.join(','))
  check('★ 版本对 → 真的把 click 指令发出去了（第一次真机用下行通道）', seen[1] === 'click', seen.join(','))
  check('★ 拿到扩展的结果并回 `ok:true`', okc.ok === true && Boolean(okc.result), JSON.stringify(Object.keys(okc)))

  const seen2 = []
  const c2 = makeBridge((p) => {
    seen2.push(p.command)
    return { ok: true, pageVersion: 'v2', elements: [{ ref: 'v2.1' }] }
  })
  const stale = await c2.click({ ref: 'v1.1' })
  check('★★ 旧引用 → STALE_REF 且**根本没发 click 指令**', stale.ok === false && stale.error.code === P.ERR.STALE_REF && !seen2.includes('click'), seen2.join(','))
  check('★ 回绝时带上「引用属于哪版 / 当前哪版」', stale.refVersion === 'v1' && stale.pageVersion === 'v2', `${stale.refVersion} vs ${stale.pageVersion}`)
  check('★ 回绝的人话要求「重新观察」', /重新观察/.test(String(stale.error.message)))

  const noRef = await c1.click({})
  check('★ 没给 ref → 直接拒（不瞎点）', noRef.ok === false && noRef.error.code === P.ERR.STALE_REF)

  const seen3 = []
  const c3 = makeBridge((p) => {
    seen3.push(p.command)
    return { ok: true, matched: true, checks: [{ name: 'url-contains', expected: '/x', actual: '/x', pass: true }] }
  })
  const vres = await c3.verify({ expect: { url: '/x' } })
  check('★ verify 走的是 `verify` 指令', seen3[0] === 'verify', seen3.join(','))
  check('★ verify 结果原样带回来（含 checks）', vres.ok === true && vres.result.matched === true && vres.result.checks.length === 1)

  /* ── ⑤ 接线 ── */
  group('M04-2 · 接线（协议 / 分派 / 桥 / host / SW / native）')

  /* kind / 错误码的**真相源**是 `ext-kinds.cjs`（从 ext-protocol 拆出，后者再导出）—— 扫真相源，扫 ext-protocol 会假红 */
  const proto = readFileSync(join(ROOT, 'electron/core/ext-kinds.cjs'), 'utf8')
  const opsSrc = readFileSync(join(ROOT, 'electron/core/ext-ops.cjs'), 'utf8')
  const brSrc = readFileSync(join(ROOT, 'electron/core/ext-bridge.cjs'), 'utf8')
  const hlSrc = readFileSync(join(ROOT, 'electron/core/ext-host-loop.cjs'), 'utf8')
  const swSrc = readFileSync(join(ROOT, 'harbor-edge/extension/service-worker.js'), 'utf8')
  const natSrc = readFileSync(join(ROOT, 'harbor-edge/extension/lib/native.js'), 'utf8')
  const runSrc = readFileSync(join(ROOT, 'harbor-edge/extension/lib/command-run.js'), 'utf8')
  const regSrc = readFileSync(join(ROOT, 'electron/register-handlers.cjs'), 'utf8')

  check('★ 协议有 PAGE_COMMAND（下行指令）', /PAGE_COMMAND:/.test(proto))
  check('★ 协议有 PAGE_RESULT（回执）', /PAGE_RESULT:/.test(proto))
  check('★ 协议有 PAGE_ELEMENTS（元素视图，M04-1 那条上行）', /PAGE_ELEMENTS:/.test(proto))
  check('★ 分派表认 page:result（回执配对入口）', /KIND\.PAGE_RESULT\]/.test(opsSrc))
  check('★ 桥把 command 注进 ops（不注 = 回执没人接）', /command:\s*options\.command/.test(brSrc))
  check('★ 桥有 landAction（操作结果落盘，绕开内核互相 require）', /landAction\s*\(/.test(brSrc))
  check('★ ops 把操作结果落盘（ingestAction，复用 ingest 那条链）', /ingestAction/.test(opsSrc))
  check('★ 操作结果也过 wrapWebText（网页文字仍不可信）', /renderAction\(k, result, meta\)/.test(opsSrc) && /wrap\(\{ url, title, text: rendered\.markdown/.test(opsSrc))
  check('★ 装配处建了 extCommand 并 land 到桥', /createCommand\(\{/.test(regSrc) && /land:\s*\(kind, result, meta\)/.test(regSrc))
  check('★ host 转发 page-result（扩展干完活报告结果）', /'page-result'/.test(hlSrc) && /KIND\.PAGE_RESULT/.test(hlSrc))
  check('★ host 的「只认」清单提到了 page-result', /page-result/.test(hlSrc))
  check('★★ SW 注册了指令处理器（漏了 = 指令没人接，15 秒超时）', /setCommandHandler\(runCommand\)/.test(swSrc))
  check('★ native.js 把 page:command 交给处理器（**不**广播给侧边栏）', /msg\.kind === 'page:command'/.test(natSrc) && /commandHandler\(msg\.payload\)/.test(natSrc))
  check('★ 指令处理器回执走 page-result', /requestHost\('page-result'/.test(runSrc))
  check('★ get-elements 复用 M03 的采集器（不新写第二个）', /collectPageContext/.test(runSrc))
  check('★ click 用 clickWithNavWatch（注入 + 导航双信号 race）', /clickWithNavWatch\(target\.tab\.id/.test(runSrc))
  check('★ verify 注入的是 verifyPage（同样有上限）', /injectBounded\(target\.tab\.id, verifyPage/.test(runSrc))
  /* ★★ 导航型点击：注入上下文随页面卸载被销毁、promise 永不 resolve。上一版「注入超时后再
      tabs.get 判定」白等 5 秒多；现在注入 + onUpdated(loading) 双信号 race，导航先到 1~2 秒返回。 */
  check('★★ click 同时监听 onUpdated(loading)（导航先到就不再傻等注入）', /chrome\.tabs\.onUpdated\.addListener/.test(runSrc) && /status === 'loading'/.test(runSrc))
  check('★★ 导航信号先到时返回「开始跳转」这个事实', /__navigating/.test(runSrc) && /开始跳转/.test(runSrc))
  check('★★ 注入仍有超时兜底（点了不跳转但卡住的元素）', /function injectBounded\(/.test(runSrc) && /Promise\.race/.test(runSrc))
  check('★ 回执失败也回（不然对面干等 15 秒）', /不认识的指令/.test(runSrc))

  /* ★★ 主动连接：主进程要能**主动推指令**，不能等扩展第一次请求才建连接（真机逮到） */
  const cliSrc = readFileSync(join(ROOT, 'electron/core/ext-client.cjs'), 'utf8')
  check('★★ ext-client 暴露 ensureConnected（主进程推指令的前提）', /function ensureConnected\(/.test(cliSrc) && /ensureConnected,/.test(cliSrc))
  check('★★ host 启动就主动连管道（懒连会让「扩展还没发过请求」时推不动）', /client\.ensureConnected\(\)/.test(hlSrc))
  check('★ 桥暴露 connectionCount（「推不动」时第一个该看的诊断值）', /connectionCount\s*\(\)/.test(brSrc))
}
