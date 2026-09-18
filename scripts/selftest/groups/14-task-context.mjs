import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/* ══════════════════════════════════════════════════════════════
   任务上下文（注入台账 / 完整性 / 完成门禁）

   这一组盯的是「模型知不知道任务进行到哪了」。以前 taskState 层一直空着
   （loop-prompt 里写着 options.taskState ?? '' 但没人传值），任务只活在
   界面上 —— 长对话里就是目标漂移。

   四条机制各自都有**必须成立的边界**，这里逐条钉：
     ① 注入：有计划就带上勾选状态，没勾完的能看出来
     ② 指纹：计划被绕过 setPlan 改掉后，注入时要报警
     ③ 门禁：没勾完就顶回去；但**顶够次数 / 进度连着不变必须放行**（防锁死）
     ④ 解析：parsePlan 要保留 [x] 标记（它只剥列表符号，不该吃掉状态）
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))
const paths = require(join(ROOT, 'electron/core/paths.cjs'))

export async function run() {
  /* ── ① 计划解析：复选框标记要留着 ────────────────────── */
  group('任务上下文 / 计划解析')
  const parsed = taskCore.parsePlan('```plan\n- [x] 读配置\n- [ ] 写代码\n- 没标记的\n```')
  check('解析出 3 条', parsed.length === 3)
  check('保留 [x] 标记', parsed[0] === '[x] 读配置')
  check('保留 [ ] 标记', parsed[1] === '[ ] 写代码')
  check('没标记的照旧', parsed[2] === '没标记的')

  /* ── ② 进度与指纹（纯函数）───────────────────────────── */
  group('任务上下文 / 进度与指纹')
  check('isDone 认小写 [x]', taskContext.isDone('[x] a'))
  check('isDone 认大写 [X]', taskContext.isDone('[X] a'))
  check('isDone 不认 [ ]', !taskContext.isDone('[ ] a'))
  check('isDone 不认无标记', !taskContext.isDone('a'))

  const prog = taskContext.progressOf(['[x] a', '[ ] b', 'c'])
  check('进度数对（1/3）', prog.done === 1 && prog.total === 3)
  check('空计划是 0/0', taskContext.progressOf([]).total === 0)
  check('null 不当炸', taskContext.progressOf(null).total === 0)

  const fp1 = taskContext.fingerprint(['[x] a', '[ ] b'])
  const fp2 = taskContext.fingerprint(['[x] a', '[ ] b'])
  const fp3 = taskContext.fingerprint(['[x] a', '[ ] c'])
  check('同样内容指纹一致', fp1 === fp2)
  check('内容变了指纹就变', fp1 !== fp3)

  /* ── ③ 建个真任务来测注入和门禁 ─────────────────────── */
  group('任务上下文 / 注入台账')
  const task = taskCore.create({ goal: '把配置读一遍', sessionId: 'selftest-task-context' })
  taskCore.setPlan(task.id, ['[ ] 读 package.json', '[ ] 读 tsconfig.json'])

  const text = taskContext.buildTaskState({
    sessionId: 'selftest-task-context',
    taskId: task.id,
  })
  check('台账里带上了任务标题', text.includes(task.title) || text.includes('把配置读一遍'))
  check('台账里列出了计划', text.includes('读 package.json'))
  check('台账里能看出没勾完（0/2）', text.includes('0/2'))
  check('台账里说了「接着第一条没 [x] 的做」', text.includes('没有 [x]'))

  check('指纹已随 setPlan 落盘', taskCore.get(task.id).planHash === fpFor(task.id))

  /* ── ④ 完成门禁：该拦的时候拦 ───────────────────────── */
  group('任务上下文 / 完成门禁')
  const g1 = taskContext.shouldContinue({ taskId: task.id, content: '好了，做完了', seen: {} })
  check('计划没勾完 → 顶回去', g1.continue === true)
  check('顶回去时说清下一条是什么', String(g1.message).includes('读 package.json'))
  check('顶回去时要求用 plan 块交回完整计划', String(g1.message).includes('plan'))

  /* 刹车一：顶够次数就放行（否则计划写错时会把会话锁死） */
  const g2 = taskContext.shouldContinue({
    taskId: task.id,
    content: '做完了',
    seen: { blocks: 3, snapshot: '' },
  })
  check('★ 顶够 3 次就放行（不锁死）', g2.continue === false)

  /* 刹车二：进度连着两轮没变 → 说明顶了也没用，放行 */
  const stalled = { blocks: 1, snapshot: g1.seen.snapshot }
  check(
    '★ 进度没变且已顶过一次 → 放行',
    taskContext.shouldContinue({
      taskId: task.id,
      content: '做完了',
      seen: stalled,
    }).continue === false,
  )

  /* 计划全勾完 → 不拦 */
  taskCore.setPlan(task.id, ['[x] 读 package.json', '[x] 读 tsconfig.json'])
  check(
    '计划全勾完 → 不拦',
    taskContext.shouldContinue({ taskId: task.id, seen: {} }).continue === false,
  )

  /* 任务不在了 / 不是 running → 不拦（不该拿别人的任务拦人） */
  check(
    '任务 id 不存在 → 不拦',
    taskContext.shouldContinue({ taskId: 'no-such-task', seen: {} }).continue === false,
  )

  taskCore.update(task.id, { status: 'paused' })
  check(
    '任务已暂停 → 不拦',
    taskContext.shouldContinue({ taskId: task.id, seen: {} }).continue === false,
  )

  /* ── ⑤ 完整性：绕过 setPlan 改掉计划要被抓到 ─────────── */
  group('任务上下文 / 计划完整性')
  taskCore.update(task.id, { status: 'running' })
  const file = path.join(paths.DIRS.data, 'tasks', `${task.id}.json`)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.plan = ['[ ] 有人偷偷塞进来的步骤']
  writeFileSync(file, JSON.stringify(raw), 'utf8')

  const tampered = taskContext.buildTaskState({
    sessionId: 'selftest-task-context',
    taskId: task.id,
  })
  check('★ 计划正文与指纹对不上时会警告', tampered.includes('与批准时不一致'))

  /* ── ⑥ 并行写保护：进度倒退要被看出来 ──────────────── */
  group('任务上下文 / 并行写保护')
  taskContext.resetProgressMemory()
  taskCore.setPlan(task.id, ['[x] 一', '[x] 二', '[ ] 三'])
  const first = taskContext.buildTaskState({ sessionId: 'selftest-task-context', taskId: task.id })
  check('第一轮不警告（没有可比的上轮）', !first.includes('另一个会话'))

  /* 模拟另一个会话把勾选改少了 */
  taskCore.setPlan(task.id, ['[x] 一', '[ ] 二', '[ ] 三'])
  const second = taskContext.buildTaskState({ sessionId: 'selftest-task-context', taskId: task.id })
  check('★ 进度倒退时警告「可能有另一个会话」', second.includes('另一个会话'))

  /* 进度正常前进则不警告 */
  taskContext.resetProgressMemory()
  taskContext.buildTaskState({ sessionId: 'selftest-task-context', taskId: task.id })
  taskCore.setPlan(task.id, ['[x] 一', '[x] 二', '[x] 三'])
  const third = taskContext.buildTaskState({ sessionId: 'selftest-task-context', taskId: task.id })
  check('进度前进时不警告', !third.includes('另一个会话'))

  /* ── 收尾：把测试任务清掉，别留在用户的任务目录里 ───── */
  taskCore.remove(task.id)
  check('测试任务已清理', taskCore.get(task.id) === null)

  /** 现读现算的指纹，用来验证 setPlan 真的落盘了 */
  function fpFor(id) {
    return taskContext.fingerprint(taskCore.get(id).plan)
  }
}
