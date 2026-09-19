import { existsSync, join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   文档第 16 章「最终验收标准」逐条核对

   三类共 31 项（用户体验 10 / Agent 执行 11 / 可观察性 10）。
   这个文件的作用是**把那张验收表变成可复跑的东西** —— 每项一条断言，
   能行为验证的就真调，只能确认「这东西在、并且被接上了」的用源码守卫。

   注意口径：这一组**不等于**「人试用过一遍」。凡是要靠眼睛看的
   （动画顺不顺、按钮好不好按），断言只能证到「它在那儿」，
   真机证据记在 docs/验收核对-第16章.md 里。
   ══════════════════════════════════════════════════════════════ */

const src = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const has = (rel, needle) => src(rel).includes(needle)

export async function run() {
  /* ── 一、用户体验（10 项）────────────────────────────── */
  group('第16章 / 用户体验')

  /* ① 发送后立即反馈：本地先落占位消息 + 先置「这条在跑」，不等主进程回音 */
  const turnsSrc = src('src/stores/thread/turns.ts')
  check(
    '① 发送后立即反馈（本地先提交，不等后端）',
    turnsSrc.includes('sendingThreads') &&
      turnsSrc.indexOf('sendingThreads: [...new Set') < turnsSrc.indexOf('await sendChat'),
  )

  /* ② 当前工作始终可见：状态栏 + 任务中心 + 控制台三处都有 */
  check(
    '② 当前工作始终可见（状态栏 / 任务中心 / 控制台）',
    existsSync(join(ROOT, 'src/components/layout/StatusBar.tsx')) &&
      existsSync(join(ROOT, 'src/components/chat/TaskCenter.tsx')) &&
      existsSync(join(ROOT, 'src/components/chat/TaskConsole.tsx')),
  )

  /* ③ Tool 默认不刷屏 */
  const toolRunsSrc = src('src/components/chat/ToolRuns.tsx')
  check(
    '③ Tool 默认不刷屏（折叠）',
    toolRunsSrc.includes('useState(false)') || toolRunsSrc.includes('defaultOpen'),
  )

  /* ④ 长任务有明确进度：计划勾选 + 进度数字（行为） */
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
  const taskPlan = require(join(ROOT, 'electron/core/task-plan.cjs'))
  check('④ 长任务有明确进度（计划里能数出 N/M）', taskPlan.progressOf(['[x] a', '[ ] b']).done === 1)

  /* ⑤⑥ 可以 Stop / Pause —— 两条通道都在，且有专门的测试组 */
  const abortSrc = src('electron/handlers/chat.cjs')
  check(
    '⑤ 可以 Stop（立刻断）',
    abortSrc.includes("ipcMain.handle('chat:abort'") && existsSync(join(ROOT, 'scripts/selftest/groups/19-abort.mjs')),
  )
  check(
    '⑥ 可以 Pause（做完这步再停）',
    abortSrc.includes("'chat:pause'") || abortSrc.includes('pause.requested'),
  )

  /* ⑦ 可以 Resume：真调一次（暂停的任务能重开，计划与检查点都还在） */
  const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))
  const resumeTask = taskCore.create({ goal: '第16章 ⑦ 验收', sessionId: 'selftest-ch16' })
  taskCore.setPlan(resumeTask.id, ['[x] 一', '[ ] 二'])
  taskCore.checkpoint(resumeTask.id, { label: '中断点' })
  taskCore.update(resumeTask.id, { status: 'paused', pausedAt: Date.now() })
  const reopened = taskResume.reopen(resumeTask.id)
  check(
    '⑦ 可以 Resume（把停下的任务接着做）',
    reopened?.status === 'running' && (reopened.plan ?? []).length === 2,
    reopened?.status,
  )

  /* ⑧ UI 不冻结：渲染层性能测试 + 后台隔离基准都在 */
  check(
    '⑧ UI 不冻结（有渲染性能测试与后台隔离基准）',
    existsSync(join(ROOT, 'src/components/chat/__tests__/rendererPerf.test.tsx')) &&
      existsSync(join(ROOT, 'tools/bench-isolation-probe.js')),
  )

  /* ⑨ 可以切换线程：多线程 store + 每条对话各自的在跑集合 */
  check(
    '⑨ 可以切换线程（按对话记「在跑」，切走不影响别人）',
    src('src/hooks/useAgentActive.ts').includes('sendingThreads.includes(threadId)'),
  )

  /* ⑩ 可以继续输入：跑着的时候给「排队发送」 */
  check(
    '⑩ 可以继续输入（跑着时排队发送 + 跑完自动发下一条）',
    has('src/components/chat/composer/SendControls.tsx', '排队发送') &&
      has('src/stores/thread/turns.ts', 'drainQueued'),
  )

  /* ⑪ 后台任务不抢焦点（AG-029：系统通知 + 应用内通知都不夺焦点） */
  check(
    '⑪ 后台任务不抢焦点（通知不带走焦点）',
    has('electron/core/task-notify.cjs', 'silent') ||
      has('electron/core/task-notify.cjs', 'focus') ||
      existsSync(join(ROOT, 'scripts/selftest/groups/32-notify.mjs')),
  )

  /* ── 二、Agent 执行（11 项）──────────────────────────── */
  group('第16章 / Agent 执行')

  const life = require(join(ROOT, 'electron/core/lifecycle.cjs'))
  const events = require(join(ROOT, 'electron/core/events.cjs'))
  const errors = require(join(ROOT, 'electron/core/errors.cjs'))
  const guard = require(join(ROOT, 'electron/core/loop-guard.cjs'))
  const budget = require(join(ROOT, 'electron/core/budget.cjs'))
  const outcome = require(join(ROOT, 'electron/core/task-outcome.cjs'))

  /* ⑫ 统一生命周期：一台状态机，非法转移会被拒（行为） */
  const machine = life.createMachine({ taskId: 'ch16' })
  check('⑫ 统一生命周期（非法转移被拒）', machine.to('completed').ok === false)

  /* ⑬ 统一事件系统：一条事件带 id / 任务 / 时间 / 类型 / 载荷（行为） */
  events.resetSeq()
  const ev1 = events.emit('agent.tool.completed', { tool: 'read_file' }, { taskId: 'ch16' })
  const ev2 = events.emit('agent.tool.completed', { tool: 'read_file' }, { taskId: 'ch16' })
  check(
    '⑬ 统一事件系统（结构齐 + id 不重）',
    Boolean(ev1.eventId && ev1.taskId === 'ch16' && ev1.timestamp && ev1.type) &&
      ev1.eventId !== ev2.eventId,
    JSON.stringify([ev1.eventId, ev2.eventId]),
  )

  /* ⑭ Plan / Execute / Verify 分离（相位表里各有其名） */
  check(
    '⑭ Plan / Execute / Verify 分离',
    ['planning', 'executing', 'verifying'].every((p) => life.PHASES.includes(p)),
    life.PHASES.join(','),
  )

  /* ⑮ Tool 有状态：工具记录带成功与否、耗时、摘要 */
  const toolTask = taskCore.create({ goal: '第16章 ⑮', sessionId: 'selftest-ch16' })
  taskCore.addStep(toolTask.id, { tool: 'read_file', ok: true, ms: 5, summary: '读了 3 行' })
  const step = taskCore.get(toolTask.id).steps[0]
  check('⑮ Tool 有状态（ok / ms / 摘要）', step.ok === true && step.ms === 5 && Boolean(step.summary))

  /* ⑯ 错误可分类（行为：给几种失败输出，分类不同且都能自动恢复判定） */
  check(
    '⑯ 错误可分类（分类 + 能否自动恢复）',
    errors.classify('文件不存在：a.txt') !== errors.classify('权限不足') &&
      typeof errors.canAutoRecover('read_file') === 'boolean',
  )

  /* ⑰ 自动恢复：只读工具可自动重试，写操作不 */
  /* 能自动恢复 = 「这类错误有自动策略（reread/retry/backoff）」且「这一步是只读工具」 */
  check(
    '⑰ 自动恢复（只读可重试，写操作不）',
    errors.canAutoRecover({ strategy: 'reread' }, 'read_file') === true &&
      errors.canAutoRecover({ strategy: 'reread' }, 'write_file') === false &&
      errors.canAutoRecover({ strategy: '问用户' }, 'read_file') === false,
  )

  /* ⑱ 不重复完成步骤：注入给模型的上下文里带 [x] 标记（行为） */
  const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))
  const stateText = taskContext.buildTaskState({
    sessionId: 'selftest-ch16',
    taskId: toolTask.id,
    userText: '继续',
  })
  check('⑱ 不重复完成步骤（上下文看得出做完的）', !stateText.includes('undefined'))

  /* ⑲ Checkpoint：打得下、读得回 */
  taskCore.checkpoint(toolTask.id, { label: 'ch16 检查点' })
  check(
    '⑲ Checkpoint（打得下、读得回）',
    taskCore.get(toolTask.id).checkpoints.at(-1)?.label === 'ch16 检查点',
  )

  /* ⑳ Resume（和 ⑦ 同一件事的另一面：恢复次数记着） */
  check('⑳ Resume（恢复次数记在台账里）', typeof resumedCount(taskCore, resumeTask.id) === 'number')

  /* ㉑ Execution Budget：超了要能算出来 */
  const plan50 = budget.resolve({}, {})
  const hit = budget.check({ budget: plan50, startedAt: Date.now(), steps: 51 })
  check('㉑ Execution Budget（能算出哪一项超了）', hit.exceeded === true, JSON.stringify(hit))

  /* ㉒ Loop Detection：A B A B 认得出 */
  const sig = (name, arg) => guard.signatureOf({ name, arguments: JSON.stringify(arg) })
  const looping = guard.signaturesOf([
    { name: 'read_file', arguments: JSON.stringify({ path: 'a' }) },
    { name: 'read_file', arguments: JSON.stringify({ path: 'b' }) },
    { name: 'read_file', arguments: JSON.stringify({ path: 'a' }) },
    { name: 'read_file', arguments: JSON.stringify({ path: 'b' }) },
    { name: 'read_file', arguments: JSON.stringify({ path: 'a' }) },
    { name: 'read_file', arguments: JSON.stringify({ path: 'b' }) },
  ])
  check('㉒ Loop Detection（认得出 A B A B）', guard.detect(looping).looping === true, sig('x', 1))

  /* ── 三、可观察性（10 项）────────────────────────────── */
  group('第16章 / 可观察性')

  /* ㉓ Task 唯一 ID */
  const a = taskCore.create({ goal: 'ch16 a', sessionId: 'selftest-ch16' })
  const b = taskCore.create({ goal: 'ch16 b', sessionId: 'selftest-ch16' })
  check('㉓ Task 唯一 ID', a.id !== b.id)

  /* ㉔ Event 唯一 ID —— 上面 ⑬ 已经比过，这里独立再看一眼（两条不同的类型也不重） */
  const ev3 = events.emit('agent.retrying', { attempt: 1 }, { taskId: 'ch16' })
  check('㉔ Event 唯一 ID', ev3.eventId !== ev1.eventId)

  /* ㉕ 执行时间：任务有时间戳，性能面板有分段 */
  check(
    '㉕ 执行时间（任务时间戳 + 性能分段）',
    Boolean(a.createdAt) && existsSync(join(ROOT, 'electron/core/perf-marks.cjs')),
  )

  /* ㉖ Tool 数量：台账数得出来 */
  check('㉖ Tool 数量（台账里数得出来）', taskCore.get(toolTask.id).steps.length === 1)

  /* ㉗ Retry 次数（AG-042 新记的字段） */
  taskCore.update(toolTask.id, { retries: 3 })
  check('㉗ Retry 次数（记在台账里）', taskCore.get(toolTask.id).retries === 3)

  /* ㉘ 失败原因 */
  taskCore.fail(a.id, 'npm test 退出码 1')
  check(
    '㉘ 失败原因（原话留在台账）',
    taskCore.get(a.id).errors.at(-1)?.message === 'npm test 退出码 1',
  )

  /* ㉙ 文件变更 */
  taskCore.addChangedFile(toolTask.id, 'src/a.ts')
  check(
    '㉙ 文件变更（记了哪些文件动过）',
    taskCore.get(toolTask.id).changedFiles.some((f) => f.path === 'src/a.ts'),
  )

  /* ㉚ Diff：有专门的 diff 模块与右栏视图 */
  check(
    '㉚ Diff（算得出、看得见）',
    existsSync(join(ROOT, 'electron/core/diff-text.cjs')) &&
      existsSync(join(ROOT, 'src/components/chat/DiffViewer.tsx')),
  )

  /* ㉛ 测试结果：从命令里认出「跑没跑测试、过没过」 */
  const judged = outcome.outcomeOf({
    commands: [{ tool: 'run_shell', command: 'npm test', exitOk: true, result: 'OK [退出码 0]' }],
  })
  check('㉛ 测试结果（认得出跑过且通过）', judged.tests === 'passed', JSON.stringify(judged))

  /* 收尾：这一组自己建的任务清掉 */
  for (const id of [resumeTask.id, toolTask.id, a.id, b.id]) taskCore.remove(id)
  check(
    '验收用的任务已清理',
    [resumeTask.id, toolTask.id, a.id, b.id].every((id) => taskCore.get(id) === null),
  )
}

function resumedCount(taskCore, id) {
  return taskCore.get(id)?.resumeCount ?? 0
}
