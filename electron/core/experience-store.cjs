/**
 * 经验存储的**对外门面**（落盘 `data/experiences.json`）
 *
 * 三个文件各管一段，别在别处再写第四份：
 *   · `experience-store-file.cjs`  —— 读 / 原子写 / 容量 / 注入账 / 落盘前扫密钥
 *   · `experience-store-write.cjs` —— 三个写口（建候选 / 记验证 / 记反例）
 *   · 本文件                        —— 可见性过滤 + 把上面两段合成一个形状
 *
 * 形状 / 状态机 / 阈值全部来自 `experience-schema.cjs`（唯一真相源）；
 * 三道闸（作用域 / 修法 / 文本）在 `experience-guard.cjs`。
 *
 * 为什么可见性走 `memory-scope.filterVisible`：经验的范围语义和记忆一样
 * （global / project / session），自己再写一套 `scope === 'project' && ...`
 * 就是两个会漂的真相源。**但写入侧另有一条**（`guard.scopeAllows`）：
 * 那边判「能不能写」，语义对齐、用途不同，两边都只有一处实现。
 */
const { filterVisible } = require('./memory-scope.cjs')
const schema = require('./experience-schema.cjs')
const file = require('./experience-store-file.cjs')
const write = require('./experience-store-write.cjs')
const approve = require('./experience-approve.cjs')

/**
 * 列出经验。`projectId` / `sessionId` 的键在不在，语义与记忆完全一样
 * （见 `memory-scope.cjs` 文件头）：不传 = 管理视图，传空串 = 这个上下文没有该项目。
 */
function list(options = {}) {
  const data = file.load()
  let items = data.items
  if (options.status) items = items.filter((item) => item.status === options.status)
  if (options.includeClosed !== true) {
    items = items.filter((item) => item.status !== schema.STATUS.REJECTED)
  }
  items = filterVisible(items, {
    ...(options.projectId !== undefined ? { projectId: String(options.projectId) } : {}),
    ...(options.sessionId !== undefined ? { sessionId: String(options.sessionId) } : {}),
  })
  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 设置页用的列表：**管理视图**（不带 projectId = 看全库，语义同 memory-scope）。
 *
 * 每条多带一个 `injectable` —— 它是 `schema.injectable` 的结论（唯一判据），
 * 界面据此显示「生效中 / 已停用」。**别在渲染层自己拼这个判断**：
 * 「人批的不看验证器版本」这条口径写在 schema 里，前端再算一遍必然漂。
 *
 * `pending` = 还能被人动一条的（candidate / suspended），界面据此决定显不显示按钮。
 */
function listForReview(options = {}) {
  const items = list({ ...options, projectId: undefined, includeClosed: options.includeClosed === true })
  return items.map(describeForReview)
}

/**
 * 单条经验在设置页里长什么样（列表和「刚批完那一条」用同一个形状）。
 * 判据仍然只有 `schema.injectable` 与 `approve.blockReason` 两处。
 */
function describeForReview(item) {
  if (!item) return null
  return {
    ...item,
    injectable: schema.injectable(item),
    pending: item.status === schema.STATUS.CANDIDATE || item.status === schema.STATUS.SUSPENDED,
    blockedReason: approve.blockReason(item, approve.ACTION.APPROVE),
  }
}

module.exports = {
  filePath: file.filePath,
  exists: file.exists,
  load: file.load,
  get: file.get,
  stats: file.stats,
  clear: file.clear,
  touchInjected: file.touchInjected,
  candidateKey: write.candidateKey,
  addCandidate: write.addCandidate,
  recordVerification: write.recordVerification,
  recordContradiction: write.recordContradiction,
  /* 审批（人动手的那一步）在 experience-approve.cjs —— 对外仍走这一个门面 */
  review: approve.review,
  list,
  listForReview,
  describeForReview,
}
