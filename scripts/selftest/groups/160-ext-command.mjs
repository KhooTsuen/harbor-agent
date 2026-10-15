/**
 * 自检 / 下行指令与元素引用解析（M04 第 1 步）
 *
 * 本组守的是 M04 的**地基**：主进程 → 扩展的下行指令通道 + 元素引用的失效判定。
 * 四块：
 *
 *   ① **`inspectRef` 三条判定**（纯函数）：版本不同 → `page-changed`；版本同、ref 在
 *      列表里 → `ok`；版本同、ref 不在列表里 → `not-found`。
 *      ★ 这是 M04「防误点」的核心 —— 判错了就会点错东西，所以它必须能被直接覆盖。
 *   ② **指令配对**：没桥 / 桥没人接 → `NO_BROWSER`（人话）；正常发出 → 回执按 id
 *      配对 resolve；超时 → `TIMEOUT`；迟到的回执 → `matched:false`（不算错）。
 *   ③ **渲染**：`renderElements` 把失效写进人话（要求重新观察）；敏感字段不进文本。
 *   ④ **接线**：协议 kind / 错误码 / 分派表 / 桥注入 / host 转发 / SW 入口 —— 少一处
 *      就是「指令发出去没人应」，而且**不报错**（真机才现形，所以这里静态钉住）。
 *
 * ★ 用**真 ext-command / 真 ext-observe / 真 ext-ops**（不复制实现）—— 抄一份等于验了个假东西。
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

export async function run() {
  const C = require(join(ROOT, 'electron/core/ext-command.cjs'))
  const P = require(join(ROOT, 'electron/core/ext-protocol.cjs'))
  const O = require(join(ROOT, 'electron/core/ext-observe.cjs'))

  const els = [
    { ref: 'aaa.1', role: 'button', tag: 'BUTTON', text: '提交' },
    { ref: 'aaa.2', role: 'textbox', tag: 'INPUT', text: '名字' },
  ]

  /* ── ① 引用失效判定（M04 防误点的核心）── */
  group('M04 · 元素引用解析（inspectRef 三条判定）')

  const okCase = C.inspectRef('aaa.1', 'aaa', els)
  check('★ 版本一致 + ref 在列表里 → 有效，且带上元素当前状态', okCase.kind === 'ok' && !okCase.stale && okCase.element?.text === '提交')
  check('★ 返回的是**列表里那条**（不是凭空造的）', okCase.element === els[0])

  const staleVer = C.inspectRef('aaa.1', 'bbb', els)
  check('★★ 版本变了 → 失效，理由 page-changed（必须重新观察）', staleVer.stale === true && staleVer.reason === 'page-changed')
  check('★ 失效时把「引用是第几版、当前是第几版」都带上', staleVer.version === 'aaa' && staleVer.currentVersion === 'bbb')

  const gone = C.inspectRef('aaa.9', 'aaa', els)
  check('★ 版本一致但 ref 不在列表里 → 失效，理由 not-found', gone.stale === true && gone.reason === 'not-found')

  const noRef = C.inspectRef('', 'aaa', els)
  check('★ 不传 ref → 按「列表模式」（不是失效）', noRef.kind === 'list' && noRef.stale === false)
  /*
   * 版本号里**含点**的边界：`inspectRef` 取**最后一个点之前**当版本号。
   * ⚠️ 现实里版本号是 8 位十六进制（`fnv1a`），**不含点** —— 这条只是防御性边界，
   *   所以列表里也必须是同一条 ref，否则 `found=null` 会把 not-found 误当版本判定失败。
   */
  const dotted = [{ ref: 'a.b.1', role: 'button' }]
  check('★ 版本号里含点也不怕（取最后一个点之前当版本）', C.inspectRef('a.b.1', 'a.b', dotted).stale === false)

  /* ── ② 下行指令：发出、配对、超时 ── */
  group('M04 · 下行指令（配对 / 超时 / 没浏览器）')

  const noBridge = C.createCommand({ getBridge: () => null })
  const r1 = await noBridge.getElements()
  check('★ 扩展没连上 → NO_BROWSER + 人话（不干等）', r1.ok === false && r1.error.code === P.ERR.NO_BROWSER, r1.error?.message)
  check('★ 人话里告诉用户去打开侧边栏', /请打开侧边栏/.test(String(r1.error?.message)))

  const deadBridge = C.createCommand({
    getBridge: () => ({ push: () => ({ sent: 0 }) }),
  })
  const r2 = await deadBridge.getElements()
  check('★ 发出了但没人接（sent=0）→ 也是 NO_BROWSER', r2.ok === false && r2.error.code === P.ERR.NO_BROWSER)

  /* 正常链路：push 把 id 记下来，handleResult 用它配对 */
  let pushedId = ''
  const okBridge = C.createCommand({
    getBridge: () => ({
      push: (_kind, payload) => {
        pushedId = String(payload.id)
        return { sent: 1 }
      },
    }),
  })
  const pendingGet = okBridge.getElements({})
  await new Promise((r) => setTimeout(r, 20))
  check('★ 指令发出去了（带 id）', pushedId.startsWith('cmd_'), pushedId)
  check('★ 在途计数 = 1', okBridge.pendingCount === 1, String(okBridge.pendingCount))
  const matched = okBridge.handleResult({ id: pushedId, result: { ok: true, pageVersion: 'v1', elements: els } })
  check('★ 回执按 id 配对成功', matched.matched === true)
  const got = await pendingGet
  check('★ 拿到的是回执里的结果（元素列表带过来了）', got.ok === true && got.elements?.length === 2 && got.pageVersion === 'v1')

  const late = okBridge.handleResult({ id: 'cmd_nope', result: { ok: true } })
  check('★ 迟到的 / 配不上的回执 → matched:false（不算错、不抛）', late.ok === true && late.matched === false)

  const timeoutCmd = C.createCommand({ getBridge: () => ({ push: () => ({ sent: 1 }) }) })
  const t0 = Date.now()
  const r3 = await timeoutCmd._call('get-elements', {}, 60)
  check('★ 超时 → TIMEOUT + 人话（页面卡住 / 扩展被回收）', r3.ok === false && r3.error.code === P.ERR.TIMEOUT, r3.error?.message)
  check('★ 超时后把在途清掉（不泄漏）', timeoutCmd.pendingCount === 0, String(timeoutCmd.pendingCount))
  check('★ 真的等了那么久（不是立刻返回）', Date.now() - t0 >= 50)

  /* 失效引用走完整 getElements 时，回的是 STALE_REF 而不是「成功」 */
  const staleBridge = C.createCommand({
    getBridge: () => ({
      push: (_k, payload) => {
        setTimeout(() => {
          staleBridge.handleResult({ id: payload.id, result: { ok: true, pageVersion: 'NEW', elements: els } })
        }, 5)
        return { sent: 1 }
      },
    }),
  })
  const r4 = await staleBridge.getElements({ ref: 'OLD.1' })
  check('★★ getElements 拿旧 ref 问 → STALE_REF（不当成成功）', r4.ok === false && r4.error.code === P.ERR.STALE_REF, r4.error?.message)
  check('★ 失效响应里带上当前版本，便于调用方重试', r4.pageVersion === 'NEW' && r4.reason === 'page-changed')

  /* ── ③ 渲染：失效写成人话、敏感字段不进文本 ── */
  group('M04 · 元素视图渲染（renderElements）')

  const obs = { url: 'https://x.test/', title: 'T', pageVersion: 'v9', elements: [{ ref: 'v9.1', role: 'textbox', tag: 'INPUT', text: '密码', masked: true }] }
  const rendered = O.renderElements(obs, { ref: 'v9.1', parsed: C.inspectRef('v9.1', 'v9', obs.elements) })
  check('★ 渲染出元素表格（含引用列）', /\| 1 \|/.test(rendered.markdown) && rendered.markdown.includes('v9.1'))
  check('★ 敏感字段在文本里是「不读取」（不是原值）', rendered.markdown.includes('（敏感字段，不读取）') && !rendered.markdown.includes('密码值'))

  const staleRender = O.renderElements(obs, { ref: 'v8.1', parsed: C.inspectRef('v8.1', 'v9', obs.elements) })
  check('★ 失效时渲染出「已失效 + 要求重新观察」', /已失效/.test(staleRender.markdown) && /重新/.test(staleRender.markdown))

  /* ── ④ 接线（少一处 = 指令发出去没人应，且不报错）── */
  group('M04 · 接线（协议 / 分派 / 桥 / host / SW）')

  const kinds = Object.values(P.KIND)
  check('★ 协议层有 page:elements（上行元素视图）', kinds.includes('page:elements'))
  check('★ 协议层有 page:command / page:result（下行指令与回执）', kinds.includes('page:command') && kinds.includes('page:result'))
  const codes = Object.values(P.ERR)
  check('★ 错误码有 NO_BROWSER / STALE_REF', codes.includes('NO_BROWSER') && codes.includes('STALE_REF'))

  const ops = readFileSync(join(ROOT, 'electron/core/ext-ops.cjs'), 'utf8')
  check('★ 分派表认 page:elements', /\[P\.KIND\.PAGE_ELEMENTS\]/.test(ops))
  check('★ 分派表认 page:result（回执配对入口）', /\[P\.KIND\.PAGE_RESULT\]/.test(ops))
  check('★ 元素视图复用 observe 的渲染与 ingest（不另写一套落盘）', /renderElements/.test(ops) && /inspectRef/.test(ops))

  const bridge = readFileSync(join(ROOT, 'electron/core/ext-bridge.cjs'), 'utf8')
  check('★ 桥把 command 注进分派表（不注 = 回执没人接）', /command:\s*options\.command/.test(bridge))

  const host = readFileSync(join(ROOT, 'electron/core/ext-host-loop.cjs'), 'utf8')
  check('★ host 转发 get-elements', /'get-elements'/.test(host) && /P\.KIND\.PAGE_ELEMENTS/.test(host))

  const sw = readFileSync(join(ROOT, 'harbor-edge/extension/service-worker.js'), 'utf8')
  check('★ SW 有 get-elements 入口', /'get-elements'/.test(sw) && /getElements/.test(sw))

  const run = readFileSync(join(ROOT, 'harbor-edge/extension/lib/observe-run.js'), 'utf8')
  check('★ ★ 元素列表**复用同一个采集器**（不新写第二个 —— 那必然漂）', /collectPageContext/.test(run) && !/function collectElements/.test(run))
  /*
   * ★★ 这条钉的是**本轮真漂过的地方**：发给 host 的是 **type**（`get-elements`），
   *    不是协议 **kind**（`page:elements`）。混了 → host 认不出 → 回一条**没有 id** 的
   *    兜底 → 扩展按 id 配 pending 永远配不上 → 每次都超时（看起来像「桥坏了」）。
   *    两端各写一个字符串必然漂，所以这里必须有断言。
   */
  check('★★ 发给 host 的 type 是 get-elements（不是协议 kind —— 混了必超时）', /'get-elements'/.test(run) && !/requestHost\(\s*'page:elements'/.test(run))
}
