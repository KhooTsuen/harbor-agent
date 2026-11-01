/**
 * 任务上下文
 *
 * 围着同一件事：**让模型知道任务进行到哪了**。五块：
 *
 *   ① 注入文本 —— 把**本会话**未完成的任务组装成一段话，填进提示的 `taskState` 层
 *      （那个层原来一直空着，任务只活在界面上，模型压根不知道有未完成的活 → 目标漂移）。
 *      ★ 严格按 sessionId 隔离（曾经兜底注入过，导致「B 去执行 A 的任务」）；
 *      ★ P0-3 起还按**归属结论**决定「指不指当前任务」—— 见 buildTaskState 的 attribution。
 *   ② 计划完整性 —— 计划正文算指纹。注入前重算，对不上就只报「对不上」不注入内容。
 *   ③ 完成门禁 —— 计划没勾完就想收工 → 顶回去；必须带刹车（次数 + 停滞检测），
 *      否则计划写错一件事就把会话锁死在循环里。
 *   ④ 项目现状 —— 「这目录里现在有什么、测试怎么跑」（`project-facts.cjs`）。
 *      它只能搭这趟车：这一层不裁剪、又在稳定区之后，是唯一能安全放易变文本的位置。
 *   ⑤ 这类活踩过的坑 —— 把召回到的多条记忆归并成一句（`memory-reflect.cjs`），
 *      只在第一轮给（动手前的一句提醒，不是常驻状态）。
 *
 * 计划条目的完成标记写进字符串本身（`[x] 读 package.json`），不是另建结构 ——
 * 老任务里没有标记的条目按「未完成」算，不需要迁移。
 */

const log = require('./log.cjs')
const taskCore = require('./task.cjs')
const taskHint = require('./task-hint.cjs')
const taskResume = require('./task-resume.cjs')
const steering = require('./task-steering.cjs')
const verifyHint = require('./verify-hint.cjs')
const projectFacts = require('./project-facts.cjs')
const memoryReflect = require('./memory-reflect.cjs')
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

/* 「这个项目的现状」那段（缺口 C）：`taskState` 层不裁剪、又在稳定区之后，是唯一能
 * 安全放「每轮重算的易变文本」的位置（挂项目上下文那层会被长 AGENT.md 挤掉）。
 * 每轮都给 —— 它治的就是「对话被裁剪后反复侦察」；扫不动时是空串（宁可不给）。 */
function factsSection(workdir) {
  try {
    return projectFacts.build({ workdir })
  } catch (error) {
    log.warn(`扫项目现状失败：${error instanceof Error ? error.message : error}`)
    return ''
  }
}

/* 「这类活你以前踩过什么坑」那段（缺口 D 雏形）：只在**新活第一轮**给 —— 每轮都念
 * 就是噪音（那些条目本身已被 memory-recall 每轮注入过）；没归并出成组就返回空串。 */
function reflectSection(userText, projectId) {
  try {
    return memoryReflect.reflect({ query: String(userText ?? ''), projectId: String(projectId ?? '') })
  } catch (error) {
    log.warn(`综合记忆失败：${error instanceof Error ? error.message : error}`)
    return ''
  }
}

/** 只给测试用：清掉进度记忆 */
function resetProgressMemory() {
  lastProgress.clear()
}

function buildTaskState({
  sessionId = '',
  taskId = '',
  userText = '',
  workdir = '',
  projectId = '',
  /*
   * ★ P0-3：这次运行**归谁**（`task-attribution.decide()` 的结论）。传了它，这一节
   * 就只按它说话：`resume` 才把某条标成「当前在做」，`new` / `needs_clarification`
   * **一条都不指**。以前这里总把最近更新的未完成任务标成 `▶ 当前` 并附「接着做」，
   * 而台账那边可能刚新建了一条 → 提示说 A、台账是 B。
   * 不传（老调用方 / 自检）→ 退回旧行为，与升级前一致。
   */
  attribution = null,
} = {}) {
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

  /*
   * ★ 严格按会话隔离：只看**本会话**的未完成任务。
   *
   * 以前是「本会话优先 + 其他会话兜底（others）」—— 于是 A 里中断的任务会被
   * 塞进**每一条**对话的提示里（还带着「接着计划里第一条没 [x] 的往下做」的
   * 指令），在 B 里模型就开始干 A 的活 —— bug：任务状态像全局共享的。
   * 别的对话的活不由这里代管：要接着做，回那条对话，或者点任务中心的「继续」。
   */
  const mine = sessionId ? tasks.filter((task) => task.sessionId === sessionId) : []
  const ordered = mine.slice(0, MAX_TASKS)

  /* 新活的第一轮（本会话一条未完成任务都没有）：必须带上「本轮请求」——
     只说通用规矩模型不照做，真机实测过（缘由写在 task-hint.cjs）。
     顺带在这里给一句**验证口径**（有测试入口就给命令、没有就要求先建一个）——
     只在这一轮说，后面每轮都说是噪音（边界见 verify-hint.cjs 的文件头）。 */
  if (ordered.length === 0) {
    return [
      taskHint.freshRequest(userText),
      verifyHint.build({ workdir }),
      reflectSection(userText, projectId),
      factsSection(workdir),
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  /*
   * 哪条是「当前」：有归属结论 → **只有 resume 才指出当前**（其余一条都不指）；
   * 没结论（老调用方）→ 显式 taskId，否则最近更新的那条（unfinished 已按 updatedAt 降序）。
   * ★ P0-3 的关键：以前无论如何都标一条「▶ 当前」并附「接着做」，于是「这其实是新任务」
   *   的时候，提示在让模型接着做一件它没被指派的事。
   */
  const currentId = attribution
    ? attribution.kind === 'resume'
      ? attribution.taskId
      : ''
    : taskId || ordered[0]?.id || ''

  /* 诊断用：确认「用户在说继续」这条真的被认出来了（taskState 不落盘） */
  if (steering.isContinueIntent(userText)) {
    log.info(`任务连续性：用户说「${String(userText).trim()}」，已注入「接着做」提示`)
  }

  const blocks = []
  for (const task of ordered) {
    const isCurrent = task.id === currentId
    const head = `${isCurrent ? '▶' : '·'} [${task.status}] ${task.title || '(无标题)'}`
    const lines = [head]
    if (task.goal) lines.push(`  目标：${String(task.goal).slice(0, 160)}`)
    /* CE-007：北极星回显 —— **每轮都注入**（taskState 是**易变区**，动它不碰稳定前缀缓存）。
       治的是长任务跑偏：模型每轮都看得见「这活到底为了什么、做成什么样算完成」。
       老任务没有 star（migrate 补成 ''）→ 这行不出现，行为与升级前一致。 */
    if (task.star) lines.push(`  北极星：${String(task.star).slice(0, 200)}`)

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

  /*
   * 抬头这几句按归属结论说话（P0-3）：resume（或老调用方没给结论）→ 台账是「这次
   * 要做什么」；new / needs_clarification → 台账只是**背景**，不能拿它当目标。
   */
  const asBackground = Boolean(attribution) && attribution.kind !== 'resume'
  const waitingNote =
    attribution?.kind === 'needs_clarification' && attribution.backgroundTaskId
      ? '\n（上面有一条任务停在「等你回话」，但用户这句**看不出是不是在回答它** —— P0 阶段不猜：先按用户这句话办；真要它继续，等他明说，或直接问。）'
      : ''
  /*
   * AG-018：用户说「继续」时把话说死（否则模型会把它当含糊的新要求，重新问一遍背景）。
   * ★ 有归属结论时只听它的 —— 同一件事不能有两种说法。
   */
  const continueLine = `\n（用户这句「${String(userText).trim()}」是在说**接着做** —— 目标是上面那条任务，不是新任务。先看计划进度和最近一步，从停住的地方往下走；缺上下文就查最近工具结果，别从头再问一遍。）`
  const saidContinue = attribution ? attribution.continueIntent : steering.isContinueIntent(userText)
  return [
    asBackground
      ? '以下是**还没做完**的其他任务台账（来自磁盘，不是你说过的话）—— 这轮**不是**接着它们做，只作背景。'
      : '以下是**还没做完**的任务台账（来自磁盘，不是你说过的话）。',
    asBackground
      ? '只在用户明确要接着做时才动它们；别把它们的计划当成这轮的目标。'
      : '继续干活时以它为准：接着计划里**第一条没有 [x] 的**往下做，别重复已经完成的步骤。',
    taskHint.ledgerFormatLine(),
    asBackground
      ? '如果用户这轮明确要改某条任务的计划，就给出更新后的完整计划。'
      : '如果某一步其实不需要做了，也在计划里说明理由，不要默默跳过。',
    waitingNote,
    saidContinue ? continueLine : '',
    '',
    blocks.join('\n\n'),
    /* 项目现状放最后：台账是「这次要做什么」，现状是「磁盘上现在有什么」 */
    factsSection(workdir),
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
  const result = taskCore.setPlan(taskId, block.steps, {
    title: block.title,
    reason,
    /* CE-007：北极星（计划块里「北极星：」那一行）随计划一起交下去，首次定格 */
    star: block.star,
  })
  if (!result || !result.changed) return null
  return {
    plan: result.task.plan,
    version: result.version,
    reason: result.reason,
    title: result.title ?? '',
    star: result.task.star ?? '',
  }
}

module.exports = {
  buildTaskState,
  /* 「怎么引导模型」那两块住在 task-steering.cjs，这里转发一下（调用方不用改） */
  steeringNote: steering.steeringNote,
  shouldContinue: steering.shouldContinue,
  shouldVerify: steering.shouldVerify,
  completionGate: steering.completionGate,
  capturePlan,
  progressOf,
  fingerprint,
  stripMarks,
  isDone,
  resetProgressMemory,
  isContinueIntent: steering.isContinueIntent,
}
