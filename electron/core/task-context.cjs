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
const taskResume = require('./task-resume.cjs')
/* 指纹算法只该有一份，放在 task-plan.cjs（那里没有依赖，不会绕回来） */
const { fingerprint } = require('./task-plan.cjs')

/** 一次注入最多带几个任务（多了会挤占上下文） */
const MAX_TASKS = 5
/** 计划里最多列几条（和 parsePlan 的上限一致） */
const MAX_PLAN_LINES = 20
/** 最多顶回去几次就放行（防止计划本身有问题时把会话锁死） */
const MAX_BLOCKS = 3

/** 一条计划项是否已勾选 */
function isDone(line) {
  return /^\s*\[[xX]\]/.test(String(line))
}

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

/** 数一下计划进度。老任务没有标记，全部算未完成 */
function progressOf(plan) {
  const list = Array.isArray(plan) ? plan : []
  const done = list.filter(isDone).length
  return { done, total: list.length }
}

/** 计划正文去掉勾选标记，用来判断「是不是被改过内容」 */
function stripMarks(plan) {
  return (Array.isArray(plan) ? plan : []).map((line) =>
    String(line).replace(/^\s*\[[xX ]\]\s*/, ''),
  )
}

/**
 * 组装注入文本。没有未完成任务就返回空串（调用方据此不注入这一层）。
 *
 * `taskId` 用来标出「当前正在做的那条」，其余只列标题 —— 并行跑多条对话时，
 * 模型需要知道自己手上是哪一条，否则容易把别的任务的计划当成自己的。
 */
/**
 * AG-018：用户这句话是不是「接着刚才的做」？
 *
 * ★ 要小心别把「继续优化 Agent 执行系统」当成继续 —— 那是新任务。
 *   所以两条约束：**句子短**（超过 15 字基本是在描述新要求）、
 *   **模式明确**（「继续」后面只接「改/做/干/写/弄/来」这类光杆动词，不接宾语）。
 *
 * 文档点名的几种：继续 / 然后呢 / 继续改 / 接着做 / 还是刚才那个问题。
 */
const CONTINUE_RE = [
  /^(继续|接着|然后呢|往下|接着来|再来)$/,
  /^(继续|接着)(改|做|干|写|弄|来|吧|下去|往下)?$/,
  /(接着做|接着干|继续做|继续改|继续弄|还是刚才|刚才那个|上一步|上一次那个)/,
  /^(go on|continue|keep going)$/i,
]

function isContinueIntent(text) {
  const t = String(text ?? '')
    .trim()
    .replace(/[。！!？?~～\s]+$/, '')
  /* 15 字：真机调出来的。30 字太松 —— 「接着把刚才那个模块重构一下，另外还要
     加上日志和错误处理」会被当成继续，那明明是**新要求**。宁可漏判（当成新任务
     再问一句）也不要误判（把新活儿当成接着做）。 */
  if (!t || t.length > 15) return false
  return CONTINUE_RE.some((re) => re.test(t))
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
  if (ordered.length === 0) return ''

  /* 诊断用：确认「用户在说继续」这条真的被认出来了（taskState 不落盘） */
  if (isContinueIntent(userText)) {
    log.info(`任务连续性：用户说「${String(userText).trim()}」，已注入「接着做」提示`)
  }

  const blocks = []
  for (const task of ordered) {
    const isCurrent = task.id === taskId || (sessionId && task.sessionId === sessionId)
    const head = `${isCurrent ? '▶' : '·'} [${task.status}] ${task.title || '(无标题)'}`
    const lines = [head]
    if (task.goal) lines.push(`  目标：${String(task.goal).slice(0, 160)}`)

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
    '做完一步就把那一条标成 `[x]`（用 ```plan 块给出更新后的完整计划）。',
    '如果某一步其实不需要做了，也在计划里说明理由，不要默默跳过。',
    /*
     * AG-018：用户在说「继续」时，把话说死。
     *
     * 不做这一步的话，模型有可能会把「继续」当成一个含糊的新要求 ——
     * 重新问一遍背景，或者干脆重头讲一遍计划。
     */
    isContinueIntent(userText)
      ? `\n（用户这句「${String(userText).trim()}」是在说**接着做** —— 目标是上面那条任务，不是新任务。先看计划进度和最近一步，从停住的地方往下走；缺上下文就查最近工具结果，别从头再问一遍。）`
      : '',
    '',
    blocks.join('\n\n'),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * 完成门禁：模型想收工时，判断要不要把它顶回去。
 *
 * @returns {{ continue: boolean, message?: string, seen: object }}
 *   `seen` 要原样存下来，下一轮再传进来 —— 次数和进度快照都靠它。
 */
function shouldContinue({ taskId = '', content = '', seen = {} } = {}) {
  const blocks = Number(seen.blocks) || 0

  /* 刹车一：顶够次数就放行 */
  if (blocks >= MAX_BLOCKS) return { continue: false, seen }

  let task = null
  try {
    task = taskId ? taskCore.get(taskId) : null
  } catch {
    task = null
  }
  if (!task || task.status !== 'running') return { continue: false, seen }
  /* 注意：只拦 running。paused 是用户主动停的、waiting_user 是在等用户回话 ——
     这两种情况下「不让模型收工」都是骚扰。 */

  const plan = task.plan ?? []
  const { done, total } = progressOf(plan)
  /* 没有计划、或计划已经全勾完 → 不拦 */
  if (total === 0 || done >= total) return { continue: false, seen }

  /* 刹车二：停滞检测。上一轮也是这个进度、而且已经顶过一次 → 说明顶没用，放行 */
  const snapshot = `${task.id}:${done}/${total}`
  if (seen.snapshot === snapshot && blocks > 0) return { continue: false, seen }

  const next = plan.find((line) => !isDone(line)) ?? ''
  const message = [
    `任务「${task.title || task.id}」的计划还没做完（${done}/${total}），先别收尾。`,
    next ? `下一条是：${String(next).replace(/^\s*\[[xX ]\]\s*/, '')}` : '',
    '做完后用 ```plan 块给出**更新后的完整计划**（完成的标 `[x]`），再收尾。',
    '如果这活其实已经不需要做了，直接说明原因并把计划里对应条目标记完成。',
  ]
    .filter(Boolean)
    .join('\n')

  return { continue: true, message, seen: { blocks: blocks + 1, snapshot } }
}

/**
 * 模型回复里如果给了 ```plan 块，存进任务。
 *
 * 只看第一次：后面再给的多半是对计划的修正，界面上会跳来跳去。
 * 而「更新计划」走的是模型重发完整计划（带 `[x]` 标记），也走这里。
 *
 * @returns {string[]|null} 存下来的计划；没有就返回 null
 */
/**
 * 从回复里抓计划（AG-004）。**变了才返回**，两个原因：
 *
 * ① 模型每一轮都会把计划原样复述一遍（上下文里就有），不判断就得每轮发事件，
 *    一次对话刷出几十条一模一样的计划，界面一直在闪；
 * ② 以前只抓「第一次」，模型后来重新规划（用户改了要求、或发现路走不通）
 *    会被**静默丢弃** —— 现在每轮都给它看，变没变由这里说了算。
 *
 * @returns {{ plan: string[], version: number, reason: string }|null}
 */
function capturePlan({ taskId = '', content = '' } = {}) {
  if (!taskId) return null
  const plan = taskCore.parsePlan(content)
  if (plan.length === 0) return null
  const result = taskCore.setPlan(taskId, plan)
  if (!result || !result.changed) return null
  return { plan: result.task.plan, version: result.version, reason: result.reason }
}

module.exports = {
  buildTaskState,
  shouldContinue,
  capturePlan,
  progressOf,
  fingerprint,
  stripMarks,
  isDone,
  resetProgressMemory,
  isContinueIntent,
}
