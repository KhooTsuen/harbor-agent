/**
 * 任务（Task）
 *
 * 长期 Agent 最大的问题不是聊天，而是「**任务做到一半怎么办**」。
 * 会话只是聊天记录，回答不了：要干什么、计划是什么、走到哪一步、改了哪些
 * 文件、上次检查点在哪、现在该不该继续。所以会话之外再记一份任务。
 *
 * 存储：`data/tasks/<id>.json`（一个任务一个文件，坏了只坏一个）
 * 与 changeSet 的分工：任务管「做什么」，事务管「改了啥、怎么撤」。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { parsePlan } = require('./task-plan.cjs')

/** 任务状态 */
const STATUSES = [
  'running', // 正在跑
  'waiting_user', // 等用户确认
  'paused', // 中断/退出时没跑完
  'completed',
  'failed',
  'cancelled',
]

/** 「没干完」的状态 —— 启动时提示续做的就是这些 */
const UNFINISHED = new Set(['running', 'waiting_user', 'paused'])

function root() {
  return path.join(DIRS.data, 'tasks')
}

function fileFor(id) {
  return path.join(root(), `${id}.json`)
}

function newId() {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function write(task) {
  fs.mkdirSync(root(), { recursive: true })
  fs.writeFileSync(fileFor(task.id), JSON.stringify(task, null, 2), 'utf8')
}

function get(id) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 建一条任务。
 *
 * @param {{ goal: string, sessionId?: string, projectId?: string, workdir?: string, mode?: string, title?: string }} options
 */
function create({
  goal,
  sessionId = '',
  projectId = '',
  workdir = '',
  mode = 'pair',
  title = '',
} = {}) {
  const task = {
    id: newId(),
    title: String(title || goal || '未命名任务').slice(0, 80),
    goal: String(goal ?? ''),
    status: 'running',
    mode,
    sessionId,
    projectId,
    workdir,
    /** 模型给出的计划（从回复里解析出来的编号列表） */
    plan: [],
    /** 实际发生的事 —— 一次工具调用一条 */
    steps: [],
    checkpoints: [],
    changedFiles: [],
    commands: [],
    changeSetId: '',
    errors: [],
    result: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: 0,
  }
  write(task)
  return task
}

/** 打补丁（只允许白名单字段，防止手滑写坏结构） */
function update(id, patch) {
  const task = get(id)
  if (!task) return null

  for (const key of [
    'title',
    'goal',
    'status',
    'result',
    'projectId',
    'workdir',
    'plan',
    'changeSetId',
  ]) {
    if (patch[key] !== undefined) task[key] = patch[key]
  }
  if (patch.status && !STATUSES.includes(patch.status)) return task
  task.updatedAt = Date.now()
  write(task)
  return task
}

/** 记一次工具调用 */
function addStep(id, { tool, ok, summary, ms = 0, args }) {
  const task = get(id)
  if (!task) return null

  task.steps.push({
    at: Date.now(),
    tool: String(tool ?? ''),
    ok: ok !== false,
    ms,
    summary: String(summary ?? '').slice(0, 300),
    args: args ? sanitize(args) : undefined,
  })

  /* 只留最近 200 步 —— 这个文件是给自己看的，不是流水账 */
  if (task.steps.length > 200) task.steps = task.steps.slice(-200)
  task.updatedAt = Date.now()
  write(task)
  return task
}

/** 参数里可能带密钥，简单挡一下（详细脱敏在 audit 那边做） */
function sanitize(args) {
  const out = {}
  for (const [key, value] of Object.entries(args).slice(0, 12)) {
    if (/(key|token|secret|password)/i.test(key)) {
      out[key] = '***'
      continue
    }
    out[key] = typeof value === 'string' ? value.slice(0, 200) : value
  }
  return out
}

/** 记一次文件改动 */
function addChangedFile(id, file, extra = {}) {
  const task = get(id)
  if (!task) return null
  const absolute = String(file)
  if (!task.changedFiles.some((f) => f.path === absolute)) {
    task.changedFiles.push({ path: absolute, at: Date.now(), ...extra })
  }
  task.updatedAt = Date.now()
  write(task)
  return task
}

/** 记一次命令 */
function addCommand(id, command, result = '') {
  const task = get(id)
  if (!task) return null
  task.commands.push({
    command: String(command).slice(0, 500),
    result: String(result).slice(0, 300),
    at: Date.now(),
  })
  if (task.commands.length > 100) task.commands = task.commands.slice(-100)
  task.updatedAt = Date.now()
  write(task)
  return task
}

/** 打检查点 —— **崩溃后靠它恢复** */
function checkpoint(id, { label, note = '', files = [], commands = [] } = {}) {
  const task = get(id)
  if (!task) return null
  task.checkpoints.push({
    at: Date.now(),
    label: String(label ?? '检查点').slice(0, 120),
    note: String(note).slice(0, 500),
    files,
    commands,
  })
  if (task.checkpoints.length > 50) task.checkpoints = task.checkpoints.slice(-50)
  task.updatedAt = Date.now()
  write(task)
  return task
}

function finish(id, { status = 'completed', result = '' } = {}) {
  const task = get(id)
  if (!task) return null
  task.status = STATUSES.includes(status) ? status : 'completed'
  task.result = String(result).slice(0, 4000)
  task.finishedAt = Date.now()
  task.updatedAt = Date.now()
  write(task)
  return task
}

function fail(id, error) {
  const task = get(id)
  if (!task) return null
  task.errors.push({ at: Date.now(), message: String(error).slice(0, 500) })
  task.status = 'failed'
  task.updatedAt = Date.now()
  write(task)
  return task
}

/** 程序退出时把「还在跑」的任务标成暂停 —— 下次启动才认得出要续做 */
function pauseRunning() {
  let count = 0
  for (const task of list({ limit: 500 })) {
    if (task.status === 'running' || task.status === 'waiting_user') {
      update(task.id, { status: 'paused' })
      count += 1
    }
  }
  if (count > 0) log.info(`退出时把 ${count} 条未完成任务标为暂停`)
  return { ok: true, paused: count }
}

function list({ limit = 50, status = '', sessionId = '' } = {}) {
  let names = []
  try {
    names = fs.readdirSync(root()).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }

  const out = []
  for (const name of names) {
    const task = get(name.replace(/\.json$/, ''))
    if (!task) continue
    if (status && task.status !== status) continue
    if (sessionId && task.sessionId !== sessionId) continue
    out.push(task)
  }

  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

/** 有没有没干完的（启动时提示续做） */
function unfinished() {
  return list({ limit: 20 }).filter((task) => UNFINISHED.has(task.status))
}

function remove(id) {
  try {
    fs.rmSync(fileFor(id), { force: true })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

function setPlan(id, plan) {
  if (!Array.isArray(plan) || plan.length === 0) return null
  const task = get(id)
  if (!task) return null
  task.plan = plan
  task.updatedAt = Date.now()
  write(task)
  return task
}

module.exports = {
  STATUSES,
  create,
  get,
  update,
  parsePlan,
  setPlan,
  addStep,
  addChangedFile,
  addCommand,
  checkpoint,
  finish,
  fail,
  pauseRunning,
  list,
  unfinished,
  remove,
}
