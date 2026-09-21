import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   重启时清扫「还标着在跑」的任务

   用户报的现象：「任务跑着的时候进程被中断，再打开时那个进行中的对话没保留」。
   实测复现（假上游 + 硬杀进程）后，磁盘上是这样：

     会话文件：… user「把 README 的安装步骤改一下」（助手那条完全没有）
     任务文件：status=running

   第二行是会卡死人的那条：**能「接着做」的状态只有 paused / waiting_user**，
   而 will-quit 只在**优雅退出**时跑 —— 进程被强杀/崩溃时它根本不会执行，
   任务就永远停在 running：看得见、点不了继续。

   所以要在**启动时**扫一遍上一轮的遗留。应用是单实例，启动时不可能真的有
   循环在跑，全部标暂停是安全的。
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')
/** 剥掉注释再扫 —— 注释里的字不算命中（这个项目踩过好几次） */
const codeOnly = (rel) =>
  readCore(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

export async function run() {
  group('重启清扫：还标着「在跑」的任务会被标成暂停（可续做）')

  const created = []
  const make = (goal) => {
    const t = taskCore.create({ goal, sessionId: 'sess-interrupted', workdir: ROOT })
    created.push(t.id)
    return t
  }

  /* 造三条：一条 running、一条 waiting_user、一条已暂停（不该被二次改动） */
  const running = make('跑到一半被强杀')
  taskCore.update(running.id, { status: 'running' })
  const waiting = make('等着回话时被强杀')
  taskCore.update(waiting.id, { status: 'waiting_user' })
  const done = make('已经做完的')
  taskCore.finish(done.id, { status: 'completed', result: '做完了' })
  const pausedBefore = taskCore.get(done.id).updatedAt

  const swept = taskCore.pauseRunning('startup')

  /* ── 扫成了什么 ── */
  const afterRunning = taskCore.get(running.id)
  const afterWaiting = taskCore.get(waiting.id)
  check('running → paused', afterRunning.status === 'paused')
  check(
    '★ 记下「是上次被中断的」（界面要拿它说一句，不然用户以为任务自己停了）',
    afterRunning.pauseReason === 'interrupted',
  )
  check('pausedAt 有值', afterRunning.pausedAt > 0)
  check('waiting_user 也扫（进程都没了，那个「在等」早就是假的）', afterWaiting.status === 'paused')

  /* ── 不该动的别动 ── */
  const afterDone = taskCore.get(done.id)
  check('已完成的不受打扰', afterDone.status === 'completed')
  check('★ 连 updatedAt 都没变（没被顺手重写）', afterDone.updatedAt === pausedBefore)
  check('返回值只说扫了几条，不改别的', swept.ok === true && typeof swept.paused === 'number')

  /* ── 这才是用户看得见的结果：能点「继续」了 ── */
  check('★ 清扫后 canResume 为真（这条就是用户卡住的地方）', taskResume.canResume(running.id) === true)

  /* ── 接线：主进程启动时必须调，而且要在建窗口之前 ── */
  const main = codeOnly('electron/main.cjs')
  const cleanup = codeOnly('electron/boot-cleanup.cjs')
  check('★ 启动时调了清扫（搬到 boot-cleanup 里了，这里只看调没调）', /bootCleanup\.sweepStaleTasks\(\)/.test(main))
  check(
    '★ 而且紧挨着建窗口之前（否则第一次渲染出来的还是「在跑」）',
    main.slice(main.indexOf('sweepStaleTasks()'), main.indexOf('sweepStaleTasks()') + 400).includes('createWindow()'),
  )
  check('清扫那条真的调了 pauseRunning（不是个空壳）', /pauseRunning\('startup'\)/.test(cleanup))
  check('退出时那条路还在（优雅退出也要标）', /pauseRunning\(\)/.test(cleanup))

  /* ── 收尾 ── */
  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
