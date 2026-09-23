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

module.exports = {
  addStep,
  addChangedFile,
  addCommand,
  recordModel,
  recordPromptVersion,
  addSteering,
  checkpoint,
  fail,
}
