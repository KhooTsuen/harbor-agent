/**
 * 自检 / 205 —— 敏感文件授权：批准后必须真的能读（C-1 主诉）
 *
 * 起因（2026-11-04 探针实测）：
 *
 *   `capability.check` 里有这么一句 ——`if (grant && !sensitive)`。
 *   敏感一命中，就连**用户刚批的那一条授权**一起否掉。于是
 *   `tools/permission.cjs` 批完、重试，还是同一个拒绝：
 *   「错误：需要授权才能访问 … 这是环境变量文件」。批准了也永远读不到。
 *
 *   更乱的是 `scope === 'full'` 那一支在敏感判断**之前**就返回 ok，
 *   而工具层先抛了 PERMISSION_REQUIRED —— 两条判据各说各的，
 *   结果「完全访问档读 .env」也是读不到。
 *
 *   第二个病：敏感文件会**继承普通父目录授权** —— 批了 `D:\project`
 *   就等于批了它下面的 `.env`，而确认框上写的是前者、风险是后者。
 *
 * ★ 判据是**真的读没读到**，不是文案。虚拟敏感文件在隔离沙箱里，内容是假密钥。
 * ★ 本组只覆盖「批准 → 能用」和「精确路径」两件；会话隔离 / once 归属 /
 *   历史记录 / 续期在 `206-sensitive-grant-record.mjs`（同一套夹具）。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, readFileSync } from '../env.mjs'
import {
  OUTSIDE,
  SECRET,
  capability,
  live,
  prepare,
  readWith,
  readWithCtx,
  reset,
  tools,
} from '../lib/sensitive-kit.mjs'

export async function run() {
  prepare()

  /* ═══════════ ① 用户明确批准后，敏感文件必须真的能读 ═══════════ */
  group('205 / ① 敏感文件经用户批准后必须可用（本轮主诉）')

  const sensitiveFile = join(SANDBOX, '.env')

  reset()
  const refused = await readWith(sensitiveFile, 'ask', 'sess-A', false)
  check(
    '批准前读不到（拒绝就是拒绝）',
    refused.text.includes('用户拒绝') && !refused.text.includes(SECRET),
    refused.text.slice(0, 80),
  )

  reset()
  const approved = await readWith(sensitiveFile, 'ask', 'sess-A', true)
  check(
    '★ 用户批准后真的读到了内容（修复前一直返回「需要授权才能访问」）',
    approved.text.includes(SECRET),
    `问了 ${approved.asked} 次｜${approved.text.slice(0, 90)}`,
  )
  check('批准后只问一次（不能批完再弹）', approved.asked === 1, `实际 ${approved.asked} 次`)
  check(
    '★ 授权记的是**这个文件的精确路径**，不是一个目录',
    live().some((item) => String(item.path) === capability.realpath(sensitiveFile)),
    JSON.stringify(live().map((item) => item.path)),
  )

  reset()
  const full = await readWith(sensitiveFile, 'full', 'sess-A', true)
  check(
    '★ 完全访问档读敏感文件：不弹窗、并且读到（修复前这里也是读不到）',
    full.asked === 0 && full.text.includes(SECRET),
    `问了 ${full.asked} 次｜${full.text.slice(0, 80)}`,
  )

  /* ═══════════ ② 敏感文件只认精确授权，不继承父目录 ═══════════ */
  group('205 / ② 敏感文件只认精确路径授权')

  reset()
  capability.grant(SANDBOX, { mode: 'session', sessionId: 'sess-A', reason: '批了整个工作目录' })
  const viaParent = capability.check(sensitiveFile, { workdir: SANDBOX, sessionId: 'sess-A' })
  check(
    '★ 批了父目录 ≠ 批了它下面的 .env',
    viaParent.ok === false,
    JSON.stringify({ ok: viaParent.ok, sensitive: viaParent.sensitive }),
  )
  const viaParentRead = await readWith(sensitiveFile, 'ask', 'sess-A', false)
  check(
    '父目录授权下读 .env 仍然要问人',
    viaParentRead.asked === 1 && !viaParentRead.text.includes(SECRET),
    `问了 ${viaParentRead.asked} 次｜${viaParentRead.text.slice(0, 70)}`,
  )

  reset()
  capability.grant(sensitiveFile, { mode: 'session', sessionId: 'sess-A', reason: '精确批准' })
  const exact = capability.check(sensitiveFile, { workdir: SANDBOX, sessionId: 'sess-A' })
  check('精确批准那个文件之后才放行', exact.ok === true && exact.granted === 'session')

  /*
   * 兼容：**非敏感**路径照旧允许父目录覆盖（老行为一字不改）。
   * 这一条是「别为了修敏感文件把普通路径也一起收紧」的红线。
   */
  reset()
  capability.grant(OUTSIDE, { mode: 'session', sessionId: 'sess-A', reason: '批了这个目录' })
  const plain = capability.check(join(OUTSIDE, 'note.txt'), {
    workdir: SANDBOX,
    sessionId: 'sess-A',
  })
  check(
    '非敏感路径仍由父目录授权覆盖（兼容性，不能顺手收紧）',
    plain.ok === true,
    JSON.stringify({ ok: plain.ok, granted: plain.granted }),
  )

  /*
   * ── ③ 「这次是谁」只有一处算法（硬约束 9：跨模块约定只有一处真相源）──
   *
   * 病：`_shared.cjs` 检查时认 `sessionId ?? threadId`，而批完落授权的那层只认
   * `sessionId`。只带 threadId 的链路于是「检查认得出授权、授权却落不下去」，
   * 重试仍是同一个拒绝 —— 外形和 C-1 主诉一模一样，修完还会复发。
   */
  group('205 / ③ 会话身份：检查和落授权必须认同一个算法')

  reset()
  const viaThread = await readWithCtx(sensitiveFile, { threadId: 'thread-1' }, true)
  check(
    '★ 只带 threadId 时批准后也读得到（修复前授权拿不到身份、落不下来）',
    viaThread.text.includes(SECRET),
    `问了 ${viaThread.asked} 次｜${viaThread.text.slice(0, 90)}`,
  )
  check(
    '那条授权记在 thread-1 名下（不是空身份）',
    live().some((item) => String(item.sessionId) === 'thread-1'),
    JSON.stringify(live().map((item) => ({ sessionId: item.sessionId, mode: item.mode }))),
  )
  const threadGrant = capability.check(sensitiveFile, { workdir: SANDBOX, threadId: 'thread-1' })
  check('同一个 threadId 复查时认得出这条授权（检查侧用同一算法）', threadGrant.ok === true)

  /*
   * 源码级钉子：这两个文件里**不许再手写**身份表达式。
   * 只钉文案会被下次重构绕开，所以直接扫源码。
   */
  const SHARED = readFileSync(join(ROOT, 'electron/core/tools/_shared.cjs'), 'utf8')
  const PERM = readFileSync(join(ROOT, 'electron/core/tools/permission.cjs'), 'utf8')
  const handWritten = [
    ['_shared.cjs', SHARED],
    ['permission.cjs', PERM],
  ].filter(([, src]) => /ctx\??\.sessionId\s*\?\?/.test(src))
  check(
    '★ 没有地方再手写 ctx.sessionId ?? …（一律走 capability.sessionKey）',
    handWritten.length === 0,
    handWritten.map(([name]) => name).join('、') || '两处都走 sessionKey',
  )

  /*
   * ── ④ 只有 sessionId / 只有 threadId / 两者都没有 ──
   *
   * 这三种 ctx 各自都要满足两件事：**批准了要能读到**，以及**不能被别人复用**。
   * 「两者都没有」那一格原来是坏的：`permission.cjs` 的注释写「没有身份就退成 once」，
   * 但 `capability-store.add` 对所有非 permanent 模式都要求 owner —— grant 返回
   * `ok:false`，用户刚点的「允许」一点效果都没有（探针实测：返回「需要授权才能访问」、
   * 授权表里一条记录都没留下）。现在改成**只在本次调用内**放行这个精确路径。
   */
  group('205 / ④ 会话身份的三种情形')

  reset()
  const viaSession = await readWithCtx(sensitiveFile, { sessionId: 'sess-A' }, true)
  check(
    '只有 sessionId：批准后读到',
    viaSession.text.includes(SECRET),
    `问了 ${viaSession.asked} 次｜${viaSession.text.slice(0, 70)}`,
  )
  check(
    '记成会话授权、落在 sess-A 名下（不再是一落地就过期的 once）',
    live().some((item) => item.mode === 'session' && String(item.sessionId) === 'sess-A'),
    JSON.stringify(live().map((item) => ({ mode: item.mode, sessionId: item.sessionId }))),
  )

  reset()
  const viaNone = await readWithCtx(sensitiveFile, {}, true)
  check(
    '★ 两者都没有：批准后**也**要读到（修复前这里批准完全没生效）',
    viaNone.text.includes(SECRET),
    `问了 ${viaNone.asked} 次｜${viaNone.text.slice(0, 70)}`,
  )
  check(
    '★ 而且不落任何授权记录（落一条无 owner 的 once 等于谁都能用）',
    live().length === 0,
    JSON.stringify(live().map((item) => item.mode)),
  )

  /* 紧接着再来一次无身份调用：必须重新问、而且读不到 —— 证明放行没有泄漏出去 */
  const reused = await readWithCtx(sensitiveFile, {}, false)
  check(
    '★ 无身份的一次性放行不会泄漏到下一次调用',
    reused.asked === 1 && !reused.text.includes(SECRET),
    `问了 ${reused.asked} 次｜${reused.text.slice(0, 70)}`,
  )

  /*
   * 同一个 ctx 里放行过一个敏感文件，**不**代表同一轮里另一个也免问。
   * （`retryOnce` 在 finally 里删名单；这条判据就是钉那个 finally。）
   */
  reset()
  let asksInRound = 0
  const sharedCtx = {
    workdir: SANDBOX,
    permission: 'ask',
    granted: new Map(),
    /* 第一次（.env）批准，第二次（换一个文件）拒绝 —— 用户行为由这条测试自己决定 */
    confirm: async () => {
      asksInRound += 1
      return asksInRound === 1
    },
  }
  const firstRead = await tools.execute('read_file', { path: sensitiveFile }, sharedCtx)
  const secondRead = String(await tools.execute('read_file', { path: join(OUTSIDE, 'note.txt') }, sharedCtx))
  check(
    '★ 同一轮里换一个文件仍然要问（放行名单是精确路径、用完即删）',
    String(firstRead).includes(SECRET) &&
      asksInRound === 2 &&
      secondRead.includes('用户拒绝'),
    `这一轮问了 ${asksInRound} 次｜第二个文件：${secondRead.slice(0, 60)}`,
  )

  /*
   * 源码级钉子：不许再写回「没有身份就退 once 落盘」——那条路一定失败，
   * 而且失败得**没有声音**（批准了、返回还是拒绝，像是工具坏了）。
   */
  const PERM_SRC = readFileSync(join(ROOT, 'electron/core/tools/permission.cjs'), 'utf8')
  check(
    '★ permission.cjs 里不再有「owner 为空就退 once」的写法',
    !/\?\s*'session'\s*:\s*'once'/.test(PERM_SRC),
    '命中三元表达式 → 又退回去了',
  )

  reset()
}
