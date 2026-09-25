import { join, readFileSync, require, ROOT, disposeTasks } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   任务隔离：任务状态严格绑定会话（sessionId）

   用户报的 bug：A 里的任务中断后，新建 / 切到 B —— B 会「继续执行 A 的任务」，
   像任务状态是全局共享的。

   真根因（本组 ① 复现的那个）：`task-context.cjs` 的 `buildTaskState` ——
   它把**其他会话**的未完成任务也兜底塞进提示（"当前会话优先 + 全局还开着的"），
   于是 B 每一轮的提示里都带着 A 的任务台账和「接着第一条没 [x] 的往下做」的
   指令，模型在 B 里就干起了 A 的活。

   本组把「严格隔离」的每一层都钉死（对应验收 a/c/d/e/f 的内核侧）：
     ① 上下文注入：只看本会话（没有 sessionId 也不许兜底全局）
     ② 恢复守卫：别的会话说「继续」也接不回本会话的任务
     ③ 检查点：随任务走，不串会话
     ④ 启动扫描：纯读，不改状态、不恢复
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))
const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))
const taskRecovery = require(join(ROOT, 'electron/core/task-recovery.cjs'))
const taskRegen = require(join(ROOT, 'electron/core/task-regen.cjs'))
const paths = require(join(ROOT, 'electron/core/paths.cjs'))

export async function run() {
  const created = []
  const A = 'sess_iso_A'
  const B = 'sess_iso_B'

  /* ── ① 上下文注入：只看本会话（验收 a / f）─────────── */
  group('任务隔离 / 上下文注入只看本会话')
  const ta = taskCore.create({ goal: 'A 会话的调研任务', sessionId: A })
  created.push(ta.id)
  taskCore.setPlan(ta.id, ['[x] 第一步', '[ ] 第二步（读 secret-plan.txt）'])
  taskCore.addStep(ta.id, { tool: 'read_file', ok: true, ms: 3, summary: '读了 A 的文件' })
  taskCore.update(ta.id, { status: 'paused', pausedAt: Date.now() })

  const forB = taskContext.buildTaskState({ sessionId: B, userText: '你好，看看这个新项目' })
  check('★ B 的上下文里不出现 A 的任务名', !forB.includes('A 会话的调研任务'))
  check('★ 不出现 A 的计划行（含会话私有文件名）', !forB.includes('secret-plan.txt'))
  check('★ 不出现 A 的脚印（最近一步）', !forB.includes('读了 A 的文件'))
  check('★ B 走「新活第一轮」的说法，不背别人的台账', forB.includes('本轮请求'))

  const forA = taskContext.buildTaskState({ sessionId: A, taskId: ta.id, userText: '继续' })
  check(
    '同会话仍能看见（A 的任务在 A 里注入）',
    forA.includes('A 会话的调研任务') && forA.includes('secret-plan.txt'),
  )
  check('A 里「继续」被说死为接着做', forA.includes('接着做'))

  const noSess = taskContext.buildTaskState({ userText: '随便说点什么' })
  check('★ 不带 sessionId 不注入任何任务（不许兜底全局）', !noSess.includes('A 会话的调研任务'))

  /* ── ② 恢复守卫：只接本会话（验收 c / d）───────────── */
  group('任务隔离 / 恢复只认本会话')
  check('A 的 paused 任务可恢复（入口还在）', taskResume.canResume(ta.id) === true)
  check(
    '★ 在 B 说「继续」也接不回 A 的任务',
    taskResume.activeForSession(B, { continueIntent: true }) === null,
  )
  check(
    '在 A 说「继续」才接得回',
    taskResume.activeForSession(A, { continueIntent: true })?.id === ta.id,
  )

  const tb = taskResume.openForRun({ goal: 'B 的新活', sessionId: B })
  created.push(tb.id)
  check('B 新建的是自己的任务', tb.sessionId === B && tb.id !== ta.id && tb.status === 'running')
  check('★ A 的任务状态没被动过（还停在 paused）', taskCore.get(ta.id).status === 'paused')

  check(
    '台账索引按会话隔离（B 查不到 A 的）',
    taskCore.list({ sessionId: B }).every((t) => t.sessionId === B) &&
      !taskCore.list({ sessionId: B }).some((t) => t.id === ta.id),
  )
  check(
    '★ 重新生成找「上一轮」也只在会话内找',
    (taskRegen.previousForSession(B)?.sessionId ?? B) === B &&
      taskRegen.previousForSession(B)?.id !== ta.id,
  )

  /* ── ③ 检查点随任务走（验收 f）──────────────────────── */
  group('任务隔离 / 检查点不串会话')
  taskCore.checkpoint(ta.id, { label: 'A 的检查点', note: '只在 A' })
  const stateB2 = taskContext.buildTaskState({ sessionId: B, userText: '继续' })
  check('★ B 的上下文里不出现 A 的检查点', !stateB2.includes('A 的检查点'))
  check('检查点在 A 自己的台账里', taskCore.get(ta.id).checkpoints.at(-1)?.label === 'A 的检查点')
  check('B 的台账里没有它', (taskCore.get(tb.id).checkpoints ?? []).length === 0)

  /* ── ④ 启动扫描纯读（验收 e）────────────────────────── */
  group('任务隔离 / 启动扫描是只读的')
  const file = join(paths.DIRS.data, 'tasks', `${ta.id}.json`)
  const before = readFileSync(file, 'utf8')
  const scanned = taskRecovery.scan()
  const after = readFileSync(file, 'utf8')
  check(
    '恢复清单还能列出它（功能没丢）',
    scanned.some((t) => t.id === ta.id),
  )
  check('★ 扫描不改台账文件（纯读）', before === after)
  check('★ 扫描之后仍是 paused（没有偷偷恢复）', taskCore.get(ta.id).status === 'paused')

  const runningB = taskCore.create({ goal: '重启时还在跑的任务', sessionId: B })
  created.push(runningB.id)
  taskCore.pauseRunning('startup')
  check('重启：running → paused（防卡死）', taskCore.get(runningB.id).status === 'paused')
  check(
    '★ 重启：本来就 paused 的不动、不自动恢复',
    taskCore.get(ta.id).status === 'paused' && (taskCore.get(ta.id).resumeCount ?? 0) === 0,
  )

  /* ── ⑤ 完成门禁只认自己的任务 ──────────────────────── */
  group('任务隔离 / 门禁只认自己的任务')
  check(
    'B 的新任务没计划 → 不拦',
    taskContext.shouldContinue({ taskId: tb.id, content: 'done', seen: {} }).continue === false,
  )
  taskCore.update(ta.id, { status: 'running' })
  check(
    'A 自己的没勾完计划仍然拦 A（隔离不是把门禁关掉）',
    taskContext.shouldContinue({ taskId: ta.id, content: 'done', seen: {} }).continue === true,
  )
  taskCore.update(ta.id, { status: 'paused' })

  /* 收尾：别把任务残留在真实 data/tasks 里 */
  disposeTasks(created)
}
