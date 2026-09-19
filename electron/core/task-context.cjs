/**
 * 任务上下文
 *
 * 围着同一件事：**让模型知道任务进行到哪了**。三块：
 *
 *   ① 注入文本 —— 把未完成任务组装成一段话，填进提示的 `taskState` 层。
 *      那个层一直空着（`loop-prompt.cjs` 里写着 `options.taskState ?? ''`，
 *      但全仓库没人传值），所以任务只活在界面上（侧栏黄点、横幅），
 *      模型自己压根不知道有未完成的活 —— 长对话里这就是「目标漂移」。
 *
 *   ② 计划完整性 —— 计划正文算个指纹存在任务里。注入前重算，对不上就
 *      只报「对不上」不注入内容。防的是工具结果、并行会话或某个 bug 把
 *      计划悄悄改掉，而模型还照着旧计划干活。
 *
 *   ③ 完成门禁 —— 还有没勾完的计划时，模型想收工就把它顶回去继续。
 *      但**必须有刹车**：次数上限 + 停滞检测，否则计划一旦写错（比如列了
 *      一件根本做不到的事）就会把会话锁死在循环里出不来。PWF 的做法值得学。
 *
 * 计划条目的完成标记写进字符串本身（`[x] 读 package.json`），不是另建结构 ——
 * 老任务里没有标记的条目按「未完成」算，不需要迁移。
 */

const log = require('./log.cjs')
const taskCore = require('./task.cjs')
const taskHint = require('./task-hint.cjs')
const taskResume = require('./task-resume.cjs')
const steering = require('./task-steering.cjs')
/* 指纹算法只该有一份，放在 task-plan.cjs（那里没有依赖，不会绕回来） */
/* 计划行的小工具（是否勾完 / 进度 / 去标记）住在 task-plan.cjs —— 见那边的注释 */
const { fingerprint, isDone, progressOf, stripMarks } = require('./task-plan.cjs')

/** 一次注入最多带几个任务（多了会挤占上下文） */
const MAX_TASKS = 5
/** 计划里最多列几条（和 parsePlan 的上限一致） */
const MAX_PLAN_LINES = 20
/** 最多顶回去几次就放行（防止计划本身有问题时把会话锁死） */
const MAX_BLOCKS = 3

/**
 * 上一轮注入时各任务的进度。
 *
 * 只在进程内记着就够 —— 要发现的是「同一段时间里有两个东西在改同一份计划」，
 * 跨重启没有意义。
 */
const lastProgress = new Map()

/** 只给测试用：清掉进度记忆 */
function resetProgressMemory() {
  lastProgress.clear()
}

function buildTaskState({ sessionId = '', taskId = '', userText = '' } = {}) {
  let tasks = []
  try {
    /*
     * 用 unfinished() 而不是 list({status:'running'})：前者才是「还没做完」的
     * 全部（含 paused / waiting_user），和侧栏黄点用的是同一个口径。
     * 只查 running 的话，用户暂停过的任务就从模型视野里消失了。
     */
    tasks = taskCore.unfinished() ?? []
  } catch (error) {
    log.warn(`读任务失败：${error instanceof Error ? error.message : error}`)
    return ''
  }

  /* 当前会话的任务优先；然后才是全局还开着的 */
  const mine = tasks.filter((task) => sessionId && task.sessionId === sessionId)
  const others = tasks.filter((task) => !mine.includes(task))
  const ordered = [
    ...mine.slice(0, MAX_TASKS),
    ...others.slice(0, Math.max(0, MAX_TASKS - mine.length)),
  ]
  /* 新活的第一轮（一条未完成任务都没有）：必须带上「本轮请求」——
     只说通用规矩模型不照做，真机实测过（缘由写在 task-hint.cjs）。 */
  if (ordered.length === 0) return taskHint.freshRequest(userText)

  /* 诊断用：确认「用户在说继续」这条真的被认出来了（taskState 不落盘） */
  if (steering.isContinueIntent(userText)) {
    log.info(`任务连续性：用户说「${String(userText).trim()}」，已注入「接着做」提示`)
  }

  const blocks = []
  for (const task of ordered) {
    const isCurrent = task.id === taskId || (sessionId && task.sessionId === sessionId)
    const head = `${isCurrent ? '▶' : '·'} [${task.status}] ${task.title || '(无标题)'}`
    const lines = [head]
    if (task.goal) lines.push(`  目标：${String(task.goal).slice(0, 160)}`)

    if (isCurrent) {
      const note = steering.steeringNote({ task, userText })
      if (note) lines.push(note)
    }

    const plan = (task.plan ?? []).slice(0, MAX_PLAN_LINES)
    if (plan.length > 0) {
      const { done, total } = progressOf(plan)
      lines.push(`  计划（${done}/${total} 完成）：`)
      for (const line of plan) lines.push(`    ${String(line).slice(0, 120)}`)

      /*
       * 并行写保护：进度比上一轮**变少**了，说明有别人也在改这份计划
       * （你这里多条对话是真并行的）。不提醒的话模型会以为有人把活干完了，
       * 或者按一份已经不存在的进度往下走。
       */
      const prev = lastProgress.get(task.id)
      if (prev && done < prev.done) {
        lines.push(
          `  ⚠ 上轮还是 ${prev.done}/${prev.total}，现在只剩 ${done}/${total} —— 可能有另一个会话也在改这份计划，先跟用户确认再动手。`,
        )
      }
      lastProgress.set(task.id, { done, total })

      /* 完整性：指纹对不上就只提醒，不假装计划还是原来那份 */
      if (task.planHash && task.planHash !== fingerprint(plan)) {
        lines.push('  ⚠ 计划正文与批准时不一致（可能被改动过），以上内容请当作待确认。')
      }
    }

    const lastStep = (task.steps ?? []).at(-1)
    if (lastStep) {
      lines.push(
        `  最近一步：${lastStep.tool} ${lastStep.ok ? '成功' : '失败'}${lastStep.summary ? ` — ${String(lastStep.summary).slice(0, 100)}` : ''}`,
      )
    }
    if ((task.changedFiles ?? []).length > 0) {
      lines.push(`  已改文件：${task.changedFiles.length} 个`)
    }

    /*
     * AG-011：恢复执行前提醒「环境变了」。
     * 任务停住之后这些文件又被别的东西动过 —— 直接接着做可能基于过时假设
     * （比如那段代码已经被改掉了）。新任务没有 changedFiles，这段不会触发。
     */
    const env = taskResume.checkEnvironment(task.id)
    if (env.changed.length > 0) {
      lines.push('  ⚠ 你停手之后这些文件又变过，动它们之前先重新读一遍：')
      for (const file of env.changed.slice(0, 6)) lines.push(`    · ${file}`)
    }
    blocks.push(lines.join('\n'))
  }

  return [
    '以下是**还没做完**的任务台账（来自磁盘，不是你说过的话）。',
    '继续干活时以它为准：接着计划里**第一条没有 [x] 的**往下做，别重复已经完成的步骤。',
    taskHint.ledgerFormatLine(),
    '如果某一步其实不需要做了，也在计划里说明理由，不要默默跳过。',
    /*
     * AG-018：用户在说「继续」时，把话说死。
     *
     * 不做这一步的话，模型有可能会把「继续」当成一个含糊的新要求 ——
     * 重新问一遍背景，或者干脆重头讲一遍计划。
     */
    steering.isContinueIntent(userText)
      ? `\n（用户这句「${String(userText).trim()}」是在说**接着做** —— 目标是上面那条任务，不是新任务。先看计划进度和最近一步，从停住的地方往下走；缺上下文就查最近工具结果，别从头再问一遍。）`
      : '',
    '',
    blocks.join('\n\n'),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function capturePlan({ taskId = '', content = '' } = {}) {
  if (!taskId) return null
  /* AG-027：计划块第一行可以是任务名（Chat 与 Task 分离 —— 别再拿聊天句当任务名） */
  const block = taskCore.parsePlanBlock(content)
  if (block.steps.length === 0) return null
  /*
   * AG-043：这一版计划是「被用户改动逼出来的」吗？
   * 判据是时间：用户最后一次改方向**晚于**上一版计划 → 这一版就是照他说的改的。
   * 不额外传标志（那要在好几个模块之间穿线），而且这个事实本来就在台账里。
   */
  const task = taskCore.get(taskId)
  const lastSteering = Number((task?.steering ?? []).at(-1)?.at ?? 0)
  const lastPlanAt = Number((task?.planVersions ?? []).at(-1)?.at ?? 0)
  const reason = lastSteering > lastPlanAt ? '按你的改动重新规划' : ''
  const result = taskCore.setPlan(taskId, block.steps, { title: block.title, reason })
  if (!result || !result.changed) return null
  return {
    plan: result.task.plan,
    version: result.version,
    reason: result.reason,
    title: result.title ?? '',
  }
}

module.exports = {
  buildTaskState,
  /* 「怎么引导模型」那两块住在 task-steering.cjs，这里转发一下（调用方不用改） */
  steeringNote: steering.steeringNote,
  shouldContinue: steering.shouldContinue,
  capturePlan,
  progressOf,
  fingerprint,
  stripMarks,
  isDone,
  resetProgressMemory,
  isContinueIntent: steering.isContinueIntent,
}
