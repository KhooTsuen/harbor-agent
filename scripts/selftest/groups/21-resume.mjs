import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-011：Pause / Resume

   文档要的两件事：
     Pause  —— 完成当前安全操作 → 不启动下一步 → 保存状态 → PAUSED
     Resume —— 读 Task State → 验证环境 → 从当前步骤继续

   这里钉三件最容易写错的事：

     ① **恢复必须复用同一条任务**（`openForRun`）——
        「不重复已完成步骤」不是靠什么记忆机制，而是因为 steps / plan
        都还在那条记录里，`task-context` 会把「计划里第一条没打 [x] 的」
        注入提示。新建一条 = 把这些全丢掉 = 真的会从头再来。

     ② **环境检查的判据是 mtime 晚于任务的 updatedAt** ——
        任务一暂停就不再更新，所以「比它还新」就等于「Agent 撒手之后
        有人动过」。文件消失也算变了（那更得先看一眼）。

     ③ **任何活跃态都能暂停** —— 用户点暂停时 Agent 可能卡在链条的任何
        一环上，不该因为「刚好在 thinking」就被拒绝。
   ══════════════════════════════════════════════════════════════ */

const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const life = require(join(ROOT, 'electron/core/lifecycle.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('AG-011 · 暂停 / 恢复')

  const created = []
  const make = (goal) => {
    const t = taskCore.create({ goal, sessionId: 'sess-resume-test', workdir: ROOT })
    created.push(t.id)
    return t
  }

  /* ── canResume ────────────────────────────────────────── */
  const task = make('恢复测试用的任务')
  taskCore.update(task.id, { status: 'paused' })
  check('paused 的任务可以恢复', taskResume.canResume(task.id) === true)
  check('不存在的任务不能恢复', taskResume.canResume('task_不存在') === false)
  taskCore.update(task.id, { status: 'completed' })
  check('已完成的任务不给恢复', taskResume.canResume(task.id) === false)

  /* ── reopen：复用同一条，不新建 ───────────────────────── */
  taskCore.update(task.id, { status: 'paused' })
  const reopened = taskResume.reopen(task.id)
  check('★ reopen 返回的是**同一条**任务（不是新建）', reopened?.id === task.id)
  check('reopen 把状态改回 running', taskCore.get(task.id)?.status === 'running')

  /* ── openForRun：带 resumeTaskId 就复用 ───────────────── */
  taskCore.update(task.id, { status: 'paused' })
  const resumed = taskResume.openForRun({ resumeTaskId: task.id, goal: 'x', sessionId: 's' })
  check('★ openForRun 带 id 时复用原任务', resumed.id === task.id)
  check('复用后状态是 running', taskCore.get(task.id)?.status === 'running')

  const fresh = taskResume.openForRun({ goal: '全新任务', sessionId: 's', workdir: ROOT })
  created.push(fresh.id)
  check('不带 id 时新建一条', fresh.id !== task.id)
  check('新建的任务是 running', fresh.status === 'running')

  const bogus = taskResume.openForRun({ resumeTaskId: 'task_不存在', goal: 'g', sessionId: 's' })
  created.push(bogus.id)
  check('id 指向不存在的任务时退回新建（不炸）', bogus.id !== 'task_不存在')

  /* ── 环境检查 ─────────────────────────────────────────── */
  taskCore.update(task.id, { status: 'paused' })
  const dir = join(ROOT, 'data', 'selftest-workspace')
  const file = join(dir, 'resume-env-check.txt')
  writeFileSync(file, 'x')
  taskCore.addChangedFile(task.id, file)

  check('刚改过的文件不算「变过」', taskResume.checkEnvironment(task.id).changed.length === 0)

  /* 把 mtime 推到未来 —— 等价于「Agent 停手之后有人又动了它」
     （要注意容差：task-resume 留了 2 秒余量，Windows 刚写完的文件 mtime
      可能晚到，所以这里推得远远超出容差） */
  const future = new Date(Date.now() + 120_000)
  utimesSync(file, future, future)
  check('★ 停手后文件被改过 → 报出来', taskResume.checkEnvironment(task.id).changed.includes(file))

  rmSync(file, { force: true })
  check(
    '文件消失也算变了（更得先看一眼）',
    taskResume.checkEnvironment(task.id).changed.includes(file),
  )

  /* ── 状态机：活跃态都能进 paused ─────────────────────── */
  for (const from of [
    'preparing',
    'thinking',
    'planning',
    'executing',
    'verifying',
    'responding',
  ]) {
    check(`${from} → paused 是合法转移`, life.canTransition(from, 'paused') === true)
  }
  check('idle 不该能「暂停」（还没有任务）', life.canTransition('idle', 'paused') === false)
  check('终态不给暂停', life.canTransition('completed', 'paused') === false)
  check('paused 自己转自己也不合法', life.canTransition('paused', 'paused') === false)
  check('paused 可以回到 executing（恢复）', life.canTransition('paused', 'executing') === true)

  /* ── 源码守卫 ─────────────────────────────────────────── */
  const loopSrc = readCore('electron/core/loop.cjs')
  check('loop 每轮开头查暂停请求', loopSrc.includes('options.controls?.pauseRequested?.()'))
  check('暂停点会标相位 paused', loopSrc.includes("life.mark('paused'"))
  check('暂停走 pausedResult（和正常返回同形）', loopSrc.includes('pausedResult({'))
  check('暂停/轮数用尽都算「没干完」', loopSrc.includes('result.exhausted || result.paused'))
  /* 暂停必须发生在**工具执行完之后**（每轮开头），不能在工具中间打断 */
  check(
    '★ 暂停检查在循环开头（上一轮工具已跑完才是安全点）',
    loopSrc.indexOf('options.controls?.pauseRequested?.()') < loopSrc.indexOf('executeToolCalls({'),
  )

  const chatSrc = readCore('electron/handlers/chat.cjs')
  check('chat.cjs 有 chat:pause 通道', chatSrc.includes("ipcMain.handle('chat:pause'"))
  check('pause 只置标记，不 abort（两件事）', chatSrc.includes('entry.pause.requested = true'))
  check('abort 仍然 abort', chatSrc.includes('entry.controller.abort()'))
  check('resumeTaskId 透传给循环', chatSrc.includes('resumeTaskId:'))

  const resumeSrc = readCore('electron/core/task-resume.cjs')
  check('task-resume 用 mtime 判环境变化', resumeSrc.includes('.mtimeMs >'))

  const contextSrc = readCore('electron/core/task-context.cjs')
  check('★ 环境变化会注入提示给模型', contextSrc.includes('checkEnvironment(task.id)'))

  /* AG-011：按钮抽到了 composer/SendControls.tsx */
  const sendControls = readCore('src/components/chat/composer/SendControls.tsx')
  check('SendControls 有暂停按钮', sendControls.includes('label="暂停生成"'))
  check('暂停和停止是两个按钮', sendControls.includes('label="停止生成"'))
  check('Composer 用上了它', readCore('src/components/chat/Composer.tsx').includes('<SendControls'))

  const preloadSrc = readCore('electron/preload.cjs')
  check('preload 暴露 pauseChat', preloadSrc.includes('pauseChat:'))
  check('preload 的通道名对得上', preloadSrc.includes("invoke('chat:pause'"))

  /* ── 收尾 ─────────────────────────────────────────────── */
  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
