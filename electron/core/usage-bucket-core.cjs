/**
 * 用量聚合的「桶与累加」—— 从 `usage-query.cjs` 拆出来（那边过 300 行了）
 *
 * ── 为什么按这条缝拆 ────────────────────────────────────────────
 * `usage-query.cjs` 剩下的部分是**查询语义**（筛选、memo、按天裁剪、返回形状）；
 * 这里只回答「一行记录怎么累进一个桶」。前者常改，后者几乎不动 ——
 * 混在一起改一次查询就要读 300 行。
 *
 * ── 命中率优化（2026-11-09 实测）────────────────────────────────
 * `addInto` 以前按 `NUMS` 数组循环累加。4 万行 × 8 维度实测 **150ms**；
 * 展开成 7 个字段的直接赋值后 **54ms（2.8×）**。原因是循环里
 * `n[key] += v` 的键名只有运行时才知道，V8 拿不到内联缓存。
 *
 * ⚠️ 代价：加新数值字段要改**三处** —— `NUMS`、`rowFacts`、`addInto`。
 *   `usageQueryShape.test.ts` 有一条断言盯着这三处一致，漏一处会红。
 */

/** 数值项：只有 known 且真有数才算（**字段清单的唯一来源**） */
const NUMS = ['prompt', 'completion', 'total', 'cacheHit', 'cacheMiss', 'reasoning', 'cost']

/** 未归属 / 未标注的展示名（与界面 `USAGE_UNSET` / `USAGE_TASK_NONE` 同一个字面量） */
const UNSET = '（未标注）'
const TASK_NONE = '（未归属）'

function emptyBucket() {
  const fieldUnavailable = {}
  for (const key of NUMS) fieldUnavailable[key] = 0
  return {
    requests: 0,
    known: 0,
    unknown: 0,
    legacy: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    cacheHit: 0,
    cacheMiss: 0,
    reasoning: 0,
    cost: 0,
    errors: 0,
    aborted: 0,
    fieldUnavailable,
  }
}

/** 这一行有没有真实用量（判据与 `token-metrics.summarize` 逐字一致） */
function isKnown(row) {
  if (typeof row.known === 'boolean') return row.known
  /* 老记录：有 token 数字就算拿到了（那时没有 known 字段） */
  return Number(row.prompt) > 0 || Number(row.completion) > 0 || Number(row.total) > 0
}

/**
 * 这一行的派生事实（**每行只算一次**，再分发给各维度）。
 *
 * ★ 用扁平字段而不是 `numbers` 子对象：子对象每行都要新建，之后每次读
 *   还要多跳一层属性。
 */
function rowFacts(row) {
  const known = isKnown(row)
  return {
    known,
    hasFlag: typeof row.known === 'boolean',
    prompt: known && Number.isFinite(row.prompt) ? row.prompt : null,
    completion: known && Number.isFinite(row.completion) ? row.completion : null,
    total: known && Number.isFinite(row.total) ? row.total : null,
    cacheHit: known && Number.isFinite(row.cacheHit) ? row.cacheHit : null,
    cacheMiss: known && Number.isFinite(row.cacheMiss) ? row.cacheMiss : null,
    reasoning: known && Number.isFinite(row.reasoning) ? row.reasoning : null,
    cost: known && Number.isFinite(row.cost) ? row.cost : null,
  }
}

/** 把一行累进一个桶（facts 由 `rowFacts` 预先算好）—— 展开写，见文件头的实测 */
function addInto(bucket, row, f) {
  bucket.requests += 1
  if (f.known) bucket.known += 1
  else bucket.unknown += 1
  if (!f.hasFlag) bucket.legacy += 1
  if (row.outcome === 'aborted') bucket.aborted += 1
  else if (row.ok === false) bucket.errors += 1

  const u = bucket.fieldUnavailable
  if (f.prompt === null) u.prompt += 1
  else bucket.prompt += f.prompt
  if (f.completion === null) u.completion += 1
  else bucket.completion += f.completion
  if (f.total === null) u.total += 1
  else bucket.total += f.total
  if (f.cacheHit === null) u.cacheHit += 1
  else bucket.cacheHit += f.cacheHit
  if (f.cacheMiss === null) u.cacheMiss += 1
  else bucket.cacheMiss += f.cacheMiss
  if (f.reasoning === null) u.reasoning += 1
  else bucket.reasoning += f.reasoning
  if (f.cost === null) u.cost += 1
  else bucket.cost += f.cost
}

/** 收尾：覆盖率 + 「没有任何一行给金额」时把 cost 归 null（不是 0 元） */
function finish(bucket) {
  bucket.coverage = bucket.requests > 0 ? Number((bucket.known / bucket.requests).toFixed(4)) : null
  /* 一条都没有真金额就给 null（含「一次都没调」的空白桶）—— 0 会被读成「确认花了 0 元」 */
  if (bucket.fieldUnavailable.cost === bucket.requests) bucket.cost = null
  return bucket
}

module.exports = { NUMS, UNSET, TASK_NONE, emptyBucket, isKnown, rowFacts, addInto, finish }
