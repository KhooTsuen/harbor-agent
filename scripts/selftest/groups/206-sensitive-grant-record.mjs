/**
 * 自检 / 206 —— 敏感/普通路径授权的**记录**语义（C-1）
 *
 * `205` 管「批准了到底能不能用」，这一组管**授权记录本身**站不站得住：
 *
 *   ③ 历史记录不得因为这次修复拿到新权限（缺 mode / mode 拼错 / 没有过期时刻）
 *   ④ 不同会话的授权隔离（含「调用方没有会话身份」这条漏洞）
 *   ⑤ once 只属于批它的会话，不被别人用掉、也不被提前消耗
 *   ⑥ 重新批准 / 过期续期要真的生效
 *   ⑦ 缺会话身份 / 无效模式的保守处理
 *   ⑧ 非敏感路径与既有权限档位不回归
 *
 * ★ 夹具与 205 共用 `scripts/selftest/lib/sensitive-kit.mjs` —— 两边不能各造一套
 *   「差不多」的沙箱（AGENT.md 硬约束 9）。
 */

import { check, group } from '../harness.mjs'
import { SANDBOX, join } from '../env.mjs'
import {
  OUTSIDE,
  SECRET,
  capability,
  legacy,
  live,
  prepare,
  readWith,
  reset,
  rules,
  seed,
  tools,
} from '../lib/sensitive-kit.mjs'

export async function run() {
  prepare()

  /* ═══════════ ③ 历史记录不得因为这次修复而拿到新权限 ═══════════ */
  group('206 / ③ 历史授权记录：说不清期限/归属的一律不算授权')

  /*
   * 这些形状都是旧版本真写进 `capabilities.json` 的（探针逐条造出来复现过）。
   * 旧代码把它们当「无过期、跨会话」用 —— 一个拼错的字符串换来永久全权。
   */
  const historical = [
    ['缺 mode 字段', { sessionId: 'sess-A', expiresAt: Date.now() + 3600_000 }],
    ['mode 是无效值 forever', { mode: 'forever', sessionId: 'sess-A', expiresAt: 0 }],
    ['once 却没有过期时刻（expiresAt:0）', { mode: 'once', sessionId: 'sess-A', expiresAt: 0 }],
    ['session 却没有过期时刻', { mode: 'session', sessionId: 'sess-A', expiresAt: 0 }],
    ['session 没有会话身份', { mode: 'session', expiresAt: Date.now() + 3600_000 }],
    ['已经过期', { mode: 'session', sessionId: 'sess-A', expiresAt: Date.now() - 1000 }],
  ]
  for (const [label, extra] of historical) {
    reset()
    seed(legacy(extra))
    const decision = capability.check(join(OUTSIDE, 'note.txt'), {
      workdir: SANDBOX,
      sessionId: 'sess-A',
    })
    check(`★ 历史记录「${label}」不算授权`, decision.ok === false, String(decision.reason))
  }

  /* 唯一不能一起收掉的一档：永久授权是用户在设置里明确选的，本来就不绑会话 */
  reset()
  seed(legacy({ mode: 'permanent', expiresAt: 0 }))
  const permanent = capability.check(join(OUTSIDE, 'note.txt'), {
    workdir: SANDBOX,
    sessionId: 'sess-B',
  })
  check(
    '永久授权照旧对所有会话有效（别把这一档一起收掉）',
    permanent.ok === true && permanent.granted === 'permanent',
  )

  /* ═══════════ ④ 会话隔离 ═══════════ */
  group('206 / ④ 不同会话的授权必须隔离')

  reset()
  capability.grant(OUTSIDE, { mode: 'session', sessionId: 'sess-A', reason: 'A 批的' })
  const otherSession = capability.check(join(OUTSIDE, 'note.txt'), {
    workdir: SANDBOX,
    sessionId: 'sess-B',
  })
  check('★ 别的会话的授权用不了', otherSession.ok === false)

  const anonymous = capability.check(join(OUTSIDE, 'note.txt'), { workdir: SANDBOX, sessionId: '' })
  check(
    '★ 调用方没有会话身份时也不能拿别人的会话授权（修复前这里是放行的）',
    anonymous.ok === false,
  )

  const ownSession = capability.check(join(OUTSIDE, 'note.txt'), {
    workdir: SANDBOX,
    sessionId: 'sess-A',
  })
  check('批它的那个会话自己能用', ownSession.ok === true)

  reset()
  capability.grant(OUTSIDE, { mode: 'session', sessionId: 'sess-A', reason: 'A 批的' })
  const row = live().find((item) => String(item.path) === capability.realpath(OUTSIDE))
  check(
    '会话授权的过期时刻在未来（不是 0）',
    Number(row?.expiresAt) > Date.now(),
    String(row?.expiresAt),
  )
  if (row) row.expiresAt = Date.now() - 1
  const expired = capability.check(join(OUTSIDE, 'note.txt'), {
    workdir: SANDBOX,
    sessionId: 'sess-A',
  })
  check('会话授权过期后自动失效', expired.ok === false)

  /* ═══════════ ⑤ once 只能被批它的那个会话用掉 ═══════════ */
  group('206 / ⑤ once 授权：只属于批它的会话，不被别人消费')

  reset()
  capability.grant(OUTSIDE, { mode: 'once', sessionId: 'sess-A', reason: 'A 的一次性' })
  const stolen = capability.check(join(OUTSIDE, 'note.txt'), {
    workdir: SANDBOX,
    sessionId: 'sess-B',
  })
  check('★ B 用不了 A 的 once', stolen.ok === false)
  check('★ 而且没有被提前消耗（A 那条还在）', live().length === 1, `剩 ${live().length} 条`)

  const usedByA = capability.check(join(OUTSIDE, 'note.txt'), {
    workdir: SANDBOX,
    sessionId: 'sess-A',
  })
  check('A 自己能用', usedByA.ok === true && usedByA.granted === 'once')
  check('用完之后那条 once 被销掉', live().length === 0, `剩 ${live().length} 条`)

  /* 同一路径上两个会话各有一条 once：用掉一条不能把另一条一起带走 */
  reset()
  capability.grant(OUTSIDE, { mode: 'once', sessionId: 'sess-A', reason: 'A' })
  capability.grant(OUTSIDE, { mode: 'once', sessionId: 'sess-B', reason: 'B' })
  capability.check(join(OUTSIDE, 'note.txt'), { workdir: SANDBOX, sessionId: 'sess-A' })
  check(
    '★ 销掉一条 once 不会连带别人的（旧代码按路径删，这里按记录删）',
    live().length === 1 && String(live()[0]?.sessionId) === 'sess-B',
    JSON.stringify(live().map((item) => item.sessionId)),
  )

  /* ═══════════ ⑥ 重新批准 / 过期续期 ═══════════ */
  group('206 / ⑥ 重新批准要真的续期')

  reset()
  seed(
    legacy({
      /* 这条种子记录的 path 必须是**目录本身** —— 下面 grant 的也是这个目录，
         否则「续期没有多堆一条」测的就变成了「两条不同路径」 */
      path: OUTSIDE,
      mode: 'session',
      sessionId: 'sess-A',
      expiresAt: Date.now() - 1000,
      grantedAt: Date.now() - 99_000,
    }),
  )
  const regrant = capability.grant(OUTSIDE, {
    mode: 'session',
    sessionId: 'sess-A',
    reason: '重新批准',
  })
  const renewed = live().find((item) => String(item.path) === capability.realpath(OUTSIDE))
  check(
    '★ 重新批准后过期时刻被重算到未来（修复前只更新 grantedAt，批完就是过期的）',
    Number(renewed?.expiresAt) > Date.now(),
    `expiresAt=${String(renewed?.expiresAt)} now=${Date.now()}`,
  )
  const afterRenew = capability.check(join(OUTSIDE, 'note.txt'), {
    workdir: SANDBOX,
    sessionId: 'sess-A',
  })
  check('续期之后马上就能用', afterRenew.ok === true)
  check('没有因为续期多堆出一条重复记录', live().length === 1, `剩 ${live().length} 条`)
  check('grant 返回值也是 ok', regrant.ok === true)

  /* ═══════════ ⑦ 缺会话身份 / 无效模式的保守处理 ═══════════ */
  group('206 / ⑦ 缺会话身份 / 无效模式：保守处理，不意外放权')

  reset()
  const noOwner = capability.grant(OUTSIDE, { mode: 'session', reason: '没有会话身份' })
  check(
    '★ 会话级授权没有会话身份 → 拒绝落库（否则等于谁都能用）',
    noOwner.ok === false && live().length === 0,
    JSON.stringify({ ok: noOwner.ok, 剩: live().length }),
  )

  reset()
  const bogusMode = capability.grant(OUTSIDE, {
    mode: 'forever',
    sessionId: 'sess-A',
    reason: '拼错',
  })
  check(
    '★ 认不出来的模式被归一成最严的一档（once），不是「无过期」',
    bogusMode.ok === true && bogusMode.mode === 'once',
    JSON.stringify(bogusMode),
  )
  check(
    '归一后的记录带过期时刻（所以不会永久赖着）',
    Number(live()[0]?.expiresAt) > Date.now(),
    String(live()[0]?.expiresAt),
  )
  check(
    '纯判断层也认得这几种坏形状',
    rules.inspectGrant({ path: OUTSIDE }).ok === false &&
      rules.inspectGrant({ path: OUTSIDE, mode: 'forever' }).ok === false &&
      rules.inspectGrant({ path: OUTSIDE, mode: 'session' }).ok === false,
  )

  /* ═══════════ ⑧ 非敏感路径与既有行为不回归 ═══════════ */
  group('206 / ⑧ 非敏感文件 / 权限档位不受影响')

  reset()
  const insidePlain = capability.check(join(SANDBOX, 'plain.txt'), {
    workdir: SANDBOX,
    sessionId: '',
  })
  check('工作目录内的普通文件直接放行（不需要身份也不需要授权）', insidePlain.ok === true)

  reset()
  const askedOutside = await readWith(join(OUTSIDE, 'note.txt'), 'ask', 'sess-A', true)
  check(
    '★ 工作目录外的普通文件：ask 档问一次、批准后能读（老路径不能坏）',
    askedOutside.asked === 1 && askedOutside.text.includes('outside'),
    `问了 ${askedOutside.asked} 次｜${askedOutside.text.slice(0, 70)}`,
  )

  /*
   * 只读档 ≠ 不问路径授权：它描述的是「能不能写」，工作目录**外**的读仍然要授权。
   * 这里要钉的是「别为了修 C-1 把只读档的路径询问也一起改掉」——
   * 老行为（问一次）必须保持原样。
   */
  reset()
  const readonlyOutside = await readWith(join(OUTSIDE, 'note.txt'), 'readonly', 'sess-A', true)
  check(
    '只读档读目录外的普通文件：仍然问一次（老行为不变）',
    readonlyOutside.asked === 1 && readonlyOutside.text.includes('outside'),
    `问了 ${readonlyOutside.asked} 次｜${readonlyOutside.text.slice(0, 70)}`,
  )

  /* ═══════════ ⑨ 一个回合里多个调用共用同一个 ctx ═══════════ */
  group('206 / ⑨ 同一 ctx 上的并发调用：不误放行、也不留下授权')

  /*
   * 真实链路里一个回合的工具调用共用**一个** ctx，`approvedPaths` 就挂在它上面
   * （`tools/permission.cjs` 的 retryOnce 在重试前后成对加删）。
   *
   * 这里只钉**一定成立**的性质，不钉「两个调用都一次成功」：并发时那份名单是
   * 同一个数组，先结束的调用会把路径 splice 掉，另一个可能因此被重新问一次 ——
   * 那是**更严**的方向（fail-closed），不是漏洞；拿它当判据只会造一条偶发红的测试。
   */
  reset()
  let sharedAsks = 0
  const sharedCtx = {
    workdir: SANDBOX,
    permission: 'ask',
    granted: new Map(),
    confirm: async () => {
      sharedAsks += 1
      return true
    },
  }
  const [readEnv, readOutsideEnv] = await Promise.all([
    tools.execute('read_file', { path: join(SANDBOX, '.env') }, sharedCtx),
    tools.execute('read_file', { path: join(OUTSIDE, '.env') }, sharedCtx),
  ])
  const hits = [readEnv, readOutsideEnv].filter((text) => String(text).includes(SECRET)).length
  check(
    '★ 并发下「读到」的次数不超过「问到」的次数（没有一条静默放行）',
    hits > 0 && hits <= sharedAsks,
    `问到 ${sharedAsks} 次｜读到 ${hits} 次`,
  )

  /* 最硬的那条：跑完之后同一个 ctx 上不能还留着能用的放行 */
  sharedAsks = 0
  sharedCtx.confirm = async () => {
    sharedAsks += 1
    return false
  }
  const reuse = String(await tools.execute('read_file', { path: join(SANDBOX, '.env') }, sharedCtx))
  check(
    '★ 并发跑完后不留可用授权（再读仍要问人，拒绝后读不到）',
    sharedAsks === 1 && !reuse.includes(SECRET),
    `又问了 ${sharedAsks} 次｜${reuse.split('\n')[0].slice(0, 60)}`,
  )
  check('★ 无身份调用的放行一条都没落盘', live().length === 0, `剩 ${live().length} 条`)

  /* 收尾：别把授权留给后面的组 */
  reset()
}
