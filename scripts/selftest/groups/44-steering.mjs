import { join, readFileSync, require, ROOT, SANDBOX } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-043 用户改方向（User Takeover）

   文档：用户能在执行中改方向，四条要求 ——
     不重新执行无关步骤 / 保留原计划历史 / **记录用户修改** / 从有效 Checkpoint 继续。

   前两条与第四条靠已有的东西（进度注入、planVersions、检查点），
   这次补的两件事：
     · 接回**原任务**（不然新一轮会新建任务，计划与检查点全丢）
     · 明确告诉模型「这是改方向，不是新任务」，并把用户原话留痕
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))

export async function run() {
  const created = []
  function newTask(goal = '改方向测试') {
    const task = taskCore.create({ goal, sessionId: 'selftest-ag043' })
    created.push(task.id)
    return taskCore.get(task.id)
  }

  /* 单调时钟：同一毫秒里连续建任务，updatedAt 也不能撞 —— 撞了排序不稳定，
     activeForSession 会挑错任务（在 CI 上真发生过，见 task-io.cjs 的 monotonicNow） */
  const monoA = taskCore.create({ goal: 'a', sessionId: 'selftest-ag043' })
  created.push(monoA.id)
  const monoB = taskCore.create({ goal: 'b', sessionId: 'selftest-ag043' })
  created.push(monoB.id)
  check(
    '★ updatedAt 严格递增（同毫秒建任务也不撞）',
    (monoB.updatedAt ?? 0) > (monoA.updatedAt ?? 0),
    `${monoA.updatedAt} vs ${monoB.updatedAt}`,
  )

  /* ── ① 什么算「改方向」 ─────────────────────────────── */
  group('AG-043 / 什么算改方向')
  const steer = newTask('把 README 改一遍')
  taskCore.setPlan(steer.id, ['[x] 读 README', '[ ] 改安装节', '[ ] 跑测试'])

  check(
    '★ 没记过改动 → 不改方向（普通追问不该被当成改方向）',
    taskContext.steeringNote({ task: taskCore.get(steer.id), userText: '这个文件多大？' }) === '',
  )

  taskCore.addSteering(steer.id, '不要方案 A，改用方案 B')
  const note = taskContext.steeringNote({
    task: taskCore.get(steer.id),
    userText: '不要方案 A，改用方案 B',
  })
  check('★ 记过改动之后 → 有改方向提示', note.length > 0)
  check(
    '说清「不是新任务、别从头再来」',
    note.includes('不是新任务') && note.includes('从头再来'),
    note.slice(0, 60),
  )
  check('★ 要求「已经做完的不要重做」', note.includes('不要重做'))
  check('把原计划和进度摆出来', note.includes('读 README') && note.includes('1/3'))
  check('★ 要求给出更新后的完整计划', note.includes('```plan'))
  check('说明原计划历史会保留', note.includes('原计划历史会保留'))

  check(
    '★ 光说「继续」不算改方向（那是接着做）',
    taskContext.steeringNote({ task: taskCore.get(steer.id), userText: '继续' }) === '',
  )
  check(
    '已完成的任务没有改方向一说',
    taskContext.steeringNote({
      task: { status: 'completed', steering: [{ at: Date.now(), text: 'x' }] },
      userText: 'x',
    }) === '',
  )
  check(
    '★ 改动记太久之前就不再算（5 分钟窗口，避免僵尸提示）',
    taskContext.steeringNote({
      task: {
        status: 'running',
        plan: [],
        steering: [{ at: Date.now() - 10 * 60 * 1000, text: 'x' }],
      },
      userText: 'x',
    }) === '',
  )

  /* ── ② 记录与历史 ───────────────────────────────────── */
  group('AG-043 / 记录用户修改 + 保留原计划历史')
  const recorded = taskCore.get(steer.id)
  check(
    '★ 用户原话被记下来（复盘时最有用）',
    recorded.steering?.at(-1)?.text === '不要方案 A，改用方案 B',
  )
  check('记的是原话，不是改写过的', (recorded.steering ?? []).length === 1)

  for (let i = 0; i < 30; i += 1) taskCore.addSteering(steer.id, `第 ${i} 次改`)
  check('只留最近 20 条（不是聊天记录）', taskCore.get(steer.id).steering.length === 20)
  check(
    '空话不记',
    taskCore.addSteering(steer.id, '   ') === null || taskCore.get(steer.id).steering.length === 20,
  )

  /*
   * 计划版本：真实时序是「先有 v1 → 用户改方向 → 模型按新的重规划出 v2」。
   * 所以这里不再手动 setPlan 一次（那会把 v2 的时间戳压在改动之后，
   * 让「这一版是不是被用户逼出来的」判断失效）—— 直接走 capturePlan。
   */
  const planReason = taskContext.capturePlan({
    taskId: steer.id,
    content:
      '按你说的换方案 B：\n\n```plan\n- [x] 读 README\n- [ ] 换方案 B\n- [ ] 跑测试\n- [ ] 验证\n```\n',
  })
  const versions = taskCore.get(steer.id).planVersions
  check(
    '★ 原计划历史留着（两版）',
    versions.length === 2,
    JSON.stringify(versions.map((v) => v.reason)),
  )
  check('第一版还在（没被覆盖）', versions[0].plan.join('|').includes('改安装节'))
  check(
    '★ 计划版本的理由写明「按你的改动」（用户看得见自己改了什么）',
    planReason?.reason === '按你的改动重新规划',
    JSON.stringify(planReason?.reason),
  )

  /* ── ③ ★ 改方向要接回**原任务**（不然计划/进度/检查点全丢） ── */
  group('AG-043 / 改方向接回原任务')
  const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))
  const live = newTask('这条对话还没干完的活')
  taskCore.setPlan(live.id, ['[x] 第一步', '[ ] 第二步'])
  taskCore.checkpoint(live.id, { label: '检查点 A' })
  taskCore.update(live.id, { status: 'paused', pausedAt: Date.now() })

  /*
   * ★ 用户报过：「发了一个新问题，结果它把之前没干完的任务接回去重跑、旧记录被覆盖」。
   *   所以「接回」不再是无条件 —— paused 的任务要**明确说继续**才接回去。
   */
  check(
    '★ 明确说「继续」时才认出这条对话里没干完的任务',
    taskResume.activeForSession(live.sessionId, { continueIntent: true })?.id === live.id,
  )
  /*
   * 只断言「没挑中那条暂停的」——**不断言返回 null**：
   * 同一会话里可能还有 waiting_user 的任务（那是该接回的情形），
   * 断言 null 等于在赌「目录恰好干净」，这个坑踩过好几次了。
   */
  check(
    '★ 随口发个新问题不算「继续」—— 不许把这个暂停的任务拉起来',
    taskResume.activeForSession(live.sessionId)?.id !== live.id,
  )
  check('别的对话不受影响（查不到）', taskResume.activeForSession('别的会话') === null)

  /* ★ 回归守卫：新问题必须新建一条，旧任务一个字都不能变 */
  const beforeNewQuestion = JSON.stringify(taskCore.get(live.id))
  const asNew = taskResume.openForRun({
    goal: '顺便帮我看看今天的天气怎么样',
    sessionId: live.sessionId,
    workdir: '/tmp',
  })
  check('★ 发新问题 → 新建一条任务（不是接回旧的）', asNew.id !== live.id, asNew.id)
  check(
    '★ 旧任务原封不动（状态/计划/检查点都没被覆盖）',
    JSON.stringify(taskCore.get(live.id)) === beforeNewQuestion,
  )
  taskCore.remove(asNew.id)

  const attached = taskResume.openForRun({
    goal: '不要第二步了，改成别的',
    sessionId: live.sessionId,
    continueIntent: true,
    workdir: '/tmp',
  })
  check('★ 没带 resumeTaskId 也接回原任务（不是新建一条）', attached.id === live.id, attached.id)
  check('★ 计划留下来了（不用重做已完成的）', (attached.plan ?? []).join('|').includes('第二步'))
  check('检查点也留着（从有效检查点继续）', (taskCore.get(live.id).checkpoints ?? []).length === 1)

  /* 干净的会话（没有没干完的活）→ 照旧新建 */
  const fresh = taskResume.openForRun({
    goal: '一条全新的活',
    sessionId: '全新会话',
    workdir: '/tmp',
  })
  created.push(fresh.id)
  check('没有没干完的活 → 照旧新建任务', fresh.id !== live.id && fresh.status === 'running')

  /* ★ 同一个会话里只有**已完成**的任务 → 也要新建（别接到已经干完的活上） */
  const done = newTask('已经干完的活')
  taskCore.finish(done.id, { status: 'completed', result: '做完了' })
  const afterDone = taskResume.openForRun({
    goal: '再来一件新事',
    sessionId: done.sessionId,
    workdir: '/tmp',
  })
  created.push(afterDone.id)
  check(
    '★ 只有已完成的任务时 → 新建（不接回）',
    afterDone.id !== done.id && afterDone.status === 'running',
    afterDone.id,
  )

  /* ── ④ 从有效检查点继续 ─────────────────────────────── */
  group('AG-043 / 从检查点继续')
  taskCore.checkpoint(steer.id, { label: '第 2 轮结束', note: '读完了' })
  const resumed = taskCore.get(steer.id)
  check(
    '检查点留着（恢复时从这里继续）',
    resumed.checkpoints.length === 1 && resumed.checkpoints[0].label === '第 2 轮结束',
  )
  check(
    '完成过的步骤不会被重做（进度注入读的就是这份计划）',
    (() => {
      const state = taskContext.buildTaskState({
        sessionId: 'selftest-ag043',
        taskId: steer.id,
        userText: '不要方案 A',
      })
      return state.includes('[x] 读 README') && state.includes('1/4')
    })(),
  )

  /* ── ⑤ 接线 ─────────────────────────────────────────── */
  group('AG-043 / 接线')
  const runSrc = readFileSync(join(ROOT, 'electron/core/loop-run.cjs'), 'utf8')
  check(
    '★ 复用旧任务 + 不是「继续」→ 记一次用户改动',
    runSrc.includes('taskNotes.addSteering(task.id, goal)'),
  )
  /*
   * ★ 真机逮到的坑：这个「是不是接回来的」判断必须在 openForRun **之前**做 ——
   *   openForRun 内部会把任务 reopen 成 running，之后再问「它是不是 running」永远是否，
   *   于是用户改了方向却一条都记不下来（真机上任务接回来了、steering 是空的）。
   */
  check(
    '★ 接回来的判断在 openForRun 之前（顺序不能反）',
    runSrc.indexOf('activeForSession(sessionId, { continueIntent })') <
      runSrc.indexOf('openForRun({ ...options'),
  )
  check('★ 判断用接回的结果，不是用状态反推', runSrc.includes('Boolean(attached)'))

  const ctxSrc = readFileSync(join(ROOT, 'electron/core/task-context.cjs'), 'utf8')
  check(
    '改方向提示挂在 buildTaskState 里（只有当前任务）',
    ctxSrc.includes('steering.steeringNote({ task, userText })'),
  )
  check('计划版本理由按时间推断（不穿线传标志）', ctxSrc.includes('lastSteering > lastPlanAt'))

  const resumeSrc = readFileSync(join(ROOT, 'electron/core/task-resume.cjs'), 'utf8')
  check(
    '★ openForRun 会接回这条对话没干完的任务（但由 continueIntent 把关）',
    resumeSrc.includes('activeForSession(sessionId, { continueIntent })'),
  )
  check(
    '★ 界面上看得见「你改过方向」（记录用户修改）',
    readFileSync(join(ROOT, 'src/components/chat/TaskRow.tsx'), 'utf8').includes('你改过方向'),
  )

  /* ── ⑥ 真跑一遍：接回原任务时要把「用户改方向」记下来 ── */
  /*
   * ★ 这条是补的：上面只测了「接回来」这件事本身；真机上发现 steering 是空的
   *   —— 因为 openForRun 内部会把任务 reopen 成 running，
   *   「它是不是接回来的」这个判断必须在那之前做。真跑一遍才照到。
   */
  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
