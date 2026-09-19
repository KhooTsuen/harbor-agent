/*
 * 一次运行的外壳：任务 + 改动事务 + 收尾（AG-011/AG-035/AG-040）
 *
 * 从 `loop.cjs` 搬出来的 —— 那边在 AG-040 加了预算之后贴到 343 行。
 * 分工：这个文件负责「一次运行的**开始与结束**」（建/复用任务、开事务、定状态），
 * `loop.cjs` 只负责中间那段循环。
 */

const log = require('./log.cjs')
const life = require('./lifecycle.cjs')
const taskCore = require('./task.cjs')
const taskResume = require('./task-resume.cjs')
const changeset = require('./changeset.cjs')
const budget = require('./budget.cjs')
const taskContext = require('./task-context.cjs')
const taskNotes = require('./task-notes.cjs')

/**
 * 跑一轮完整的活。
 *
 * @param {object} options 见 loop.cjs 的 runLoop
 */
async function run(options) {
  /* 一次运行 = 一条任务 + 一个文件改动事务：任务答「干什么、到哪一步」，
     事务答「改了哪些文件、怎么整批撤」。都不进会话文件（会话是聊天记录）。 */
  const goal = String(options.goal ?? '')
  const sessionId = options.sessionId ?? ''

  /* AG-011：能恢复就复用原任务（steps / plan / changedFiles 得留着，否则
     「不重复已完成步骤」无从谈起）；其余情况新建一条。 */
  /*
   * ★ 这两个判断必须在 openForRun **之前**做：
   *   openForRun 内部会把接回来的任务 reopen 成 running，
   *   之后再看「它是不是 running」就永远是否 —— 于是「用户改方向」一条都记不下来。
   *   （真机上就是这么发现的：任务确实接回来了，但 steering 是空的。）
   */
  const attached = !options.resumeTaskId ? taskResume.activeForSession(sessionId) : null

  const task = taskResume.openForRun({ ...options, goal, sessionId })
  const session = changeset.begin({ taskId: task.id, sessionId, title: task.title })
  const changeSetId = session.ok ? session.id : ''

  /*
   * AG-043：复用旧任务 + 这轮的话不是「继续」→ 记一次「用户改方向」。
   *
   * 判据放在这里而不是提示层：只有在这一刻才能确定「是接着做、而且说了新东西」。
   * 记下来有两个用处：提示里要提醒模型别重做已完成步骤；复盘时看得见用户改过什么。
   */
  const resumed = Boolean(options.resumeTaskId) || Boolean(attached)
  if (resumed && !taskContext.isContinueIntent(goal)) {
    try {
      taskNotes.addSteering(task.id, goal)
    } catch (error) {
      log.warn(`记用户改动失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /* AG-042：控制台要显示「自动重试了几次」—— 事件里数一遍，不改别的模块 */
  const counters = { retries: 0 }
  const countingEmit = (event) => {
    if (event?.type === 'agent.retrying') counters.retries += 1
    options.emit?.(event)
  }
  options.emit?.({ type: 'task', taskId: task.id, changeSetId, goal: task.goal })

  const { runLoop } = require('./loop.cjs')
  try {
    const result = await runLoop({ ...options, taskId: task.id, changeSetId, emit: countingEmit })

    if (changeSetId) changeset.commit(changeSetId, { verified: result.verified ?? null })

    if (result.exhausted || result.paused) {
      /*
       * 活没干完 → 标成 paused 让它可恢复（AG-012 记下停的时刻）。
       * AG-040：撞预算停下来时额外记「撞的是哪一项」和数字 ——
       * 界面据此显示「已达到本次执行上限」和 [继续][停止][调整预算]。
       * **不是失败**：这是停下来等人做决定。
       */
      const reason = result.budgetHit
        ? budget.pausePatch(result.budgetHit)
        : result.loopHit
          ? {
              /* AG-041：转圈转到交给人 —— 和撞预算一样是「停下来等决定」，不是失败 */
              pauseReason: 'loop',
              pauseDetail: result.loopHit.kind,
              loopHit: {
                kind: result.loopHit.kind,
                period: result.loopHit.period ?? 1,
                count: result.loopHit.count ?? 0,
                samples: result.loopHit.samples ?? [],
              },
            }
          : {}
      taskCore.update(task.id, { status: 'paused', pausedAt: Date.now(), ...reason })
    } else {
      taskCore.finish(task.id, { status: 'completed', result: result.content ?? '' })
    }

    /* AG-042：把这一轮的用量与重试次数记进台账（控制台照它显示） */
    try {
      taskCore.update(task.id, {
        tokens: (taskCore.get(task.id)?.tokens ?? 0) + (result.usage?.total ?? 0),
        retries: counters.retries,
      })
    } catch (error) {
      log.warn(`记用量失败：${error instanceof Error ? error.message : error}`)
    }

    return { ...result, taskId: task.id, changeSetId }
  } catch (error) {
    /* 中断/报错都算「没干完」—— 任务留着可恢复，事务不提交（还能整批撤） */
    const aborted = error instanceof Error && error.name === 'AbortError'
    life.mark(aborted ? 'cancelled' : 'failed', traceKey(options))
    if (aborted) taskCore.update(task.id, { status: 'paused', pausedAt: Date.now() })
    else {
      taskCore.fail(task.id, error instanceof Error ? error.message : String(error))
      log.warn(`任务没跑完：${error instanceof Error ? error.message : error}`)
    }
    throw error
  }
}

/** 状态事件的 key（和 loop.cjs 里那份同一个规则：谁发起请求谁定 key） */
function traceKey(options) {
  return (typeof options.traceId === 'string' && options.traceId) || options.taskId || ''
}

module.exports = { run }
