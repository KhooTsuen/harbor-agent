/**
 * 重新生成的台账接线
 *
 * 三件事，都发生在「新一轮开跑之前」：
 *
 *   ① 找「被重新生成的那条任务」：同一会话里**最近的一条**（台账索引一跳）。
 *      只在重做最后一轮时调用 —— 只有那时「最近一条」才一定属于它
 *      （更早轮次的对不上，宁可不关联也不连错）。
 *   ② 给旧任务盖 `supersededBy`（被后来的重新生成替代了）。
 *   ③ 给旧任务的文件改动事务盖「被替代」标记 —— 这是「副作用隔离」那一半。
 *      ★ 事务本体**不自动回滚、不删除**：文件保持新旧两轮都能看的状态，
 *        要撤就在审查面板手动整批撤（这是既有机制，复用不自造）。
 *
 * 只负责「记账」，不碰运行 —— 跑新任务在 loop-run / loop.cjs。
 */

const taskCore = require('./task.cjs')
const changeset = require('./changeset.cjs')
const log = require('./log.cjs')

/** 同一会话里最近的一条任务（= 刚被点「重新生成」的那一轮的台账） */
function previousForSession(sessionId) {
  if (!sessionId) return null
  return taskCore.list({ limit: 3, sessionId })[0] ?? null
}

/**
 * 把旧任务与新任务连起来。
 * 旧任务可能没有改动事务（那轮没改文件）→ 只标台账。
 *
 * @returns {{ ok: boolean, changeSetId: string }}
 */
function link(prevTask, newTaskId) {
  if (!prevTask?.id || !newTaskId) return { ok: false, changeSetId: '' }
  try {
    taskCore.update(prevTask.id, { supersededBy: String(newTaskId) })
  } catch (error) {
    log.warn(`标旧任务「被替代」失败：${error instanceof Error ? error.message : error}`)
  }
  const id = changeset.list({ taskId: prevTask.id, limit: 1 })[0]?.id ?? ''
  if (id) changeset.markSuperseded(id, newTaskId)
  return { ok: true, changeSetId: id }
}

module.exports = { previousForSession, link }
