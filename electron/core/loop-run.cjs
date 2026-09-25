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
const taskRegen = require('./task-regen.cjs')
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
   * ★「这句是不是让我继续」只算一次，两个用途共用：
   *   ① 决定要不要把这条对话里停下的旧任务接回来 —— 见 task-resume.cjs：
   *      以前是无条件接回，于是随口发个新问题会把旧任务拉起来重跑、覆盖掉；
   *   ② 接回来了而且在说新东西 → 记一次「用户改方向」。
   * ★ 必须在 openForRun **之前**算：它内部会把接回的任务 reopen 成 running，
   *   之后再判断就永远不成立（真机上踩过：任务接回来了，steering 却是空的）。
   */
  const continueIntent = taskContext.isContinueIntent(goal)
  /*
   * `attached` = 「openForRun 将会复用的是哪条」（没有就是 null）。
   * ★ 必须用**和 openForRun 完全一样的判据**，否则两边会不一致：
   *   刚开始我把它也拿 continueIntent 卡住，结果「任务正在跑、用户打字改方向」
   *   那条路（AG-043 的正牌用法）就再也记不下 steering 了。
   */
  const attached = options.resumeTaskId
    ? null
    : taskResume.activeForSession(sessionId, { continueIntent })

  /*
   * 重新生成（新功能）：渲染层带了 `regenerateOf`（被替代那条回答的磁盘 key）。
   * 只有「重做的是最后一轮」才认（regenerateLast）—— 只有那时「本会话最近
   * 一条任务」才一定属于被重做的那一轮；更早轮次对不上，宁可不关联也不连错。
   */
  const regenerating = Boolean(options.regenerateOf) && options.regenerateLast === true
  const prevTask = regenerating ? taskRegen.previousForSession(sessionId) : null
  const carry = prevTask ? budget.carryOf(prevTask) : null

  const task = taskResume.openForRun({
    ...options,
    goal,
    sessionId,
    continueIntent,
    regenerateFrom: prevTask?.id ?? '',
    budgetCarry: carry,
  })
  /* 旧台账 / 旧改动事务盖「被替代」标记（事务本体不自动撤 —— 审查面板手动整批回滚） */
  if (prevTask) {
    const linked = taskRegen.link(prevTask, task.id)
    if (linked.changeSetId) {
      log.info(
        `重新生成：旧改动事务 ${linked.changeSetId} 已隔离（被 ${task.id} 替代，不自动回滚）`,
      )
    }
  }
  const session = changeset.begin({ taskId: task.id, sessionId, title: task.title })
  const changeSetId = session.ok ? session.id : ''

  /*
   * AG-043：复用旧任务 + 这轮的话不是「继续」→ 记一次「用户改方向」。
   *
   * 判据放在这里而不是提示层：只有在这一刻才能确定「是接着做、而且说了新东西」。
   * 记下来有两个用处：提示里要提醒模型别重做已完成步骤；复盘时看得见用户改过什么。
   */
  const resumed = Boolean(options.resumeTaskId) || Boolean(attached)
  if (resumed && !continueIntent) {
    try {
      taskNotes.addSteering(task.id, goal)
    } catch (error) {
      log.warn(`记用户改动失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /*
   * AG-042：控制台那两个数字在这里数 —— 不改别的模块。
   *
   * ★ token **每轮结束就写一次**（`turn_end` 事件自带本轮累计 usage）。
   *   初版只在 run 结束时写一次，真机上一个跑了 6 分半的任务，控制台上
   *   Token 一直显示「—」—— 因为它还没跑完。长任务恰恰是最需要看用量的时候。
   *   注意 base 要在**开始前**取：写进去的是 base + 本轮累计（不是每轮往上加）。
   */
  const baseUsage = usageBase(taskCore.get(task.id))
  /*
   * 轮数基线：「预算不重置」的另一半（另一半在 budget.carryOf）。
   * 重新生成 → 从旧任务接着数（carry.steps）；接管 / 恢复 → 从本任务已有的接着数。
   */
  const turnsBase = Math.max(Number(task.turns) || 0, Number(carry?.steps) || 0)
  const counters = { retries: 0 }
  const countingEmit = (event) => {
    if (event?.type === 'agent.retrying') counters.retries += 1
    if (event?.type === 'turn_end') {
      try {
        /* AG-044：合计之外把「入 / 出」也记上（口径见 usagePatch）；轮数也累计（重新生成时从它继承） */
        taskCore.update(task.id, {
          ...usagePatch(baseUsage, event.usage),
          turns: turnsBase + (Number(event.turn) || 0),
        })
      } catch (error) {
        log.warn(`记用量失败：${error instanceof Error ? error.message : error}`)
      }
    }
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

    /* AG-042：收尾再写一次（token 用同一个 base 算，不是往上加） */
    try {
      taskCore.update(task.id, { ...usagePatch(baseUsage, result.usage), retries: counters.retries })
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

/**
 * 台账里的用量基线：这次 run **开始前**已经记了多少（AG-044）。
 *
 * ★ 为什么要在开始前取：`turn_end` 的 usage 是**这次 run 的累计**，不是每轮的增量，
 *   所以写进去的必须是 `base + 本轮累计`，而不是每轮往上加。
 *   任务恢复（接着做）时 base > 0，得从它接着算 —— 从 0 重算的话，
 *   每「继续」一次就把之前的用量抹掉一次（AG-042 用的是同一套算法）。
 * 老任务没有 tokensIn / tokensOut（AG-044 之前建的）→ 当 0 看，界面只显示总数。
 */
function usageBase(record) {
  const keep = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
  return {
    tokens: keep(record?.tokens),
    input: keep(record?.tokensIn),
    output: keep(record?.tokensOut),
  }
}

/**
 * 一条 usage → 要写进台账的三个数（合计 + 入 + 出）。
 *
 * 入 / 出（AG-044）取自上游的 `prompt_tokens` / `completion_tokens` ——
 * 形状由 `budget.usageParts` 一处认（别在这儿再写一遍字段名）。
 */
function usagePatch(base, usage) {
  const parts = budget.usageParts(usage)
  return {
    tokens: base.tokens + parts.total,
    tokensIn: base.input + parts.input,
    tokensOut: base.output + parts.output,
  }
}

/** 状态事件的 key（和 loop.cjs 里那份同一个规则：谁发起请求谁定 key） */
function traceKey(options) {
  return (typeof options.traceId === 'string' && options.traceId) || options.taskId || ''
}

module.exports = { run }
