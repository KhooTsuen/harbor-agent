/**
 * 工具执行的「意图 / 结果」两段记账 —— 让一次执行变得**可判定**
 *
 * 为什么单独一个文件：`task.cjs`（267 行）再塞进两个辅助函数就破 300 行红线，
 * 而这两个函数讲的是另一件事：**「这条命令到底执行了没有」**。
 *
 * 一条 `run_shell` 在磁盘上留两道痕：
 *
 *   ① `execute()` 调 `run()` **之前** → `markIntent()`：step 上写
 *      `intent: { tool, commandHash, startedAt }` + `completed: false`
 *   ② `run()` 返回（或抛错）**之后** → `markCompleted()`：写 `completed: true`、
 *      `ok`、`outcome`、`summary` —— **成败都要写**
 *
 * 于是「进程在这条命令跑到一半时被强杀」只剩一个特征：磁盘上留着一条
 * `completed: false` 的意图。恢复器看到它就明白「这条命令动过、但结果不明」，
 * 不能当它没跑过直接重跑 —— 重跑一条已经产生副作用的命令是危险的。
 *
 * ★ 顺序是铁律：**先落意图、再执行**。颠倒过来就退化成「执行 → 记录结果」，
 *   崩在中间那条命令完全不留痕，恢复器只好重跑。`io.write` 走的是
 *   `writeFileSync`（同步），所以「`run()` 开始时意图已经在盘上」是确定的。
 *
 * 两个字段都是**可选**的：老台账里的 step 既没有 `intent` 也没有 `completed`，
 * 读的时候按「不可判定」处理（见 `isPending`），不许当成「没跑过」。
 */
const crypto = require('node:crypto')
const io = require('./task-io.cjs')
const redact = require('./redact.cjs')

/** 指纹只取前 12 位：用途是「是不是同一条命令」，不是安全边界 */
const HASH_LEN = 12
/** 和 task-notes.addStep 同一个上限：台账是给自己看的，不是流水账 */
const STEP_LIMIT = 200
/** pending 占位摘要 —— 崩在现场时，诊断报告上看到的就是这一句 */
const PENDING = '（已记录执行意图，结果未落盘）'

/**
 * 命令指纹：`sha256(原文).slice(0, 12)`。
 *
 * 刻意不 trim：指纹要对得上**模型当时给的那条**命令；空命令也有指纹（不是空串）。
 */
function commandHash(command) {
  return crypto
    .createHash('sha256')
    .update(String(command ?? ''), 'utf8')
    .digest('hex')
    .slice(0, HASH_LEN)
}

/*
 * stepId 长这样：`s<开始毫秒>_<进程内序号>`。
 *
 * 不用随机数：同一条命令在同一毫秒里连发两次，靠序号才分得开。
 * 也不用「数组下标」：`addStep` 会把 steps 截到最近 200 条，下标会漂，
 * 而恢复时要能靠这个 id 找回「还没落结果的那一条」。
 */
let seq = 0
function stepIdFor(startedAt = Date.now()) {
  seq += 1
  return `s${Number(startedAt) || Date.now()}_${seq}`
}

function findStep(task, stepId) {
  return (Array.isArray(task.steps) ? task.steps : []).find((step) => step.id === stepId) ?? null
}

/**
 * 写「意图」—— **必须在执行之前**调用。
 *
 * 台账里还没有这条 step 就补一条 pending（`completed: false`）；已经有就只更新
 * `intent`（同一个 stepId 重入时，不该在台账里留下两条）。
 *
 * @param {string} taskId
 * @param {string} stepId `stepIdFor()` 生成的
 * @param {{ tool?: string, commandHash?: string, startedAt?: number }} intent
 * @returns {object|null} 写进去的那条 step；拿不到任务（或没 stepId）返回 null
 */
function markIntent(taskId, stepId, intent = {}) {
  const task = io.get(String(taskId ?? ''))
  if (!task || !stepId) return null
  if (!Array.isArray(task.steps)) task.steps = []

  const record = {
    tool: String(intent.tool ?? ''),
    commandHash: String(intent.commandHash ?? ''),
    startedAt: Number(intent.startedAt) || Date.now(),
  }

  let step = findStep(task, stepId)
  if (!step) {
    step = {
      id: stepId,
      at: record.startedAt,
      tool: record.tool,
      /* 意图阶段不算失败 —— 成败要等结果落盘才说得清 */
      ok: true,
      ms: 0,
      summary: PENDING,
      intent: record,
      completed: false,
    }
    task.steps.push(step)
    if (task.steps.length > STEP_LIMIT) task.steps = task.steps.slice(-STEP_LIMIT)
  } else {
    step.intent = record
    step.completed = false
  }

  task.updatedAt = io.monotonicNow()
  io.write(task)
  return step
}

/**
 * 写「结果」—— 执行之后调用，**成功失败都要写**。
 *
 * `completed: true` 只说「这条执行有结论了」，成败看 `ok` / `outcome`。
 * 这两件事必须分开：混成一个布尔，恢复器就分不出
 * 「失败（副作用已经发生了，绝不能重跑）」和「结果不明（可能要重跑，但要先问）」。
 *
 * @param {string} taskId
 * @param {string} stepId
 * @param {{ ok?: boolean, summary?: string, ms?: number }} result 不传 ok 视为成功
 * @returns {object|null} 更新后的 step
 */
function markCompleted(taskId, stepId, result = {}) {
  const task = io.get(String(taskId ?? ''))
  if (!task || !stepId) return null
  const step = findStep(task, stepId)
  if (!step) return null

  const ok = result.ok !== false
  step.completed = true
  step.ok = ok
  step.outcome = ok ? 'ok' : 'failed'
  /* 工具输出是**外部数据**，落盘前过一遍脱敏（规矩只有一处，见 redact.cjs） */
  step.summary = redact.redact(String(result.summary ?? '')).slice(0, 300)
  step.ms = Number(result.ms) || 0
  step.finishedAt = Date.now()

  task.updatedAt = io.monotonicNow()
  io.write(task)
  return step
}

/**
 * 这条意图还在飞（有 `intent` 但没落结果）—— 恢复器判断「可能要重跑」就看它。
 *
 * 老式子（没有 `intent` 的）返回 false：那属于**不可判定**，不是「在飞」。
 */
function isPending(step) {
  return Boolean(step?.intent) && step?.completed !== true
}

/**
 * 一次 `run_shell` 的开场：算指纹 + 生成 stepId + 落意图，返回 stepId。
 *
 * 包这一层是给 `tools/index.cjs` 用的 —— 那个文件贴着 300 行红线，多两行都放不下，
 * 而「先落意图后执行」的规矩在这个文件里能说得更完整。不是 `run_shell` 直接
 * 返回空串（意图**只覆盖 shell**，先做这一条）；拿不到任务（没有 taskId、
 * 或任务不在盘上）也是空串，调用方据此跳过收尾。
 */
function beginShell(taskId, name, args, startedAt = Date.now()) {
  if (!taskId || name !== 'run_shell') return ''
  const stepId = stepIdFor(startedAt)
  const written = markIntent(taskId, stepId, {
    tool: name,
    commandHash: commandHash(args?.command),
    startedAt,
  })
  return written ? stepId : ''
}

/**
 * 收尾：把结果落到那条意图上（成功失败都调）。`ms` 由意图里的 `startedAt` 算出来，
 * 免得调用方再记一次时间（也免得两个时间戳对不上）。
 */
function endShell(taskId, stepId, { ok, summary } = {}) {
  if (!stepId) return null
  const task = io.get(String(taskId ?? ''))
  const step = task ? findStep(task, stepId) : null
  const ms = step?.intent?.startedAt ? Date.now() - step.intent.startedAt : 0
  return markCompleted(taskId, stepId, { ok, summary, ms })
}

module.exports = {
  PENDING,
  commandHash,
  stepIdFor,
  markIntent,
  markCompleted,
  isPending,
  beginShell,
  endShell,
}
