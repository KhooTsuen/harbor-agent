/**
 * 任务：计划块
 *
 * 从 task.cjs 拆出来的（那边过 300 行了）。
 *
 * 模型回复里出现一个 ```plan 围栏块，里面是编号或短横线列表，
 * 就把它解析成计划条目存进任务 —— 它是**给人看的**。
 *
 * 为什么不用 function calling 让模型「填计划」：计划本身要给人看，
 * 而工具调用是给机器看的，混在一起两边都不好用。
 */

const crypto = require('node:crypto')

/**
 * 解析模型给的计划。
 *
 * 约定：回复里出现一个 ```plan 围栏块，里面是编号或短横线列表。
 * 不用 function calling 让模型「填计划」，是因为计划本身要给人看，
 * 而工具调用是给机器看的 —— 混在一起两边都不好用。
 *
 * @returns {string[]} 计划条目（没有就返回空数组）
 */
function parsePlan(text) {
  const match = /```(?:plan|计划)\s*\n([\s\S]*?)```/i.exec(String(text ?? ''))
  if (!match) return []

  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0 && line.length < 200)
    .slice(0, 20)
}

/**
 * 计划整体指纹。
 *
 * 放在这里而不是 task.cjs，是为了避开循环依赖（task.cjs 要算指纹、
 * task-context.cjs 要读任务）—— 这里只依赖 node:crypto，两边都能安全引用。
 */
function fingerprint(plan) {
  const text = (Array.isArray(plan) ? plan : []).join('\n')
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * 记一版计划，留下历史（AG-004）。
 *
 * 计划不是一次成型的：用户改要求、或者模型自己发现路走不通，都要重新规划。
 * 老做法是直接覆盖 `task.plan`，旧计划就没了 —— 事后看不出「为什么变成现在这样」。
 *
 * 这里只改内存对象，**不落盘**（落盘是 task.cjs 的事）。返回值告诉调用方
 * 「这次到底变没变」—— 模型每一轮都会把计划原样复述一遍，不变就不能记新版本，
 * 否则一次对话能刷出几十版一模一样的计划。
 *
 * @param {object} task 任务记录（原地改）
 * @param {string[]} plan 新计划
 * @param {{ reason?: string, at?: number }} [options]
 * @returns {{ changed: boolean, version: number, reason: string }|null} 计划为空时 null
 */
function recordVersion(task, plan, { reason = '', at = Date.now() } = {}) {
  if (!task || !Array.isArray(plan) || plan.length === 0) return null

  const versions = Array.isArray(task.planVersions) ? task.planVersions : []
  const current = versions.length > 0 ? versions[versions.length - 1].plan : task.plan
  if (Array.isArray(current) && current.length > 0 && fingerprint(current) === fingerprint(plan)) {
    return { changed: false, version: versions.length, reason: '' }
  }

  const label = reason || (versions.length === 0 ? '初始计划' : '重新规划')
  versions.push({ plan: plan.slice(), at, reason: label })
  task.planVersions = versions
  task.plan = plan.slice()
  task.planHash = fingerprint(plan)
  return { changed: true, version: versions.length, reason: label }
}

/**
 * 老任务迁移：只有 `plan`、没有 `planVersions` 的，读的时候补一条 v1。
 * 只补在内存里（真正落盘等下一次写）—— 老数据一个字节都不动。
 */
function migrate(task) {
  if (!task || Array.isArray(task.planVersions)) return task
  const plan = Array.isArray(task.plan) ? task.plan : []
  task.planVersions = []
  /* 先把 task.plan 清掉 —— 否则 recordVersion 会拿它当「当前版」，
     一看和要补的那份一样就判定「没变」，版本就补不出来。
     （这是测试抓出来的：第一版补不上，planVersions 还是空的。） */
  task.plan = []
  if (plan.length > 0)
    recordVersion(task, plan, { at: task.updatedAt || task.createdAt || Date.now() })
  return task
}

module.exports = { parsePlan, fingerprint, recordVersion, migrate }
