import { join, readFileSync, writeFileSync, require, ROOT, SANDBOX, disposeTasks } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   重新生成（新功能）—— 主进程侧验收 c / d / f

 与渲染层的分工：那边管「点按钮之后怎么重跑」（regenerate.test.ts），
 这边管三件**只有内核能证明**的事：

   c. 文件副作用隔离：旧一轮的改动事务盖「被重新生成替代」标记，
      **不自动回滚**（要撤用户自己去审查面板整批撤 —— 隔离 ≠ 丢撤销能力）
   d. 预算不重置：旧任务烧到 80% → 新任务从 80% 接着算（轮数/工具/token 三项；
      挂钟时长不继承）
   f. 台账记录：新任务 `regeneratedFrom` 指向旧任务、`budgetCarry` 落盘 ——
      台账里是**两条**记录（复用旧任务就把两条抹成一条了，所以要新建）

 ★ 另外钉两个源码守位：loop.cjs 必须把 carry 递进查账、chat:send 必须透传
   regenerateOf/regenerateIsLast —— 谁把它们删了，预算/台账就会静默失灵。
   ══════════════════════════════════════════════════════════════ */

const budget = require(join(ROOT, 'electron/core/budget.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))
const taskRegen = require(join(ROOT, 'electron/core/task-regen.cjs'))
const changeset = require(join(ROOT, 'electron/core/changeset.cjs'))

export async function run() {
  const created = []
  const S = 'sess_regen_selftest'

  /* ── ① 旧任务与「继承基线」 ─────────────────────────── */
  group('重新生成 / 旧任务与继承基线')
  const taskA = taskCore.create({ goal: '先把清单整理出来', sessionId: S })
  created.push(taskA.id)
  /* 模拟烧到 80%：50 轮上限烧了 40 轮、10 万 token 烧了 8 万 */
  taskCore.update(taskA.id, { status: 'completed', tokens: 80000, turns: 40 })

  const prev = taskRegen.previousForSession(S)
  check('previousForSession 认得出「同一会话最近一条」', prev?.id === taskA.id)

  const carry = budget.carryOf(taskCore.get(taskA.id))
  check('carryOf：轮数 / token 接着数', carry?.steps === 40 && carry?.tokens === 80000)

  const carry2 = budget.carryOf({ turns: 12, tokens: 500, steps: [{}, {}, {}] })
  check('carryOf：工具调用数 = 台账 steps 条数', carry2?.toolCalls === 3)
  check('没消耗过 → null（调用方不用区分空对象）', budget.carryOf({ turns: 0, tokens: 0, steps: [] }) === null)

  /* ── ② 预算不重置（验收 d）──────────────────────────── */
  group('重新生成 / 预算不重置（验收 d）')
  const plan = budget.resolve({}, null)
  const at = (turn, extraCarry) =>
    budget.atTurnBoundary({ plan, startedAt: Date.now(), turn, toolRuns: [], usage: null, carry: extraCarry })

  const before = at(11, null)
  check('对照组（不带 carry）：11/50 还没到 —— 证明是 carry 把基线抬上去的', before.exceeded === false)
  const hit = at(11, carry)
  check(
    '★ 80% 起步：40 + 11 = 51 → 撞线（used 显示 51，不是 11、也没重置成 0）',
    hit.exceeded === true && hit.reason === 'maxSteps' && hit.used === 51,
  )
  check('没到线就不拦（40 + 9 = 49）', at(9, carry).exceeded === false)

  const tokenHit = budget.atTurnBoundary({
    plan,
    startedAt: Date.now(),
    turn: 0,
    toolRuns: [],
    usage: { total_tokens: 20000 },
    carry,
  })
  check(
    '★ token 也接着数：80000 + 20000 = 100000 撞线',
    tokenHit.exceeded === true && tokenHit.reason === 'maxTokens' && tokenHit.used === 100000,
  )
  check('没有 carry 时不加（老行为不变：49 不到线、50 到线）', at(49, null).exceeded === false && at(50, null).exceeded === true)

  /* ── ③ 台账两条记录（验收 f）────────────────────────── */
  group('重新生成 / 台账两条记录（验收 f）')
  const newTask = taskResume.openForRun({
    goal: '先把清单整理出来',
    sessionId: S,
    regenerateFrom: taskA.id,
    budgetCarry: carry,
  })
  created.push(newTask.id)
  check('新任务 regeneratedFrom 指向旧任务', newTask.regeneratedFrom === taskA.id)
  check('新任务是**另一条**（两条记录，不是复用旧任务）', newTask.id !== taskA.id)
  check('继承基线落进新任务台账', newTask.budgetCarry?.tokens === 80000 && newTask.budgetCarry?.steps === 40)
  const reread = taskCore.get(newTask.id)
  check('重读台账：regeneratedFrom 真的写进了文件', reread?.regeneratedFrom === taskA.id)

  /* 接回守卫：同一会话里有「等回话」的任务，普通发送会被接回；
     重新生成**必须新建**（否则两条记录被抹成一条） */
  const S2 = 'sess_regen_selftest2'
  const waiting = taskCore.create({ goal: '等你确认', sessionId: S2 })
  created.push(waiting.id)
  taskCore.update(waiting.id, { status: 'waiting_user' })
  const attached = taskResume.openForRun({ goal: '随便说点什么', sessionId: S2 })
  check('对照组：waiting_user 的活会被接回（既有行为）', attached.id === waiting.id)
  const regenTask = taskResume.openForRun({ goal: '同一句话', sessionId: S2, regenerateFrom: waiting.id })
  created.push(regenTask.id)
  check('★ 重新生成必须新建（不接回旧任务）', regenTask.id !== waiting.id && regenTask.regeneratedFrom === waiting.id)

  /* ── ④ 文件副作用隔离（验收 c）──────────────────────── */
  group('重新生成 / 文件副作用隔离（验收 c）')
  const cs = changeset.begin({ taskId: taskA.id, sessionId: S, title: '旧一轮' })
  check('旧一轮有独立的改动事务', cs.ok === true)
  const tmpFile = join(SANDBOX, 'regen-touch.txt')
  writeFileSync(tmpFile, 'before')
  changeset.record(cs.id, tmpFile)
  writeFileSync(tmpFile, 'after')

  const linked = taskRegen.link(taskCore.get(taskA.id), newTask.id)
  check('link 找到旧事务并盖标记', linked.changeSetId === cs.id)
  const meta = changeset.get(cs.id)
  check('★ 事务 meta 有 supersededBy（指向新任务）', meta?.supersededBy === newTask.id)
  check('旧任务台账也标了 supersededBy', taskCore.get(taskA.id).supersededBy === newTask.id)
  check('★ 文件保持改动后的状态 —— 不自动回滚（要撤自己撤）', readFileSync(tmpFile, 'utf8') === 'after')
  const rb = changeset.rollback(cs.id)
  check(
    '隔离 ≠ 丢撤销能力：手动整批回滚仍可用',
    rb.ok === true && readFileSync(tmpFile, 'utf8') === 'before',
  )

  /* ── ⑤ 源码守位：删了这两处，预算 / 台账会静默失灵 ──── */
  group('重新生成 / 源码守位')
  const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
  check('★ loop.cjs 把 carry 递进轮次边界查账', loopSrc.includes('usage: totalUsage, carry'))
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check('chat:send 透传 regenerateOf', chatSrc.includes('payload?.regenerateOf'))
  check('chat:send 透传 regenerateIsLast', chatSrc.includes('payload?.regenerateIsLast'))
  const mrSrc = readFileSync(join(ROOT, 'src/stores/thread/messageVersions.ts'), 'utf8')
  check('渲染层把 regeneratedFrom 交给这一轮', mrSrc.includes('extra.regeneratedFrom'))

  /* 收尾：别把任务残留在真实 data/tasks 里 */
  try {
    disposeTasks(created)
  } catch {
    /* 环境里没有 disposeTasks 的路径就直接删（自检沙箱会整体清） */
  }
}
