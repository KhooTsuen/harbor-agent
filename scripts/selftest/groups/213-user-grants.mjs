/**
 * 自检 / 213 —— 「已经批过」跨轮次继续算数（最小必要打扰）
 *
 * 病（2026-11-06 真机现场，两次）：
 *   ① 用户在同一段话里**授权**改源码、又写验收标准「用户明确要求只分析、不修改」，
 *      明确短语命中 → 整轮 `allowWrite=false`（已在 153 组修掉）。
 *   ② 用户上一条「本轮明确授权修改相关源码、测试、规范」，下一条只说「我已重启好了」，
 *      `lastUserText` 换了内容 → `grantsWriteIn` 回到 false → **第一次覆盖老文件又被问了一遍**。
 *      用户看到的是：同一件事问了两遍。
 *
 * 本组只钉 ② 的修法（`user-grants.cjs`）：授权属于**会话**，不属于某一条消息。
 * 撤销只有一种 —— 他自己明确说停手 / 这轮只读。
 *
 * ⚠️ 判据不在这里重写：授权与停手都问 `user-constraints.cjs`（唯一真相源）。
 */
import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, disposeTasks, join, readFileSync, require, writeFileSync } from '../env.mjs'

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const U = require(join(ROOT, 'electron/core/user-constraints.cjs'))
const grants = require(join(ROOT, 'electron/core/user-grants.cjs'))
const gate = require(join(ROOT, 'electron/core/tools/pre-write-gate.cjs'))
/* ★ 造 ctx 走**生产那条路**（buildToolContext），不是手搓一个"差不多"的对象 ——
 *   否则「每轮都记一次授权」这条接线永远测不到（硬约束 9：形状只定义一处）。 */
const { buildToolContext } = require(join(ROOT, 'electron/core/loop-tool-context.cjs'))

const CFG = {
  tools: {
    permission: 'full',
    shellTimeout: 30000,
    shellPolicy: 'ask',
    fileScope: 'workdir',
    outputLimit: 20000,
  },
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  const created = []
  gate.reset()
  grants.resetSessionGrants()

  const GRANT_REAL =
    '本轮明确授权修改相关源码、测试、规范及必要的构建产物。可以正常使用 Shell、编辑文件、运行测试。'
  const NEXT_TURN = '我已重启好了'

  /** 造一条 running 任务；`text` 是这一轮的用户原话 */
  const makeTask = (goal, text) => {
    const t = taskCore.create({ goal, sessionId: 'selftest-user-grants' })
    created.push(t.id)
    return { taskId: t.id, text }
  }
  const ctxOf = (taskId, text) =>
    buildToolContext({
      options: { sessionId: 'selftest-user-grants', taskId },
      config: CFG,
      workdir: SANDBOX,
      mode: 'build',
      threadSettings: {},
      userText: text,
    })
  const askSwitches = { planFirst: false, clarifyFirst: true }
  const overwrite = { path: 'grant-exists.txt', oldText: '原来的内容', newText: '新的内容' }
  writeFileSync(join(SANDBOX, 'grant-exists.txt'), '原来的内容\n', 'utf8')

  /* ─────────── ① 授权那一轮：C 闸不问 ─────────── */
  group('213 / ① 授权那一轮 → 覆盖已有文件不拦')
  const t1 = makeTask('授权轮', GRANT_REAL)
  check(
    '★★ 授权原文 → 不拦（这就是真机上被多问一次的那条）',
    gate.check({ name: 'edit_file', args: overwrite, ctx: ctxOf(t1.taskId, GRANT_REAL), switches: askSwitches }) === '',
  )
  check('★ 授权确实被记进会话（否则下一轮又会问）', grants.sessionGranted('selftest-user-grants'))
  check(
    '★ 判据来自 user-constraints，不是这里另写一份',
    U.grantsWriteIn(GRANT_REAL) === true && U.grantsWriteIn(NEXT_TURN) === false,
  )

  /* ─────────── ② 下一轮只说「继续」→ 还算同一件事 ─────────── */
  group('213 / ② 下一轮只说「我已重启好了」→ 仍不重复问')
  gate.reset()
  const t2 = makeTask('续做轮', NEXT_TURN)
  check(
    '★★ 这一句本身没有授权词（对照组，证明判据真的换了来源）',
    U.grantsWriteIn(NEXT_TURN) === false,
  )
  check(
    '★★ 但 C 闸不拦 —— 会话里已经批过（用户心智里是同一件事）',
    gate.check({ name: 'edit_file', args: overwrite, ctx: ctxOf(t2.taskId, NEXT_TURN), switches: askSwitches }) === '',
  )

  /* ─────────── ③ 他说停手 → 授权立刻作废 ─────────── */
  group('213 / ③ 他说停手 / 只读 → 授权作废，该问还问')
  grants.noteGrant('selftest-user-grants', { stopped: U.noWriteIn('先别动，等我确认') })
  check('★ 「先别动」→ 会话授权被清掉', grants.sessionGranted('selftest-user-grants') === false)
  gate.reset()
  const t3 = makeTask('停手轮', NEXT_TURN)
  check(
    '★★ 清掉之后 C 闸重新拦（没有把闸门焊死在「永远放行」）',
    gate.check({ name: 'edit_file', args: overwrite, ctx: ctxOf(t3.taskId, NEXT_TURN), switches: askSwitches }).length > 0,
  )
  check(
    '★ 同一句话里又授权又说只读 → 按最保守的算（不授予）',
    (() => {
      grants.resetSessionGrants()
      const both = U.grantsWriteIn('我授权你改，但这一轮只分析，不修改')
      grants.noteGrant('mix-session', { granted: both, stopped: U.noWriteIn('但这一轮只分析，不修改') })
      return grants.sessionGranted('mix-session') === false
    })(),
  )

  /* ─────────── ④ 会话之间不串、空 id 不记 ─────────── */
  group('213 / ④ 不串台')
  grants.resetSessionGrants()
  grants.noteGrant('session-a', { granted: true })
  check('★★ 另一个会话拿不到这次授权', grants.sessionGranted('session-b') === false)
  check('★ 空 sessionId 不记（fail-closed，宁可不放行）', (() => {
    grants.noteGrant('', { granted: true })
    return grants.sessionGranted('') === false
  })())
  check(
    '★ 上限存在（长跑进程不会无限涨）',
    Number.isInteger(grants.SESSION_CAP) && grants.SESSION_CAP > 0,
  )

  /* ─────────── ⑤ 接线：真的挂在生产路径上 ─────────── */
  group('213 / ⑤ 接线')
  check(
    '★ 每轮都记一次（loop-tool-context 调了 noteGrant）',
    read('electron/core/loop-tool-context.cjs').includes('userGrants.noteGrant('),
  )
  check(
    '★ C 闸同时认「这一句」和「这个会话」',
    read('electron/core/tools/pre-write-gate.cjs').includes('grantsWriteIn(') &&
      read('electron/core/tools/pre-write-gate.cjs').includes('sessionGranted('),
  )
  check(
    '★ 授权判据只有一处（gate 里没有另写正则）',
    !/明确授权\|授权你/.test(read('electron/core/tools/pre-write-gate.cjs')),
  )
  check(
    '★ 记忆不落盘（这是执行内状态，重启清空是刻意的）',
    !/writeFileSync|fs\.write/.test(read('electron/core/user-grants.cjs')),
  )

  disposeTasks(created)
  gate.reset()
  grants.resetSessionGrants()
}
