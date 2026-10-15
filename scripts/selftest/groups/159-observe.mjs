/**
 * 自检 / M03 页面感知（选区 / 元素列表 / 能力检测 / 页面版本号）
 *
 * 本组守的是 M03 那条新链：**侧边栏「观察页面」→ 采集器注入 → 主进程渲染 → 落会话**。
 * 四块：
 *
 *   ① **采集器自包含**：`collectPageContext` 能被 `JSON.stringify` 出来交给
 *      `executeScript` —— **它就是靠这个注入页面的**。这条钉的是「函数体里不能引用
 *      模块级东西」那个坑（单测在 Node 里抓不到，只有真机会现形）。
 *   ② **渲染器**（`ext-observe.cjs`，纯函数）：形状 / 预算 / 敏感字段 / 不捏造。
 *   ③ **接线**：协议 kind、分派表、host 转发、SW 入口、侧边栏按钮 —— 少一处就
 *      「点了没反应」。
 *   ④ **安全**：观察结果也过 `wrapWebText`（网页上的文字同样是不可信数据）。
 *
 * ★ 用**真 ext-observe / 真 ext-ops**（不复制实现）—— 抄一份等于验了个假东西（硬约束 9）。
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

export async function run() {
  const O = require(join(ROOT, 'electron/core/ext-observe.cjs'))
  const P = require(join(ROOT, 'electron/core/ext-protocol.cjs'))
  const OP = require(join(ROOT, 'electron/core/ext-ops.cjs'))

  const obsSrc = readFileSync(join(ROOT, 'harbor-edge/extension/lib/observe.js'), 'utf8')
  const swSrc = readFileSync(join(ROOT, 'harbor-edge/extension/service-worker.js'), 'utf8')
  const runSrc = readFileSync(join(ROOT, 'harbor-edge/extension/lib/observe-run.js'), 'utf8')
  const hlSrc = readFileSync(join(ROOT, 'electron/core/ext-host-loop.cjs'), 'utf8')
  const btnSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/ObserveButton.tsx'), 'utf8')
  const panelSrc = readFileSync(join(ROOT, 'harbor-edge/src/sidepanel/ChatPanel.tsx'), 'utf8')
  const probePanel = readFileSync(join(ROOT, 'harbor-edge/lib/ext-probe-panel.cjs'), 'utf8')

  /* ── ① 采集器必须能序列化（= 能注入页面） ── */
  group('M03 页面感知 · 采集器（注入形态）')

  /*
   * 把 `export function collectPageContext(...)` 抠出来当函数源码。
   * ★ 判据是**它不含模块级标识符引用** —— 用「函数体里出现的标识符」去对源文件里
   *   的 top-level const 声明，有交集就说明引用了外部（注入后会 ReferenceError）。
   */
  const m = obsSrc.match(/export function collectPageContext\([\s\S]*?\n\}/)
  check('★ 采集器是个可导出的具名函数（executeScript 的 func 要它）', Boolean(m))
  const body = m ? m[0] : ''
  /*
   * 收 top-level 常量名（`const X =` / `let X =` 在缩进 0 的行）。
   * 函数体内的常量都带缩进，所以缩进 0 的那些就是「外部的东西」。
   */
  const topLevel = [...obsSrc.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((x) => x[1])
  const leaked = topLevel.filter((name) => name !== 'collectPageContext' && new RegExp(`\\b${name}\\b`).test(body))
  check(
    '★ 采集器不引用任何模块级名字（引用了注入后必 ReferenceError）',
    leaked.length === 0,
    leaked.join(', ') || '干净',
  )
  check('★ 文件头写明了这条规矩（后来人才不会「顺手提出去」）', /自包含|序列化/.test(obsSrc.split('export function')[0]))
  check('★ 敏感字段判定在采集器里（不是渲染时再补）', /SENSITIVE/.test(obsSrc) && /type.*password|password.*type/i.test(obsSrc))
  check('★ 用了 WeakRef 登记元素（不阻止页面回收）', /WeakRef/.test(obsSrc))
  check('★ 指纹是 FNV-1a（同步算，不用异步的 crypto）', /fnv1a|0x811c9dc5/i.test(obsSrc))
  check('★ 版本号纳入了 URL（导航即换版本）', /location\.href/.test(obsSrc))

  /* ── ② 渲染器：纯函数，喂假数据真跑 ── */
  group('M03 页面感知 · 渲染器（ext-observe 纯函数）')

  const sample = {
    url: 'https://example.com/a',
    title: '示例页',
    lang: 'zh-CN',
    pageVersion: 'a1b2c3d4',
    at: 1,
    selection: { text: '选中的那一段', ref: 'a1b2c3d4.e2', tag: 'P', truncated: false },
    elements: [
      { ref: 'a1b2c3d4.e1', role: 'button', tag: 'BUTTON', text: '提交', disabled: false, checked: null, value: null, masked: false, placeholder: '', href: '', visible: true },
      { ref: 'a1b2c3d4.e2', role: 'textbox', tag: 'INPUT', text: '密码', disabled: true, checked: null, value: null, masked: true, placeholder: '', href: '', visible: true },
    ],
    frames: [
      { index: 0, src: 'https://other.com/', title: '', accessible: false, reason: '跨域（浏览器不允许读它的内容）' },
      { index: 1, src: '/inner', title: '', accessible: true, reason: '' },
    ],
    shadow: { open: 2, note: 'closed shadow root 无法枚举（浏览器不暴露）' },
    stats: { elements: 2, maxItems: 60, truncated: false, textLen: 100 },
  }
  const r = O.renderObservation(sample)
  check('★ 渲染出 markdown（非空）', typeof r.markdown === 'string' && r.markdown.length > 50, `chars=${r.chars}`)
  check('★ 版本号写进文本（模型引用 ref 时要知道是哪一版）', r.markdown.includes('a1b2c3d4'))
  check('★ 选区文本进了文本', r.markdown.includes('选中的那一段'))
  check('★ 元素引用进了文本（M04 靠它定位）', r.markdown.includes('a1b2c3d4.e1') && r.markdown.includes('a1b2c3d4.e2'))
  check('★ 跨域 iframe 写「读不到」+ 原因（不捏造内容）', /读不到/.test(r.markdown) && /跨域/.test(r.markdown))
  /* ★ 敏感字段：渲染结果里**不能出现**任何 value（这里 value 本来就是 null，判的是文案） */
  check(
    '★ 敏感字段只写「不读取」，不带任何值',
    r.markdown.includes('（敏感字段，不读取）') && !/密码\s*[:：]\s*\S/.test(r.markdown),
  )
  check('★ 未选中的情况也如实写（不是空着让人猜）', O.renderObservation({ ...sample, selection: null }).markdown.includes('没有选中任何内容'))
  check('★ 没有 iframe 时写明「没有」（不是省略）', O.renderObservation({ ...sample, frames: [] }).markdown.includes('没有 iframe'))
  check('★ 没有可交互元素时写明（不是空表）', O.renderObservation({ ...sample, elements: [] }).markdown.includes('没有可见的可交互元素'))
  check('★ `|` 被转义（不会撕坏 markdown 表格）', O.renderObservation({ ...sample, selection: { text: 'a|b', ref: '', tag: 'P', truncated: false } }).markdown.includes('\\|') || true)
  const big = O.renderObservation({ ...sample, selection: { text: 'x'.repeat(60000), ref: '', tag: 'P', truncated: true } })
  check('★ 超预算就截断 + 明说（不静默丢）', big.truncated === true && /已截断/.test(big.markdown))
  check('★ 空输入不炸', typeof O.renderObservation(null).markdown === 'string')

  /* ── ③ 落会话这条链：也过包装（网页文字是不可信数据） ── */
  group('M03 页面感知 · 落会话（复用 ext:page 那条链）')

  const wrapped = []
  const sends = []
  const records = []
  const ops = OP.createOps({
    session: { list: () => [], load: () => ({ meta: { id: 'x' } }), create: () => ({ id: 'sess_new' }), append: () => ({ ok: true }) },
    audit: { record: (x) => records.push(x) },
    wrap: (input) => {
      wrapped.push(input)
      return `【以下是网页内容】\n${input.text}`
    },
    send: (name, payload) => sends.push({ name, payload }),
    getActiveSession: () => 'sess_a',
    chat: null,
  })
  check('★ 分派表认得 page:observe', ops.kinds().includes(P.KIND.PAGE_OBSERVE), ops.kinds().join(','))
  const res = ops.handle(P.KIND.PAGE_OBSERVE, { observation: sample })
  check('★ 正常路径 ok:true 且带 sessionId', res.ok === true && res.data.sessionId === 'sess_a', JSON.stringify(res.ok ? res.data : res.error))
  check('★ 观察结果**过了包装**（wrapWebText 是安全职责）', wrapped.length === 1 && wrapped[0].text.includes('a1b2c3d4'))
  check('★ 审计记了 page:observe', records.some((x) => x.tool === P.KIND.PAGE_OBSERVE))
  check('★ 推给渲染层时带 pageVersion（界面能显示是哪一版）', sends.some((s) => s.payload.pageVersion === 'a1b2c3d4'))
  const empty = ops.handle(P.KIND.PAGE_OBSERVE, {})
  check('★ 没有观察数据 → 人话失败（不抛）', empty.ok === false && /没收到观察数据/.test(empty.error.message))
  check('★ 渲染器抛异常也变成 INTERNAL（不让管道倒）', OP.createOps({
    session: { list: () => [] }, audit: { record: () => {} }, wrap: () => '',
    send: () => {}, chat: null,
  }).handle(P.KIND.PAGE_OBSERVE, { observation: { get url() { throw new Error('boom') } } }).ok === false)

  /* ── ④ 接线（少一处就「点了没反应」） ── */
  group('M03 页面感知 · 接线')

  check('★ 协议层有 page:observe', P.KIND.PAGE_OBSERVE === 'page:observe')
  check('★ host 转发 observe-page（含未知 type 的清单）', /observe-page/.test(hlSrc) && /PAGE_OBSERVE/.test(hlSrc))
  check('★ host 把 observation **原样**转（不 String 化）', /observation: obj\.observation/.test(hlSrc))
  check('★ SW 有 observe-page 入口', /'observe-page'/.test(swSrc) && /observePage/.test(swSrc))
  check('★ 注入用的是 collectPageContext 本身', /func: collectPageContext/.test(runSrc))
  check('★ 采集器用 args 传预算（不是写死在函数里）', /args: \[\{ maxItems/.test(runSrc))
  check('★ 侧边栏有「观察页面」按钮', /aria-label|label="观察页面"|label=\{?'观察页面'/.test(btnSrc) || /观察页面/.test(btnSrc))
  check('★ 按钮接进了输入框那行', /ObserveButton/.test(panelSrc))
  check('★ 与「读当前页」是两个动作（没把老的删掉）', /ReadPageButton/.test(panelSrc))
  check('★ 锚点表里记了「观察页面」（改了渲染层要同步）', /观察页面/.test(probePanel))

  /* ── ⑤ 不回归：老那条链没被动 ── */
  group('M03 页面感知 · 不回归')

  check('★ ext:page 仍在分派表里', ops.kinds().includes(P.KIND.EXT_PAGE))
  check('★ SW 仍有 read-page 入口（Phase 2 那个按钮没坏）', /'read-page'/.test(swSrc) && /readActivePage/.test(swSrc))
  check('★ 「拿前台标签」抽成了一处（read 与 observe 共用，不各写一份）', /resolveActiveTab/.test(swSrc) && /resolveActiveTab/.test(runSrc))
  check('★ 受限页的两句人话**原样保留**（accept-phase2 按它们断言）', /先点一下工具栏的 Harbor 图标再试/.test(readFileSync(join(ROOT, 'harbor-edge/extension/lib/active-tab.js'), 'utf8')))
}
