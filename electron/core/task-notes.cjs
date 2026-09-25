/**
 * 往任务台账上记账（AG-035 拆分）
 *
 * 从 `task.cjs` 分出来的 —— 那边 325 行贴顶了。切法是按**职责**切的：
 *
 *   · `task-io.cjs`    —— 放哪、怎么序列化（底座，不认识业务）
 *   · `task.cjs`       —— 任务是什么、状态怎么变（create / update / list / 计划）
 *   · `task-notes.cjs` —— **往台账上追加一件事**（这一步、这条命令、这个文件、
 *                         这次授权、这只模型、这次检查点、失败原因）
 *
 * 记账这一步看着琐碎，其实正是 AG-035「自动 Checkpoint」的落点：出问题时
 * 诊断报告能说出话，全靠这里留下了痕迹。所以单独一个文件，别混进状态机里。
 */

const io = require('./task-io.cjs')
const redact = require('./redact.cjs')
const outcome = require('./task-outcome.cjs')

/** 记一次工具调用 */
function addStep(id, { tool, ok, summary, ms = 0, args }) {
  const task = io.get(id)
  if (!task) return null

  task.steps.push({
    at: Date.now(),
    tool: String(tool ?? ''),
    ok: ok !== false,
    ms,
    summary: String(summary ?? '').slice(0, 300),
    args: args ? redact.scrubLight(args) : undefined,
  })

  /* 只留最近 200 步 —— 这个文件是给自己看的，不是流水账 */
  if (task.steps.length > 200) task.steps = task.steps.slice(-200)
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/** 记一次文件改动 */
function addChangedFile(id, file, extra = {}) {
  const task = io.get(id)
  if (!task) return null
  const absolute = String(file)
  if (!task.changedFiles.some((f) => f.path === absolute)) {
    task.changedFiles.push({ path: absolute, at: Date.now(), ...extra })
  }
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/** 记一次命令 */
function addCommand(id, command, result = '') {
  const task = io.get(id)
  if (!task) return null
  task.commands.push({
    command: String(command).slice(0, 500),
    result: String(result).slice(0, 300),
    /* AG-034：退出码单独存 —— result 截到 300 字，尾巴上的 `[退出码 N]` 常常被截掉 */
    exitOk: outcome.exitOf(result),
    at: Date.now(),
  })
  if (task.commands.length > 100) task.commands = task.commands.slice(-100)
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/**
 * 记下这次用的模型（AG-035）。
 * 只在换模型时才写盘 —— 同一轮里每次调用都记一遍纯属浪费。
 */
function recordModel(id, model) {
  const task = io.get(id)
  const name = String(model ?? '').trim()
  if (!task || !name) return null
  if (task.model === name) return task

  const models = [...(task.models ?? [])]
  if (!models.includes(name)) models.push(name)
  task.model = name
  task.models = models
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/**
 * 记一次「用户在执行中改了方向」（AG-043）。
 *
 * 存的是用户的原话 —— 复盘时最有用的就是这句，别改写。
 * 只留最近 20 条：这是给人看的线索，不是聊天记录。
 */
function addSteering(id, text) {
  const task = io.get(id)
  const said = String(text ?? '').trim()
  if (!task || !said) return null
  const list = [...(task.steering ?? []), { at: Date.now(), text: said.slice(0, 500) }]
  task.steering = list.slice(-20)
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/** 打检查点 —— **崩溃后靠它恢复** */
function checkpoint(id, { label, note = '', files = [], commands = [] } = {}) {
  const task = io.get(id)
  if (!task) return null
  task.checkpoints.push({
    at: Date.now(),
    label: String(label ?? '检查点').slice(0, 120),
    note: String(note ?? '').slice(0, 500),
    files,
    commands,
  })
  if (task.checkpoints.length > 50) task.checkpoints = task.checkpoints.slice(-50)
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

function fail(id, error) {
  const task = io.get(id)
  if (!task) return null
  task.errors.push({ at: Date.now(), message: String(error).slice(0, 500) })
  task.status = 'failed'
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/**
 * 记下这次用的提示词版本（②-1）。
 *
 * 为什么值得单独记：提示词就是**代码**（改一句话就换一种行为），但它的改动
 * 只在 CHANGELOG 里留痕 —— 代码里没有版本号，于是「同一个任务为什么前后表现
 * 不一样」只能靠猜。记下版本之后，同一个 `prompt-stack/N` 的结果才谈得上横向比。
 *
 * 和 recordModel 一样：同一版只写一次盘。
 */
function recordPromptVersion(id, version) {
  const task = io.get(id)
  const tag = String(version ?? '').trim()
  if (!task || !tag) return null
  if (task.promptVersion === tag) return task

  task.promptVersion = tag
  /* 一个任务中途换了版本（比如升了版本再「继续」）也要看得见 */
  task.promptVersions = [...new Set([...(task.promptVersions ?? []), tag])]
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/**
 * 记分层诊断（token 优化）：每次 buildPromptContext 算出来的三层 hash 与「稳定前缀变了没」。
 * 只留最近 20 条（每条 ~600B）—— 够追「哪一轮前缀变了、变在哪一层」，不把台账吹大。
 */
function recordPromptDiag(id, diag) {
  const task = io.get(id)
  if (!task || !diag || typeof diag !== 'object') return null
  task.promptDiag = {
    at: diag.at ?? Date.now(),
    stablePrefixHash: diag.stablePrefixHash ?? '',
    lowFrequencyHash: diag.lowFrequencyHash ?? '',
    dynamicContextHash: diag.dynamicContextHash ?? '',
    stablePrefixChanged: diag.stablePrefixChanged === true,
    stablePrefixChangeReason: String(diag.stablePrefixChangeReason ?? '').slice(0, 200),
    contextTokensByLayer: diag.contextTokensByLayer ?? {},
  }
  const ring = Array.isArray(task.promptDiags) ? task.promptDiags : []
  ring.push({ at: task.promptDiag.at, stablePrefixHash: task.promptDiag.stablePrefixHash, low: task.promptDiag.lowFrequencyHash, changed: task.promptDiag.stablePrefixChanged, reason: task.promptDiag.stablePrefixChangeReason })
  task.promptDiags = ring.slice(-20)
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/** 记命中的任务模板（阶段 4）—— 复盘时按 template_id@version 归组比较 */
function recordTemplate(id, hit) {
  const task = io.get(id)
  if (!task || !hit?.id) return null
  task.templateId = String(hit.id)
  task.templateVersion = Number(hit.version) || 1
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/** 工具调用统计（阶段 2）：调用数 / 无效（重复+参数不合法）/ 重复 / 缓存命中 */
function bumpToolStats(id, delta = {}) {
  const task = io.get(id)
  if (!task) return null
  const cur = task.toolStats ?? { calls: 0, invalid: 0, duplicates: 0, cacheHits: 0 }
  task.toolStats = {
    calls: (Number(cur.calls) || 0) + (Number(delta.calls) || 0),
    invalid: (Number(cur.invalid) || 0) + (Number(delta.invalid) || 0),
    duplicates: (Number(cur.duplicates) || 0) + (Number(delta.duplicates) || 0),
    cacheHits: (Number(cur.cacheHits) || 0) + (Number(delta.cacheHits) || 0),
  }
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

module.exports = {
  addStep,
  addChangedFile,
  addCommand,
  recordModel,
  recordPromptVersion,
  addSteering,
  checkpoint,
  fail,
  recordPromptDiag,
  recordTemplate,
  bumpToolStats,
}
