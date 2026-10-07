import { join, require, ROOT } from '../env.mjs'
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
}
