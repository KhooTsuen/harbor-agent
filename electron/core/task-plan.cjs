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

module.exports = { parsePlan, fingerprint }
