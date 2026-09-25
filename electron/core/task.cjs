/**
 * 任务（Task）
 *
 * 长期 Agent 最大的问题不是聊天，而是「**任务做到一半怎么办**」。会话只是聊天记录，
 * 回答不了：要干什么、走到哪一步、改了哪些文件、该不该继续 —— 所以另记一份任务，
 * 存 `data/tasks/<id>.json`（一个任务一个文件，坏了只坏一个）。与 changeSet 的分工：
 * 任务管「做什么」（AG-027：它是**独立于聊天**的一等对象，有自己的名字），
 * 事务管「改了啥、怎么撤」。
 */

const log = require('./log.cjs')
const io = require('./task-io.cjs')
const taskIndex = require('./task-index.cjs')
const notes = require('./task-notes.cjs')
const taskIntent = require('./task-intent.cjs') // 执行可判定：意图 / 结果两段落盘
const {
  parsePlan,
  parsePlanBlock,
  deriveTitle,
  fallbackTitle,
  fingerprint,
  recordVersion,
  migrate,
  nextActionOf,
} = require('./task-plan.cjs')

/** 任务状态；`paused` = 中断/退出时没跑完（启动时提示续做的就是它） */
const STATUSES = ['running', 'waiting_user', 'paused', 'completed', 'failed', 'cancelled']

const UNFINISHED = new Set(['running', 'waiting_user', 'paused'])
/**
 * 建一条任务。
 *
 * 实现搬去了 `task-create.cjs`（那边是「一条刚出生的任务长什么样」的全部内容，
 * 这里 312 行贴了上限）。这个门面留着，是因为外部全在调 `taskCore.create`。
 */
const { create } = require('./task-create.cjs')

/** 打补丁（只允许白名单字段，防止手滑写坏结构）—— ⚠️ 不在名单里的字段会被**静默丢掉**，加新字段记得先写进下面那个数组 */
function update(id, patch) {
  const task = io.get(id)
  if (!task) return null

  for (const key of [
    'title',
    'goal',
    'status',
    'result',
    'projectId',
    'workdir',
    'plan',
    'planVersions',
    'changeSetId',
    'nextAction',
    'permissions',
    'model',
    'models',
    'budget',
    'pauseReason',
    'pauseDetail',
    'budgetHit',
    'loopHit',
    'tokens', 'tokensIn', 'tokensOut',
    'retries',
    /* 重新生成（新功能）：台账关联 + 预算继承 + 被替代标记 + 累计轮数 */
    'regeneratedFrom',
    'budgetCarry',
    'supersededBy',
    'turns',
    'pausedAt',
    'resumeCount',
  ]) {
    if (patch[key] !== undefined) task[key] = patch[key]
  }
  if (patch.status && !STATUSES.includes(patch.status)) return task
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/** 程序退出时把「还在跑」的任务标成暂停 —— 下次启动才认得出要续做
 * 两个调用点，都是「进程里已经没有活着的循环了」：
 *   · exit    —— will-quit
 *   · startup —— 启动时扫上一轮的遗留。**强杀 / 崩溃退出时 will-quit 根本不会跑**，
 *                任务会一直卡在 running；而能「接着做」的状态只有 paused / waiting_user，
 *                于是用户看得见那条任务、却点不了继续（实测复现过）。
 * 应用是单实例：启动时不可能真的有循环在跑，所以全部标暂停是安全的。
 */
function pauseRunning(where = 'exit') {
  let count = 0
  for (const task of list({ limit: 500 })) {
    if (task.status === 'running' || task.status === 'waiting_user') {
      update(task.id, { status: 'paused', pausedAt: Date.now(), pauseReason: 'interrupted' })
      count += 1
    }
  }
  if (count > 0) {
    log.info(
      where === 'startup'
        ? `启动时把 ${count} 条还标着「在跑」的任务标为暂停（上次是强杀或崩溃退出）`
        : `退出时把 ${count} 条未完成任务标为暂停`,
    )
  }
  return { ok: true, paused: count }
}

/**
 * 列任务：按 `updatedAt` 新→旧，可按状态 / 会话过滤。
 *
 * AG-039：走**索引**（`task-index.cjs`）拿顺序与过滤条件，只读真正要返回的那几个文件。
 * 原来是「把 data/tasks 下每个 JSON 全读一遍」—— 1241 个任务实测 240ms，
 * 而列表在工具每跑完一次就会被调用一次：主进程被反复按住，渲染层的 IPC 全排在后面。
 */
function list({ limit = 50, status = '', statuses = null, sessionId = '', workdir = '' } = {}) {
  return taskIndex.list({ limit, status, statuses, sessionId, workdir })
}

/**
 * 有没有没干完的（启动时提示续做）。
 *
 * ★ 顺序不能反：**先筛出没干完的，再截前 20**。
 *   原来是 `list({limit:20}).filter(...)` —— 先按 updatedAt 截 20 条再筛。
 *   同一毫秒建的任务时间戳会撞上（台账里任务上千条时真会撞），排序不稳定，
 *   于是**刚建的那条能被挤出前 20**，`unfinished()` 就装作没看见它
 *   （自检里报成「未完成任务能被列出来」失败）。
 */
function unfinished({ workdir = '' } = {}) {
  /* 状态集合交给索引筛；项目上下文有工作目录时只取该项目任务 */
  return list({ limit: 500, statuses: [...UNFINISHED], workdir }).slice(0, 20)
}

/**
 * 收尾：定状态与结果。
 * 留在这一层（而不是 task-notes.cjs）是因为它是**状态转移**，不是往台账上
 * 记账 —— 「记了什么」去 notes，「现在是什么状态」在这一层。
 */
function finish(id, { status = 'completed', result = '' } = {}) {
  const task = io.get(id)
  if (!task) return null
  task.status = STATUSES.includes(status) ? status : 'completed'
  task.result = String(result).slice(0, 4000)
  task.finishedAt = Date.now()
  task.updatedAt = io.monotonicNow()
  io.write(task)
  return task
}

/** 记一版计划（AG-004）：变了才写盘。planHash 防的是计划被并行会话悄悄改掉。 */
function setPlan(id, plan, options = {}) {
  const task = io.get(id)
  if (!task) return null
  const version = recordVersion(task, plan, options)
  if (!version) return null
  if (version.changed) {
    /* AG-012：顺手记下「下一步」—— 重启后不必把整份计划再喂一遍 */
    task.nextAction = nextActionOf(plan)
    task.updatedAt = io.monotonicNow()
    io.write(task)
  }
  return { task, ...version }
}

/**
 * 还在跑、不许删的两个状态（删了台账它还在跑 → 幽灵任务）。
 *
 * 界面那一层也会把删除按钮藏起来，但**内核必须自己再拦一次** ——
 * 界面是给人看的，内核是给所有调用方兜底的（批量清空、将来的脚本都走这里）。
 */
const LIVE_STATUSES = ['running', 'waiting_user']

/**
 * 删一条任务（安全版）：正在跑的不给删。
 *
 * @returns {{ ok: boolean, removed: number, skipped: number, reason?: string }}
 */
function removeSafe(id) {
  const task = io.get(id)
  if (!task) return { ok: false, removed: 0, skipped: 0, reason: '没有这条任务' }
  if (LIVE_STATUSES.includes(task.status)) {
    return { ok: false, removed: 0, skipped: 1, reason: '任务还在跑，先停止再删' }
  }
  io.remove(id)
  return { ok: true, removed: 1, skipped: 0 }
}

/**
 * 批量删（按状态，可选限定某条对话）—— 任务面板里「清空这一组」用它。
 *
 * ★ 传进来的状态里只要碰了 running / waiting_user，**这里直接忽略掉**，
 *   并在返回值里说明跳过了几条（界面照它提示用户）。
 *
 * @returns {{ ok: boolean, removed: number, skipped: number }}
 */
function removeMany({ statuses = [], sessionId = '' } = {}) {
  const wanted = (Array.isArray(statuses) ? statuses : []).filter(
    (status) => STATUSES.includes(status) && !LIVE_STATUSES.includes(status),
  )
  const all = list({ limit: 1000, sessionId: String(sessionId ?? '') })
  const doomed = all.filter((task) => wanted.includes(task.status))
  for (const task of doomed) io.remove(task.id)
  return {
    ok: true,
    removed: doomed.length,
    skipped: all.filter((task) => LIVE_STATUSES.includes(task.status)).length,
  }
}

/**
 * 把某条对话（会话）的任务全部删掉 —— 删对话时一并清任务历史（用户要的）。
 *
 * 放门面而不是底座：`list` 认识 sessionId（还负责校验/重建索引），
 * 底座 task-io 只管「一个任务一个文件」，不该知道会话是什么。
 *
 * @returns {{ ok: boolean, removed: number }}
 */
function removeBySession(sessionId) {
  const target = String(sessionId ?? '')
  if (!target) return { ok: false, removed: 0 }
  const doomed = list({ limit: 1000, sessionId: target }).map((task) => task.id)
  for (const id of doomed) io.remove(id)
  return { ok: true, removed: doomed.length }
}

module.exports = {
  ...io,
  removeSafe,
  removeMany,
  removeBySession,
  ...notes,
  ...taskIntent,
  STATUSES,
  create,
  update,
  parsePlan,
  parsePlanBlock,
  deriveTitle,
  fallbackTitle,
  fingerprint,
  setPlan,
  finish,
  pauseRunning,
  list,
  unfinished,
}
