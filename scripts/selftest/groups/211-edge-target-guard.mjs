/**
 * 自检 / 211 —— `edge_*` 的目标地址准入与不可逆动作确认（P2-3）
 *
 * ── 起因（2026-11-05 隔离探针实测）────────────────────────────
 *
 * `browse` 一直走 `net-policy.decide({kind:'webview'})`，而 `edge_*` 是后来加的一族：
 * 它只经过扩展侧 `ext-sites.check`，**而那里判的是「当前标签」**（已经在看的那页）。
 * 于是同一个地址：`browse` 明确拒绝，`edge_page` 照样发出 `navigate`，一句提示都没有。
 * 站点黑名单同理 —— 把 A 站拉黑之后 `edge_page({url:A})` 仍会导航过去。
 *
 * ── 本组怎么判（不看源码字符串，看**发了没发指令**）──────────────
 *
 * 把 `edge-shared.runEdge` 打成记录器（工具是**运行时**从模块上取它的，见
 * `tools/edge-page.cjs` 的 `shared.runEdge`），然后直接调 `tools/index.cjs` 的
 * `execute()` —— 走的是**真实**的权限三档 / 运行时约束 / 网络策略 / 站点策略链。
 * 判据：被拦时**一条指令都没发出**，且回话以「错误：」开头（审计才不会记成成功）。
 *
 * ⚠️ 只读验证，不碰用户的 Edge（`runEdge` 全程被打桩，断了也不会真发指令）。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, require } from '../env.mjs'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'

/** 被拦时回话必须以它开头 —— `tools/index.cjs` 靠这个前缀把调用记成 ok:false */
const ERR = '错误：'
/** 用户拒绝时的开头（同一个判定点，见 index.cjs 的 `denied`） */
const DENIED = '用户拒绝了'

export async function run() {
  group('edge_* 的目标地址准入（P2-3）')

  const shared = require(join(ROOT, 'electron/core/tools/edge-shared.cjs'))
  const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
  const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))
  const sites = require(join(ROOT, 'electron/core/ext-sites.cjs'))
  const netPolicy = require(join(ROOT, 'electron/core/net-policy.cjs'))
  const browse = require(join(ROOT, 'electron/core/tools/browse.cjs'))
  const paths = require(join(ROOT, 'electron/core/paths.cjs'))

  /* ── 打桩：记录「到底发出去了几条指令」 ── */
  const sent = []
  const realRunEdge = shared.runEdge
  const realEdgeCommand = shared.edgeCommand
  shared.runEdge = async (method, payload) => {
    sent.push({ method, payload })
    return '（自检：指令没有真的发出）'
  }
  shared.edgeCommand = () => ({
    getElements: async () => ({ ok: true, url: 'https://current.example/', title: 't', pageVersion: 'v', elements: [] }),
    readCurrent: async () => ({ ok: true, url: 'https://current.example/', title: 't', text: '正文（自检）' }),
  })

  /* ── 站点黑名单：临时写一条，用完**逐字节**恢复（用户的真数据在别的目录，这里只碰自检数据） ── */
  const siteFile = sites.file()
  const backup = existsSync(siteFile) ? readFileSync(siteFile, 'utf8') : null
  const BLOCKED = 'blocked-selftest-211.example'
  const restoreSiteFile = () => {
    try {
      if (backup === null) {
        if (existsSync(siteFile)) unlinkSync(siteFile)
      } else {
        writeFileSync(siteFile, backup)
      }
    } catch {
      /* 恢复失败不该让整组红 —— 数据根是隔离的 */
    }
  }

  const ctxOf = (extra = {}) => ({
    workdir: SANDBOX,
    permission: 'ask',
    sessionId: 'selftest-211',
    confirm: async () => true,
    log: { warn() {}, info() {}, debug() {} },
    ...extra,
  })

  /** 跑一次工具，返回「有没有发出指令」+ 回话 */
  const run = async (name, args, ctx) => {
    sent.length = 0
    let text
    try {
      const out = await tools.execute(name, args, ctx)
      text = typeof out === 'string' ? out : String(out?.text ?? '')
    } catch (error) {
      text = `${ERR}（抛异常）${error.message}`
    }
    return { dispatched: sent.length, text }
  }

  try {
    sites.setSite(BLOCKED, true, '自检 211：临时拉黑')
    check('隔离数据里能写站点黑名单（本组前提）', sites.check(`https://${BLOCKED}/x`).allowed === false, siteFile)

    /* ── ① 与 browse 同一份判据：网络策略「禁止」 ── */
    const denyCtx = ctxOf({ netPolicy: { mode: 'deny' } })
    const url = `https://${BLOCKED}/x`
    const browseSaid = browse.networkGuard(url, ctxOf({ netPolicy: { mode: 'deny' } }))
    check('对照：同一地址 browse 被网络策略拦下（本组前提）', browseSaid.includes('网络策略'), browseSaid.slice(0, 40))

    const b1 = await run('edge_page', { url }, denyCtx)
    check(
      '★ 网络策略「禁止」时 edge_page 不导航（原来会直接导过去）',
      b1.dispatched === 0 && b1.text.startsWith(ERR),
      `发出 ${b1.dispatched} 条｜${b1.text.slice(0, 50)}`,
    )
    const b2 = await run('edge_tabs', { action: 'create', url }, denyCtx)
    check(
      '★ 网络策略「禁止」时 edge_tabs create 不建标签',
      b2.dispatched === 0 && b2.text.startsWith(ERR),
      `发出 ${b2.dispatched} 条｜${b2.text.slice(0, 50)}`,
    )

    /* 判据是**同一处**：两边都调 net-policy.decide，不是各写一套 */
    check(
      '★ 两边用的是同一份裁决（net-policy.decide 的 deny），不是各写一套',
      netPolicy.decide({ kind: 'webview', target: url, ctx: denyCtx }).action === 'deny' &&
        b1.text.includes('网络策略'),
      b1.text.slice(0, 60),
    )

    /* ── ② 站点黑名单判**目标地址**，不是「当前标签」 ── */
    const c1 = await run('edge_page', { url }, ctxOf())
    check(
      '★ 目标站点被拉黑 → edge_page 不导航（原来只判当前标签，等于放行）',
      c1.dispatched === 0 && c1.text.startsWith(ERR) && c1.text.includes(BLOCKED),
      `发出 ${c1.dispatched} 条｜${c1.text.slice(0, 60)}`,
    )
    const c2 = await run('edge_tabs', { action: 'create', url }, ctxOf())
    check(
      '★ 目标站点被拉黑 → edge_tabs create 不建标签',
      c2.dispatched === 0 && c2.text.startsWith(ERR),
      `发出 ${c2.dispatched} 条｜${c2.text.slice(0, 50)}`,
    )

    /* 没被拉黑的地址照旧放行（别误伤） */
    const ok1 = await run('edge_page', { url: 'https://fine-selftest-211.example/a' }, ctxOf())
    check(
      '没被拉黑、网络策略也没禁 → 照旧导航（不误伤）',
      ok1.dispatched === 1 && sent[0].method === 'navigate',
      `${ok1.dispatched} 条｜${sent[0]?.method}`,
    )
    /* 不给 url 只读当前页：没有目标地址可判，不该被拦 */
    const ok2 = await run('edge_page', {}, ctxOf())
    check('不给 url（只读当前页）不被目标准入误伤', ok2.dispatched === 0 && !ok2.text.startsWith(ERR), ok2.text.slice(0, 40))

    /* ── ③ 不可逆的 close：需要确认档问一次、拒绝就真的不关 ── */
    let asks = 0
    let deniedAnswer = false
    const denyClose = ctxOf({
      confirm: async () => {
        asks += 1
        return deniedAnswer
      },
    })
    const e1 = await run('edge_tabs', { action: 'close', id: 42 }, denyClose)
    check(
      '★ 需要确认档下关标签会先问一次（原来任何档位都不问）',
      asks === 1,
      `确认框被调用 ${asks} 次`,
    )
    check(
      '★ 用户拒绝 → 一条指令都没发（真的没关）',
      e1.dispatched === 0 && e1.text.startsWith(DENIED),
      `发出 ${e1.dispatched} 条｜${e1.text.slice(0, 50)}`,
    )

    asks = 0
    deniedAnswer = true
    const e2 = await run('edge_tabs', { action: 'close', id: 42 }, denyClose)
    check(
      '用户批准 → 才真的发一条 tabsClose',
      asks === 1 && e2.dispatched === 1 && sent[0].method === 'tabsClose',
      `问 ${asks} 次｜发出 ${e2.dispatched} 条｜${sent[0]?.method}`,
    )

    /* 完全访问档不问 —— 与 browse_click 同口径（用户 2026-11-05 拍板） */
    asks = 0
    const full = await run('edge_tabs', { action: 'close', id: 43 }, ctxOf({ permission: 'full', confirm: async () => (asks += 1) || true }))
    check(
      '★ 完全访问档不问、直接关（与 browse_click 同口径）',
      asks === 0 && full.dispatched === 1,
      `问 ${asks} 次｜发出 ${full.dispatched} 条`,
    )

    /* ── ④ 分类仍然有效（这几条是本次**没动**的既有行为，钉住防回归） ── */
    for (const [label, ctx] of [
      ['「只分析，不修改」轮', ctxOf({ allowWrite: false })],
      ['只读权限档', ctxOf({ permission: 'readonly' })],
      ['本轮禁止联网', ctxOf({ allowNetwork: false })],
    ]) {
      const r = await run('edge_page', { url: 'https://fine-selftest-211.example/a' }, ctx)
      check(`★ ${label} → edge_page 被拦（既有行为不变）`, r.dispatched === 0 && r.text.startsWith(ERR), r.text.slice(0, 40))
    }
    check(
      'edge_page 仍在 MUTATING_TOOLS、「只分析」轮才拦得住它',
      registry.MUTATING_TOOLS.has('edge_page') === true && registry.WRITE_TOOLS.has('edge_page') === false,
      '分类没被本组改动',
    )

    /* ── ⑤ 有意保留的差异（写在这里，免得下次被当成缺陷又「修」一遍） ──
     *
     * ★ 这两个工具不用「发了指令」判：`edge-wait.cjs` / `edge-read.cjs` 是在 require 时
     *   **解构**取 `edgeCommand` 的，本组的打桩对它们不生效（`edge_page` / `edge_tabs`
     *   改成运行时取 `shared.*`，那边才是真打桩）。判据改成「撞没撞权限门」：
     *   被门拦住时文案固定是 `错误：本轮对话的运行时约束是…被拒绝`，没撞门就会走到
     *   「没连上 Edge 扩展」那条。两种结果都能从**真的调 execute()** 拿到。
     */
    const GATE_DENY = '本轮对话的运行时约束'
    const wait = await run('edge_wait', { expect: { text: 'x' } }, ctxOf({ allowWrite: false }))
    check(
      '★ 有意差异：edge_wait 是纯等，在「只分析」轮**放行**（没撞运行时约束那道门）',
      !wait.text.includes(GATE_DENY),
      wait.text.slice(0, 50),
    )
    const read = await run('edge_read', {}, ctxOf({ allowWrite: false }))
    check(
      '★ 有意差异：edge_read 是纯读，在「只分析」轮放行（没撞运行时约束那道门）',
      !read.text.includes(GATE_DENY),
      read.text.slice(0, 50),
    )
    const listBlocked = await run('edge_tabs', { action: 'list' }, ctxOf({ allowWrite: false }))
    check(
      '★ 已知粒度问题（本次按拍板**不动**）：edge_tabs 整族在 MUTATING 里，list 也被拦',
      listBlocked.dispatched === 0 && listBlocked.text.startsWith(ERR),
      '工具粒度有意为之，拆它属于权限体系扩展',
    )
    check(
      '★ 有意设计：导航本身不是「敏感动作」，需要确认档不弹卡（只在 close 这类不可逆动作问）',
      (await run('edge_page', { url: 'https://fine-selftest-211.example/a' }, ctxOf())).dispatched === 1,
      '用户拍板「只在敏感动作确认」',
    )
  } finally {
    shared.runEdge = realRunEdge
    shared.edgeCommand = realEdgeCommand
    restoreSiteFile()
  }

  check(
    '站点策略文件已恢复（没把自检数据留在原地）',
    backup === null ? !existsSync(siteFile) : readFileSync(siteFile, 'utf8') === backup,
    siteFile,
  )
  check('数据根是隔离的（不在用户真 data 里）', paths.DIRS.data.includes('selftest'), paths.DIRS.data)
}
