/**
 * 写工具入口的两道硬化闸 —— 让「先给计划再动手」「开工前先问清楚」真的会拦
 *
 * 为什么需要这个文件：这两个开关原来**只改提示词**（`prompt-rules.cjs` 决定那段话
 * 注不注入）。用户点一下，配置变了、提示词少了那段，但内核里没有任何一处拿它去判断
 * 「这次调用要不要放行」。2026-11-01 用户原话：「我想要点击之后真正的起作用，
 * 而不是靠提示句来约束」。
 *
 * ★ 能硬化的前提是**判据必须客观**。所以两个开关的判据都换成了内核可核验的事实，
 *   不去解析模型说了什么、也不猜「这需求含不含糊」（那是语义，正则读不出来）：
 *
 *   · `planFirst`（B 闸）→ 本任务**已经改过 ≥1 个文件、计划却还是空的**。
 *     为什么不是「第一次写就拦」：改一个文件的活本来就是一句 `# 任务名` 都嫌多的
 *     小事，第一次就拦会变成每轮无意义的往返。**已经动过一次手还要继续动**，
 *     才说明这是多步的活 —— 那时候该有计划了。
 *
 *   · `clarifyFirst`（C 闸）→ **覆盖一个已经存在的文件**，而本任务还没问过用户。
 *     这是「不可逆」的客观定义：新建文件错了删掉就行，覆盖就是把别人原来的内容
 *     冲掉了（`write_file` 的 `snapshotBefore` 能救，但用户没被告知就没意义）。
 *     ⚠️ 这是**换语义**，不是实现原语义 —— 原语义「需求含糊就先问」没有可判据的
 *     客观形式。用户 2026-11-01 明确点头接受这个替换。
 *
 * 刹车（沿用 `task-strict.cjs` 的三条思路，缺一条都会把模型卡死）：
 *   ① 每道闸**每条任务只拦一次** —— 第二次还拦，模型就陷在原地出不来；
 *   ② 不是 running 的任务不管（paused / waiting_user 是在等用户，拦它没道理）；
 *   ③ 没有任务上下文（普通聊天、自检直接调工具）不拦 —— 那是老行为，一字不改。
 *
 * 状态是**进程内 Map**：不落盘、不改任何数据结构、不进 `task.steps`。
 * 重启后清空是**刻意的** —— 「本次任务问过没有」本来就是一次执行内的事，
 * 重启之后是新的一条任务，本来就该重新问。
 */

const fs = require('node:fs')
const { resolvePath } = require('./_shared.cjs')

/**
 * 这道闸管哪些工具：**只会有 `path` 的那两个**。
 *
 * 不收 `run_shell`：它的不可逆性由风险闸（`risk.cjs` / `risk-gate.cjs`）管，
 * 那边已经有「危险命令该拒就拒」的判据，这里再叠一层只会重复拦截同一条命令。
 * 也不收 `apply_test_fix` / `restore_test_fix`：它们自带审批卡（含真实 diff），
 * 再拦一次就是同一个动作问两遍。
 */
const TARGET_TOOLS = new Set(['write_file', 'edit_file'])

/** 进程内状态：taskId → { asked, blockedPlan, blockedAsk } */
const seen = new Map()
const SEEN_CAP = 100

const stateFor = (taskId) => {
  let st = seen.get(taskId)
  if (!st) {
    st = { asked: false, blockedPlan: false, blockedAsk: false }
    seen.set(taskId, st)
    if (seen.size > SEEN_CAP) seen.delete(seen.keys().next().value)
  }
  return st
}

/**
 * 开关开着吗。读不到 = **关**（宁可不拦，也别因为读配置失败把用户卡住）。
 * 写法和 `task-strict.cjs` 的 `strictEnabled` 一致：默认值是 true，所以判据是
 * `!== false` 而不是 `=== true`。
 */
function flagOn(key) {
  try {
    return require('../config.cjs').get()?.assistant?.[key] !== false
  } catch {
    return false
  }
}

/** 台账里成功改过几次文件（失败的不算 —— 与 `task-strict` 的 isWrite 同口径） */
function writesOf(task) {
  const steps = Array.isArray(task?.steps) ? task.steps : []
  return steps.filter((s) => TARGET_TOOLS.has(String(s.tool ?? '')) && s.ok !== false).length
}

/** 计划还是空的（模型一次计划块都没给过） */
function planEmpty(task) {
  return !Array.isArray(task?.plan) || task.plan.length === 0
}

/** 这次会不会覆盖一个已经存在的文件 —— 「不可逆」的客观定义 */
function overwrites(args, ctx) {
  try {
    const file = resolvePath(String(args?.path ?? ''), ctx.workdir, ctx)
    return Boolean(file) && fs.existsSync(file)
  } catch {
    /* 路径都解不出来：交给下游的路径授权去报错，这里不拦 */
    return false
  }
}

/* 话术里都写清**怎么脱身** —— 只拦不说，模型只会原地重试同一个调用。 */

const PLAN_TEXT = [
  '拦下了：这次要改文件，但本任务已经动过手了，计划却还是空的。',
  '设置里「先给计划再动手」是开着的，这一步是内核拦的（不是提示）。',
  '先发一个 ```plan 块（第一行 `# 任务名`，下面每行一条步骤，做完的标 `[x]`），再继续改文件。',
  '如果这活确实只有一步、不值得给计划，就在回复里说清「只有一步：……」然后重发这次调用。',
].join('\n')

const ASK_TEXT = [
  '拦下了：这次要**覆盖一个已经存在的文件**（原内容会被冲掉），但本任务还没问过用户。',
  '设置里「开工前先问清楚」是开着的，这一步是内核拦的（不是提示）。',
  '先调 `ask_user({ gate: true, question: "..." })` 把「要改哪个文件、改成什么样」摆出来，等用户点头。',
  '用户点了「执行」之后重发这次调用即可；他要是不点，就停手，别换个写法绕过去。',
].join('\n')

/**
 * 写工具执行前的闸门。
 *
 * @param {{ name: string, args: Record<string, unknown>, ctx: object,
 *           switches?: { planFirst?: boolean, clarifyFirst?: boolean } }} input
 *   `switches` 只在自检里注入；生产路径不传 → 问 config（见 `flagOn`）。
 * @returns {string} 空串 = 放行；非空 = 拦下的理由（直接当作工具结果还给模型）
 */
function check({ name, args, ctx, switches }) {
  if (!TARGET_TOOLS.has(name)) return ''
  const taskId = String(ctx?.taskId ?? '')
  if (!taskId) return ''

  let task = null
  try {
    task = require('../task.cjs').get(taskId)
  } catch {
    return ''
  }
  if (!task || task.status !== 'running') return ''

  const on = (key) => (typeof switches?.[key] === 'boolean' ? switches[key] : flagOn(key))
  const st = stateFor(taskId)

  /* C 闸：覆盖已有文件 = 不可逆。问过一次就不再管（用户点头就是点头了）。 */
  if (!st.asked && !st.blockAsk && on('clarifyFirst') && overwrites(args, ctx)) {
    st.blockAsk = true
    return ASK_TEXT
  }

  /* B 闸：已经改过至少一个文件、计划还是空的 → 这是多步的活，该有计划了 */
  if (!st.blockPlan && on('planFirst') && writesOf(task) >= 1 && planEmpty(task)) {
    st.blockPlan = true
    return PLAN_TEXT
  }

  return ''
}

/**
 * 记下「这条任务里问过用户了」—— 由 `ask_user` 成功后调用。
 *
 * 只认**真的问出去了**的那一次：`ask_user` 在拿不到澄清通道时会退化成
 * 「按你自己判断开工」，那不算问过，不能拿它当通行证。
 */
function noteAsked(taskId) {
  const id = String(taskId ?? '')
  if (!id) return
  stateFor(id).asked = true
}

/** 自检用：清掉观察锚（不进生产路径） */
function reset() {
  seen.clear()
}

module.exports = { check, noteAsked, reset, TARGET_TOOLS, PLAN_TEXT, ASK_TEXT }
