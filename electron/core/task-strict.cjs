/**
 * 严格模式（CE-008 · Phase 6 批次 3）—— 「验证欠账」的门禁判据
 *
 * 把批次 1/2 的**软约束**升级为**基于内核结构化事实的硬门禁**（只做这件事）：
 *
 *   · 判据只读 `task.steps` 的结构化事件（write_file / edit_file / run_shell
 *     的真实执行记录）与计划的勾选数 —— **绝不解析模型自然语言**；
 *     也**不猜「计划第 N 条对应哪个工具」**（内核没有这个归属事实，猜错会误拦）。
 *   · **中途**（每轮工具跑完，tool-runner 调用 `strictGate`）：每累计 3 次写操作、
 *     或勾掉计划之后还没跑过命令 → 往对话里顶一句「先验证再继续」。
 *   · **收尾**（模型想结束，task-steering 的两道门禁调用）：
 *     `strictBacklog` / `strictPlanPending` —— 有欠账就不许收工。
 *
 * 开关：`assistant.strictMode`（默认关）。读相照 `tools/scale-gate.cjs` 的写法：
 *   调用方给了布尔就用它（自检注入），没给就问 `config`（归一化保证干净）；
 *   读不到 = 关 —— 宁可不拦，也不能因为读配置失败把用户卡住。
 *
 * 状态与刹车：`strictSeen` 是**进程内的观察锚**（按 taskId 存；不是台账字段，
 * 不落盘、不改数据结构）。它只回答「上次见到命令时、计划勾到第几条」，
 * 用来判断「勾了之后还没验证」。刹车三条（和收尾门禁一个思路）：
 *   ① 同一条欠账只顶一次（快照去重）；② 每条欠账期最多顶 3 次；
 *   ③ 不是 running 的任务不管 —— 顶够了就放行，不能让模型被卡死在这儿。
 */

const log = require('./log.cjs')
const taskCore = require('./task.cjs')
const { progressOf } = require('./task-plan.cjs')
/* CE-016：推理语言的中文占比 —— 与 isMostlyEnglish 共用同一套字符统计（不另写一份数法） */
const { chineseRatio } = require('./language-drift.cjs')

/** 会改文件的工具（与 task-steering 的 WRITE_TOOLS 同口径 —— 判据只有这两类） */
const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

/** 「每累计 N 次写操作」的 N（批次 3 要求：3） */
const STRICT_MIN_WRITES = 3

/** 同一条欠账期里最多顶回几次（与收尾门禁的 MAX_BLOCKS 同数，顶够就放行） */
const MAX_PUSHES = 3

/** CE-016：推理中文占比低于它 → 收尾记一条 warning（观察项，不拦） */
const LOW_CHINESE_RATIO = 0.5

/** 进程内观察锚（taskId → 计数）；只影响「顶不顶」，不影响任何落盘数据 */
const strictSeen = new Map()
const SEEN_CAP = 100

/**
 * 严格模式开着吗。`explicit` 为布尔就用它（自检/测试注入）；否则问 config；
 * 读不到 = false（宁可不拦，也别因为读配置失败把用户卡住）。
 */
function strictEnabled(explicit) {
  if (explicit === true) return true
  if (explicit === false) return false
  try {
    return require('./config.cjs').get()?.assistant?.strictMode === true
  } catch {
    return false
  }
}

const stepsOf = (task) => (Array.isArray(task?.steps) ? task.steps : [])

/** 台账里的写操作（失败的不算 —— 与收尾门禁同口径） */
const isWrite = (s) => WRITE_TOOLS.has(String(s.tool ?? '')) && s.ok !== false

/**
 * 「写欠账」：最后一次 run_shell 之后累计着几次写（纯函数，只读 steps）。
 * ≥1 ⟺ 「有未验证的写操作」；≥3 ⟺ 触发中途门禁的「每累计 N 次」。
 */
function strictBacklog(task) {
  const steps = stepsOf(task)
  let lastRun = -1
  steps.forEach((s, i) => {
    if (String(s.tool ?? '') === 'run_shell') lastRun = i
  })
  return steps.slice(lastRun + 1).filter(isWrite).length
}

/** 「跑过几次命令」（纯函数） */
function runCount(task) {
  return stepsOf(task).filter((s) => String(s.tool ?? '') === 'run_shell').length
}

/** 当前观察锚：命令数 + 计划勾选数 */
function anchorOf(task) {
  return { runs: runCount(task), done: progressOf(task?.plan ?? []).done }
}

/**
 * 取（或建）这条任务的观察锚；**见到新命令就重新锚定**——
 * 一次验证发生了，欠账期清零、推送预算恢复。
 */
function stateFor(taskId, anchor) {
  let st = strictSeen.get(taskId)
  if (!st) {
    st = { runs: anchor.runs, doneAtRun: anchor.done, pushAtWrites: -1, pushAtDone: -1, pushes: 0 }
    strictSeen.set(taskId, st)
    if (strictSeen.size > SEEN_CAP) strictSeen.delete(strictSeen.keys().next().value)
    return st
  }
  if (anchor.runs > st.runs) {
    st.runs = anchor.runs
    st.doneAtRun = anchor.done
    st.pushAtWrites = -1
    st.pushAtDone = -1
    st.pushes = 0
  }
  return st
}

/**
 * 中途门禁：每轮工具跑完后调用。
 *
 * @param {{ taskId?: string, enabled?: boolean }} input
 * @returns {{ message: string, reason?: string }} message 为空 = 不顶
 */
function strictGate(input = {}) {
  const { taskId = '', enabled } = input
  if (!strictEnabled(enabled)) return { message: '' }
  let task = null
  try {
    task = taskId ? taskCore.get(taskId) : null
  } catch {
    task = null
  }
  if (!task || task.status !== 'running') return { message: '' }

  const anchor = anchorOf(task)
  const st = stateFor(taskId, anchor)
  if (st.pushes >= MAX_PUSHES) return { message: '' }

  const facts = []
  const backlog = strictBacklog(task)
  /* 「每累计 N 次写操作」：3、6、9… 各顶一次（不是每多写一次就唠叨一句） */
  const nextAt = st.pushAtWrites < 0 ? STRICT_MIN_WRITES : st.pushAtWrites + STRICT_MIN_WRITES
  if (backlog >= nextAt) {
    facts.push(`你已连续改了 ${backlog} 次文件（write_file / edit_file），但一条验证命令都没跑过`)
    st.pushAtWrites = backlog
  }
  if (anchor.done > st.doneAtRun && st.pushAtDone !== anchor.done) {
    facts.push('计划里勾掉了步骤，但勾掉之后还没跑过任何命令')
    st.pushAtDone = anchor.done
  }
  if (facts.length === 0) return { message: '' }

  st.pushes += 1
  const reason = facts.join('；')
  log.info(`严格模式：顶回一句要求验证（${reason}）`)
  return {
    message: [
      `【严格模式】${reason}。`,
      '先跑一次验证命令（测试 / lint / 构建；没有就跑个能证明结果的东西），再继续下一步。',
    ].join('\n'),
    reason,
  }
}

/**
 * 收尾检查②（给 shouldVerify）：「计划勾了、但勾后没验证」吗。
 * 只认**观察过**的任务（strictGate 没跑过 → 不猜，返回 false）。
 * @returns {{ pending: boolean, done: number }}
 */
function strictPlanPending(task) {
  const st = task ? strictSeen.get(task.id) : null
  if (!st) return { pending: false, done: 0 }
  const anchor = anchorOf(task)
  const cur = stateFor(task.id, anchor)
  return { pending: anchor.done > cur.doneAtRun, done: anchor.done }
}

/**
 * 收尾观察项（CE-016）：整段推理的**中文占比**是不是太低（语言整体跑偏了）。
 *
 * ★ **只是观察，不是硬门禁** —— 只往日志里记一条 warning：
 *   不推回模型、不改任务状态、不影响这一轮能不能收工。
 *   理由：推理语言好不好没有「对错」判据（路径 / 工具名 / 代码本就该是英文），
 *   拿它拦人会误伤；先攒观察数据，将来要收紧也才有依据。
 *
 * 统计不出来（没推理 / 空串 / 非字符串）→ **跳过**，不报错、不告警。
 *
 * @param {unknown} reasoning 这次 run 攒下来的全部推理文本
 * @returns {{ ratio: number|null, warned: boolean }}
 */
function noteChineseReasoning(reasoning) {
  const ratio = chineseRatio(reasoning)
  if (ratio === null) return { ratio: null, warned: false }
  if (ratio >= LOW_CHINESE_RATIO) return { ratio, warned: false }
  log.warn(
    `收尾观察（CE-016）：本次推理中文占比 ${(ratio * 100).toFixed(0)}%（低于 ${LOW_CHINESE_RATIO * 100}%）` +
      ' —— 可能语言漂移，只记录、不拦任务。',
  )
  return { ratio, warned: true }
}

/** 收尾拦截话术（写欠账）—— shouldContinue 顶回去用 */
function strictStopMessage(backlog) {
  return [
    `【严格模式】你改了 ${backlog} 次文件之后还没跑过任何命令 —— 未验证不得收工。`,
    '先跑一次验证（测试 / lint / 构建），说清结果；确实没法验证（只改了纯文字之类）就说明原因。',
  ].join('\n')
}

/** 收尾拦截话术（计划勾选欠账）—— shouldVerify 顶回去用 */
const STRICT_PLAN_MESSAGE = [
  '【严格模式】计划里勾掉了步骤，但勾掉之后还没跑过任何命令 —— 未验证不得收工。',
  '先跑一次验证命令（测试 / lint / 构建），说清结果再收尾。',
].join('\n')

/**
 * 中途门禁的投递（tool-runner 每轮工具跑完后调用一行）。
 * 判据 / 话术 / 投递一处说全；messages 不是数组时安静放行（自检/探针的兜底）。
 * @returns {string} 顶回去的那句话（'' = 没顶）
 */
function pushStrictNote(messages, taskId) {
  if (!Array.isArray(messages)) return ''
  const note = strictGate({ taskId })
  if (note.message) messages.push({ role: 'user', content: note.message })
  return note.message
}

module.exports = {
  strictEnabled,
  strictGate,
  strictBacklog,
  strictPlanPending,
  strictStopMessage,
  pushStrictNote,
  noteChineseReasoning,
  STRICT_PLAN_MESSAGE,
  STRICT_MIN_WRITES,
  MAX_PUSHES,
  LOW_CHINESE_RATIO,
}
