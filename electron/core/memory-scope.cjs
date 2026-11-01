/**
 * 记忆可见性：唯一一处判定（P0-4，2026-10-23）
 *
 * ── 问题 ─────────────────────────────────────────────────────
 *
 * 「这条记忆在**这个上下文**里能不能看见」以前有两个实现，口径不同：
 *
 *   · 自动注入（`memory-recall.cjs` 的 `retrieve`）
 *       project 域：有项目就筛，没项目就全排除；
 *       session 域：**完全没有 sessionId 就一条都不注入**（SEC-065，fail-closed）。
 *   · 模型侧检索（`memory-store.cjs` 的 `search → list`）
 *       只认 `projectId`，**根本不知道 session 域存在**。
 *
 * 于是从 B 会话调 `memory_search` 能搜到 A 会话的私事 —— 注入路径拦着、
 * 检索路径漏着，两边说的不是同一件事。同理 `memory-store.list` 的 project 分支
 * 也是手写的第二份判断。
 *
 * ── 这里的规则 ───────────────────────────────────────────────
 *
 * `visible(item, ctx)` 的 ctx 里，**键在不在**本身就是语义：
 *
 *   · `projectId === undefined` → 不过滤 project 域（管理视图：用户要看全部）
 *   · `projectId === ''`        → 排除 project 域（这个上下文没有项目）
 *   · `projectId === 'x'`       → 只留 `item.projectId === 'x'` 的
 *   · session 域同理。
 *
 * 为什么用「键在不在」而不是「空串 = 不过滤」：注入路径必须 **fail-closed**
 * （没有会话上下文时一条 session 记忆都不许漏进来），而设置页必须看得见全部。
 * 同一个空串表达不了两件事，那就让「有没有传这个维度」来表达。
 *
 * 调用方：`core/memory-recall.cjs`（注入）、`core/memory-store.cjs`（list / search）。
 * 新增调用方**必须**走这里，不要再手写一遍 `scope === 'project' && ...`。
 */

/**
 * 一条记忆在这个上下文里可见吗。
 *
 * @param {{ scope?: string, projectId?: string, sessionId?: string }} item
 * @param {{ projectId?: string, sessionId?: string }} [ctx]
 * @returns {boolean}
 */
function visible(item, ctx = {}) {
  const scope = typeof item?.scope === 'string' && item.scope ? item.scope : 'global'
  if (scope === 'project') {
    if (ctx.projectId === undefined) return true
    return ctx.projectId !== '' && item.projectId === ctx.projectId
  }
  if (scope === 'session') {
    if (ctx.sessionId === undefined) return true
    return ctx.sessionId !== '' && item.sessionId === ctx.sessionId
  }
  return true
}

/**
 * 过滤一批记忆。形状与 `Array.prototype.filter` 一致，调用方可直接接。
 *
 * @template T
 * @param {T[]} items
 * @param {{ projectId?: string, sessionId?: string }} [ctx]
 * @returns {T[]}
 */
function filterVisible(items, ctx = {}) {
  const list = Array.isArray(items) ? items : []
  return list.filter((item) => visible(item, ctx))
}

module.exports = { visible, filterVisible }
