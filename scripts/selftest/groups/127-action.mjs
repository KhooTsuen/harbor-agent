import { join, require, ROOT, taskCore } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   P0-3：Action 组装（`core/action.cjs`）

   这一组钉两件事：
     ① 形状：一次工具调用的「危险度 / 规模 / 可逆性 / 范围」能从一个对象里问出来；
     ② ★ **不重判**：Action 的每个字段都和**现成的那个家**逐字一致
        （risk.classify / scale.inspect / task-intent.isReplayUnsafe）——
        组合层又抄一份判据，就是这个项目最忌的「同一件事写两份」（硬约束 9）。

   ⚠️ Action 现在**还没有接入内核**（接入点在 tool-runner，见 4.2 接入设计）；
      这一组只保证「组装本身对」。接入那一步要真机验证。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const action = require(join(ROOT, 'electron/core/action.cjs'))
  const risk = require(join(ROOT, 'electron/core/risk.cjs'))
  const scale = require(join(ROOT, 'electron/core/scale.cjs'))

  group('P0-3 / Action 组装：命令行（危险 + 有副作用）')
  const cmd = 'rm -rf /'
  const shell = action.of({ name: 'run_shell', args: { command: cmd } })
  check('tool / command 带上了', shell.tool === 'run_shell' && shell.command === cmd)
  check('★ 危险度与 risk.classify 一致（不重判）', shell.risk?.level === risk.classify(cmd).level, JSON.stringify(shell.risk))
  check('★ 危险等级是 critical（递归删盘根）', shell.risk?.level === 'critical', shell.risk?.level)
  check('★ 可逆性来自 REPLAY_UNSAFE（run_shell = unsafe）', shell.reversibility === 'unsafe')

  group('P0-3 / Action 组装：只读工具（无风险、无规模、可重跑）')
  const read = action.of({ name: 'read_file', args: { path: 'a.txt' } })
  check('非 shell 交 risk = null（不硬套命令判据）', read.risk === null)
  check('规模 ok（一次一个目标）', read.scale.level === 'ok')
  check('可逆（读操作重跑没事）', read.reversibility === 'safe')

  group('P0-3 / Action 组装：list_dir 递归算规模')
  const dir = action.of({ name: 'list_dir', args: { path: '.', depth: 3 } })
  check('★ 规模等级与 scale.inspect 一致（不重判）', dir.scale.level === scale.inspect({ name: 'list_dir', args: { path: '.', depth: 3 } }).level, dir.scale.level)
  check('递归目录不该是 ok', dir.scale.level !== 'ok', dir.scale.level)
  check('scope 有值', typeof dir.scope === 'string' && dir.scope.length > 0)

  group('P0-3 / describe：给人看的一句话')
  check('危险操作的话里有「危险」', /危险/.test(action.describe(shell)), action.describe(shell))
  check('有副作用的会说出来', /副作用/.test(action.describe(shell)))
  check('只读工具兜底「普通操作」', action.describe(read) === '普通操作', action.describe(read))

  group('P0-3 / fail-safe：空输入不崩')
  const empty = action.of()
  check('of() 无参不抛，返回对象', empty != null && empty.tool === '' && empty.risk === null)
  check('describe(undefined) 不抛、给兜底话', typeof action.describe(undefined) === 'string')

  group('P0-3 / 接入：agent.tool.started 事件带上 action（真跑一次执行器）')
  const { executeToolCalls } = require(join(ROOT, 'electron/core/tool-runner.cjs'))
  const events = []
  const messages = []
  try {
    await executeToolCalls({
      toolCalls: [
        { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: '不存在的文件-xyz.txt' }) },
      ],
      ctx: { workdir: ROOT, sessionId: 'selftest-action', taskId: '' },
      /* history 用来验「用户原话」口径（规模豁免看它）—— 这里只走通链路 */
      options: { history: [{ role: 'user', content: '读一下这个文件' }] },
      messages,
      toolRuns: [],
      emit: (event) => events.push(event),
      turn: 0,
    })
  } catch {
    /* 工具本身可能抛（文件不存在等）—— 不影响**已经发出**的 started 事件 */
  }
  const started = events.find((event) => event.type === 'agent.tool.started')
  check(
    '★ started 事件真的带上了 action（渲染层 / 诊断一眼看得到这次调用的危险度与规模）',
    started?.action != null && started.action.tool === 'read_file',
    JSON.stringify(started?.action ?? null).slice(0, 120),
  )
  check(
    '★ action 的形状对（risk / scale / reversibility 都在）',
    started?.action != null &&
      'risk' in started.action &&
      typeof started.action.scale?.level === 'string' &&
      typeof started.action.reversibility === 'string',
    JSON.stringify(started?.action ?? null).slice(0, 120),
  )
  check(
    '只读工具：risk 为 null、reversibility 为 safe',
    started?.action?.risk === null && started?.action?.reversibility === 'safe',
  )

  group('P0-3 / 落盘：step.action（只加字段，旧台账照读 · 硬禁区 3）')
  const t = taskCore.create({ goal: 'action 落盘自检', sessionId: 'selftest-action-store' })
  taskCore.addStep(t.id, {
    tool: 'run_shell',
    ok: true,
    summary: 'x',
    action: action.of({ name: 'run_shell', args: { command: 'rm -rf /' } }),
  })
  const withAction = (taskCore.get(t.id)?.steps ?? [])[0]
  check(
    '★ 落盘的 step 带上了 action（危险度可查：critical）',
    withAction?.action?.risk?.level === 'critical',
    JSON.stringify(withAction?.action ?? null).slice(0, 140),
  )
  check(
    '★ 落盘的 action **不含命令原文**（免得新开一处泄密面）',
    withAction?.action != null && !('command' in withAction.action),
  )
  check(
    '可逆性也落了（run_shell = unsafe）',
    withAction?.action?.reversibility === 'unsafe',
  )

  /* ★ 只加不换：没传 action 的老写法，step 里**根本不出现** action 这个键 */
  taskCore.addStep(t.id, { tool: 'read_file', ok: true, summary: 'y' })
  const withoutAction = (taskCore.get(t.id)?.steps ?? [])[1]
  check(
    '★ 老形状一字不变：没传 action 的 step 就没有 action 字段（旧台账照读）',
    withoutAction != null && !('action' in withoutAction),
    JSON.stringify(withoutAction ?? null).slice(0, 100),
  )
  check('步骤本身还在（只为验证没有把老字段挤掉）', withoutAction?.tool === 'read_file' && withoutAction?.ok === true)
}
