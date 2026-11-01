/**
 * 自检 / P0-3 任务归属只判一次 + P0-4 记忆可见性同一套规则（2026-10-23）
 *
 *   · P0-3：以前同一个问题被决定了三次 —— `chat-run` 按 `payload.taskId` 生成提示、
 *           `loop-run` 自己算 `continueIntent`、`task-resume` 又照 `activeForSession`
 *           写一遍。于是提示说「你在做 A」、台账却新建了 B。
 *           现在只有一处：`core/task-attribution.cjs`。
 *   · P0-4：自动注入按 sessionId 过滤，模型侧 `memory_search` 只按 projectId 过滤 ——
 *           从 B 会话能搜到 A 会话的私事，而注入路径拦着。
 *           现在只有一处：`core/memory-scope.cjs`。
 *
 * 断言全部是**真跑**（不只看源码里有没有那行字）：
 *   · 归属：五种情形各跑一次 `decide()`，再核 `openForRun` 的动作与结论一致；
 *   · 记忆：A/B 两个会话 + 甲/乙两个项目，四种作用域交叉搜一遍。
 */

import { check, group } from '../harness.mjs'
import { join, memory, readFileSync, require, ROOT, taskCore, tools } from '../env.mjs'

const attribution = require(join(ROOT, 'electron/core/task-attribution.cjs'))
const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))
const scope = require(join(ROOT, 'electron/core/memory-scope.cjs'))

export async function run() {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
  const created = []
  const spill = []
  const newTask = (goal, sessionId) => {
    const task = taskCore.create({ goal, sessionId })
    created.push(task.id)
    return taskCore.get(task.id)
  }

  group('P0-3 / decide()：五种情形')
  const S = 'selftest-p03-main'
  check('没有会话上下文 → 新建（不兜底别人的台账）', attribution.decide({ goal: '随便' }).kind === 'new')
  check(
    '同会话干净 → 新建（reason=fresh）',
    attribution.decide({ sessionId: S, goal: '写个快排' }).reason === 'fresh',
  )

  const paused = newTask('停下的活', S)
  taskCore.update(paused.id, { status: 'paused' })
  check(
    '★ paused + 没说继续 → 新建（不凭猜测接回）',
    attribution.decide({ sessionId: S, goal: '另外问个事' }).kind === 'new',
  )
  const cont = attribution.decide({ sessionId: S, goal: '继续' })
  check('★ paused + 明确说继续 → resume 那条', cont.kind === 'resume' && cont.taskId === paused.id, JSON.stringify(cont))
  check('「继续」被认出来（与 task-steering 同一处正则）', cont.continueIntent === true)
  check(
    '显式 resumeTaskId → resume（点「继续」那条路）',
    attribution.decide({ resumeTaskId: paused.id, sessionId: S, goal: '随便' }).kind === 'resume',
  )
  check(
    '显式指向一条已完成的 → 新建，理由说清',
    (() => {
      const done = newTask('干完了', S)
      taskCore.finish(done.id, { status: 'completed', result: 'ok' })
      const d = attribution.decide({ resumeTaskId: done.id, sessionId: S })
      return d.kind === 'new' && d.reason === 'explicit-completed'
    })(),
  )

  const SW = 'selftest-p03-waiting'
  const waiting = newTask('等你回话', SW)
  taskCore.update(waiting.id, { status: 'waiting_user' })
  const vague = attribution.decide({ sessionId: SW, goal: '换个思路，先做第二步' })
  check(
    '★★ waiting_user + 无关新话 → needs_clarification（不替用户认成答复）',
    vague.kind === 'needs_clarification' && vague.backgroundTaskId === waiting.id,
    JSON.stringify(vague),
  )
  check('★ 这时 taskId 是空的 —— 不会指向任何一条台账', vague.taskId === '')
  const yes = attribution.decide({ sessionId: SW, goal: '继续' })
  check('waiting_user + 说继续 → resume', yes.kind === 'resume' && yes.taskId === waiting.id)

  group('P0-3 / openForRun 只认结论（动作与结论一致）')
  const beforeWaiting = JSON.stringify(taskCore.get(waiting.id))
  const fresh = taskResume.openForRun({ goal: '不相关的新问题', sessionId: SW })
  created.push(fresh.id)
  check('★ needs_clarification 时 openForRun 新建，不覆盖旧台账', fresh.id !== waiting.id)
  check('★ 旧台账原封不动（status / 计划 / 步骤都没动）', JSON.stringify(taskCore.get(waiting.id)) === beforeWaiting)
  const resumed = taskResume.openForRun({ goal: '继续', sessionId: SW })
  check('★ 说继续时 openForRun 复用原任务', resumed.id === waiting.id)
  check('复用会把状态推回 running（reopen 的既有行为）', taskCore.get(waiting.id).status === 'running')

  group('P0-3 / 接线：判定只做一次（源码守卫）')
  const chatRunSrc = read('electron/handlers/chat-run.cjs')
  const loopRunSrc = read('electron/core/loop-run.cjs')
  check('★ chat-run 判一次，同一份结论喂给提示与 loop', chatRunSrc.includes('attribution: decided'))
  check('★ loop-run 拿到就用（没拿到才自己判一次）', loopRunSrc.includes('options.attribution ??'))
  check(
    '★ loop-run 不再自己算「是不是继续」，也不再拼 attached',
    !loopRunSrc.includes('const continueIntent = taskContext.isContinueIntent') && !loopRunSrc.includes('Boolean(attached)'),
  )
  check(
    '★ task-context 按归属结论决定「指不指当前任务」',
    read('electron/core/task-context.cjs').includes("attribution.kind === 'resume'"),
  )

  group('P0-4 / visible()：两个维度、fail-closed')
  check('global 任何上下文都可见', scope.visible({ scope: 'global' }, {}) === true)
  check('project 只在同项目可见', scope.visible({ scope: 'project', projectId: 'p1' }, { projectId: 'p1' }) === true)
  check('★ 别的项目不可见', scope.visible({ scope: 'project', projectId: 'p1' }, { projectId: 'p2' }) === false)
  check('★ 没有项目上下文 → project 记忆不可见', scope.visible({ scope: 'project', projectId: 'p1' }, { projectId: '' }) === false)
  check('★ 管理视图（不传 projectId）照样看得见', scope.visible({ scope: 'project', projectId: 'p1' }, {}) === true)
  check('session 只在同会话可见', scope.visible({ scope: 'session', sessionId: 's1' }, { sessionId: 's1' }) === true)
  check('★ 别的会话不可见', scope.visible({ scope: 'session', sessionId: 's1' }, { sessionId: 's2' }) === false)
  check('★ 没有会话上下文 → session 记忆不可见（fail-closed）', scope.visible({ scope: 'session', sessionId: 's1' }, { sessionId: '' }) === false)
  check('老记录没有 scope 字段当 global', scope.visible({}, {}) === true)

  group('P0-4 / memory_search 真跑：B 会话搜不到 A 的私事')
  const add = (input) => {
    const r = memory.add(input)
    if (r.item?.id) spill.push(r.item.id)
    return r.item?.id ?? ''
  }
  const sesA = add({ content: '自检临时：A 会话的私事 p04-zzz', scope: 'session', sessionId: 'selftest-p04-A' })
  const sesB = add({ content: '自检临时：B 会话的私事 p04-zzz', scope: 'session', sessionId: 'selftest-p04-B' })
  const projJia = add({ content: '自检临时：甲项目的约定 p04-zzz', scope: 'project', projectId: 'selftest-p04-甲' })
  const globalOne = add({ content: '自检临时：全局偏好 p04-zzz', scope: 'global' })
  const ctx = (over = {}) => ({ workdir: ROOT, permission: 'full', log: console, ...over })

  const fromB = String(
    await tools.execute('memory_search', { query: 'p04-zzz' }, ctx({ sessionId: 'selftest-p04-B' })),
  )
  check('★ B 搜得到自己的私事', fromB.includes(String(sesB)))
  check('★★ B 搜不到 A 的私事（这条以前是漏的）', !fromB.includes(String(sesA)))
  check('B 搜得到全局记忆', fromB.includes(String(globalOne)))
  check('B 在自己的项目里才搜得到甲项目的记忆', !fromB.includes(String(projJia)))

  const fromBWithJia = String(
    await tools.execute(
      'memory_search',
      { query: 'p04-zzz' },
      ctx({ sessionId: 'selftest-p04-B', projectId: 'selftest-p04-甲' }),
    ),
  )
  check('B + 甲项目 → 甲项目的记忆可见', fromBWithJia.includes(String(projJia)))

  const fromA = String(
    await tools.execute('memory_search', { query: 'p04-zzz' }, ctx({ sessionId: 'selftest-p04-A' })),
  )
  check('A 搜得到自己的私事', fromA.includes(String(sesA)))
  check('A 搜不到 B 的私事', !fromA.includes(String(sesB)))

  const noSession = String(await tools.execute('memory_search', { query: 'p04-zzz' }, ctx({ sessionId: '' })))
  check('★ 没有会话上下文 → 两条会话私事都搜不到（与注入同口径）', !noSession.includes(String(sesA)) && !noSession.includes(String(sesB)))
  check('搜不到时如实说「当前可见范围内没搜到」，不谎称从未记录', noSession.includes('当前可见范围内') || noSession.includes(String(globalOne)))

  group('P0-4 / 注入口径与检索同一条规则（源码 + 真跑）')
  const recall = require(join(ROOT, 'electron/core/memory-recall.cjs'))
  const recalled = recall.retrieve({ query: 'p04-zzz', sessionId: 'selftest-p04-B' })
  check('★ 注入也只给 B 自己的会话记忆', recalled.some((i) => i.id === sesB) && !recalled.some((i) => i.id === sesA))
  check(
    '★ 两个入口都走 memory-scope（没有第二套 scope 判断）',
    read('electron/core/memory-recall.cjs').includes('filterVisible') &&
      read('electron/core/memory-store.cjs').includes('filterVisible'),
  )

  for (const id of spill) memory.remove(id)
  for (const id of created) taskCore.remove(id)
  check(
    '测试数据已清理',
    spill.every((id) => !memory.list({ includeSuperseded: true }).some((i) => i.id === id)) &&
      created.every((id) => taskCore.get(id) === null),
  )
}
