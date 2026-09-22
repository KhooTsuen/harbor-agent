/*
 * AG-011：恢复一个暂停的任务
 *
 * 从 `task.cjs` 单独开一个文件，是因为那边 299 行已经贴到上限了 ——
 * 而且「恢复」本来就是一个独立的关注点：它要回答三个问题
 *
 *   ① 这条任务现在能不能恢复（`canResume`）
 *   ② 恢复时**复用哪条任务**（`reopen` —— 复用它自己，不新建）
 *   ③ 环境还和当初一样吗（`checkEnvironment`）
 *
 * ── 为什么必须复用同一条任务 ──
 *
 * 文档要求「不重复已完成步骤」。这条不是靠什么记忆机制做到的，
 * 而是因为**任务的 steps / plan 都还在那条记录里** ——
 * `task-context.cjs` 会把「计划里第一条没打 [x] 的」注入提示，
 * 模型看到「这些已经做完了」自然不会重做。
 * 新建一条任务等于把这些全丢掉，那才是真的会从头再来。
 */

const fs = require('node:fs')
const taskCore = require('./task.cjs')

/** 这两种状态都算「停下来了，可以接着做」 */
const RESUMABLE = new Set(['paused', 'waiting_user'])

/**
 * mtime 的比较容差。
 *
 * Windows 上刚写完的文件，它的 last-write-time 可能还在「路上」（系统时钟
 * 粒度问题，实测能晚一秒上下）。不留余量的话，自己刚改完的文件会被判成
 * 「又被别人改了」—— 真机上自测时就撞到过这个。
 * 代价：暂停后两秒内被人改的文件检测不到 —— 暂停到恢复一般隔得比这久。
 */
const MTIME_SLACK_MS = 2000

/** 能不能恢复（前端拿它决定「继续」按钮亮不亮） */
function canResume(taskId) {
  const task = taskCore.get(String(taskId ?? ''))
  return Boolean(task && RESUMABLE.has(task.status))
}

/**
 * 把任务改回 running 并返回它自己（**不新建**）。
 * 状态不对（已完成 / 不存在）时返回 null，交给调用方新建一条。
 *
 * AG-012：顺手记 `resumeCount` —— 恢复过几次，重启清单里给用户看。
 */
function reopen(taskId) {
  const task = taskCore.get(String(taskId ?? ''))
  if (!task || !RESUMABLE.has(task.status)) return null
  return taskCore.update(task.id, {
    status: 'running',
    resumeCount: (task.resumeCount ?? 0) + 1,
    /* AG-040：接着做就别再挂着「已达上限」那三按钮了 */
    pauseReason: '',
    pauseDetail: '',
    budgetHit: null,
    loopHit: null,
  })
}

/**
 * 恢复前检查环境：任务停住之后，它改过的文件有没有被别再动过。
 *
 * 判据是 mtime **晚于任务的 `updatedAt`** —— 任务一旦暂停就不再更新，
 * 所以「比它还新」就等于「Agent 撒手之后有人动过」。
 * 直接接着做可能基于过时的假设（比如那段代码已经被改掉了）。
 *
 * 文件不存在 / 读不到也算「变了」—— 那更得让模型先看一眼。
 */
function checkEnvironment(taskId) {
  const task = taskCore.get(String(taskId ?? ''))
  if (!task) return { ok: false, changed: [] }
  const changed = []
  for (const item of task.changedFiles ?? []) {
    const file = String(item?.path ?? '')
    if (!file) continue
    try {
      if (fs.statSync(file).mtimeMs > (task.updatedAt ?? 0) + MTIME_SLACK_MS) changed.push(file)
    } catch {
      changed.push(file)
    }
  }
  return { ok: true, changed }
}

/**
 * 这条对话里有没有「还等着你」的任务（AG-043）。
 *
 * 为什么要它：用户在执行中改方向时，渲染层**不会**带 resumeTaskId
 * （那是点「继续」才带的）。于是原来会**新建一条任务** —— 计划、进度、检查点
 * 全丢，而文档要的恰恰是「不重新执行无关步骤 / 保留原计划历史 / 从有效检查点继续」。
 *
 * ★ 但「这条对话还有没干完的活就接回去」这个判断**太宽了** —— 用户报过一个很坑的现象：
 *   「发了一个新问题，结果它没回答我，而是把之前那条没干完的任务接回去重跑了一遍，
 *     旧任务的记录还被覆盖了」。因为以前是**无条件**复用最早一条未完成任务，
 *   于是你在这条对话里发任何话都会被当成「接着那条任务做」。
 * 所以现在分情况 —— 而且**只列 `reopen` 真的肯接的状态**：它要求 status 在 RESUMABLE 里，
 * running 的任务本来就接不回来，把 running 写进来只会让「会不会接回」和实际决定不一致
 * （loop-run 里的 `attached` 就是照这个函数判断的，它必须和 openForRun 的结果一致）：
 *
 *   · waiting_user —— 那一轮正停着等你回话，你这句话就是**回答** → 接回去
 *   · paused       —— 停下过的，**只有你明确说「继续」才接回去**
 *                     （`isContinueIntent` 会认出「继续 / 接着做」这类；
 *                      发一个无关的新问题就该新建一条任务，而不是去覆盖旧的）
 */
function activeForSession(sessionId, { continueIntent = false } = {}) {
  if (!sessionId) return null
  return (
    taskCore.list({ limit: 50, sessionId }).find(
      (task) => task.status === 'waiting_user' || (continueIntent && task.status === 'paused'),
    ) ?? null
  )
}

/**
 * 起一次运行：能恢复就**复用原任务**，否则新建一条。
 * 把这段放在这里（而不是 loop.cjs）是因为它长了点 —— 那边已经贴 300 行上限。
 */
function openForRun({
  resumeTaskId = '',
  goal = '',
  sessionId = '',
  continueIntent = false,
  ...options
}) {
  const resumed = resumeTaskId ? reopen(resumeTaskId) : null
  if (resumed) return resumed

  /*
   * AG-043：没带 resumeTaskId，但这条对话的活还没完 → 可能会接回它（不是新建）。
   * ★ 要不要接回由 activeForSession 分情况判断 —— 见那里的注释：
   *   随口发个新问题不能把旧任务拉起来重跑（真机上就是这么把旧任务覆盖掉的）。
   */
  const live = activeForSession(sessionId, { continueIntent })
  if (live) {
    const reopened = reopen(live.id)
    if (reopened) return reopened
  }
  /* AG-027：不传 title —— 让 create 从 goal 提炼（聊天句 ≠ 任务名） */
  return taskCore.create({
    goal,
    sessionId,
    projectId: options.projectId,
    workdir: options.workdir,
    mode: options.mode,
  })
}

module.exports = { canResume, reopen, checkEnvironment, openForRun, activeForSession, RESUMABLE }
