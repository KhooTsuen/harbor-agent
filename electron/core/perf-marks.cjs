/**
 * 分段计时（AG-037 Profiler 的数据来源）
 *
 * 文档要的那几个数：TTFT / LLM Latency / Tool Latency / Search Latency /
 * Context Build Time / Total Task Time。
 *
 * TTFT 与 Total 早就有了（AG-003 的 `metrics.cjs` 记六个时刻）—— 缺的是**中间那段
 * 时间花在哪**：上下文构建多久、模型调用占了几次多久、工具几趟、搜索几趟。
 * 「有点慢」这三个字在定位瓶颈时完全不够用，得能指出卡在哪一段。
 *
 * ── 为什么单独一个模块、而不是往事件总线里塞时长 ──
 * 时长是**过程数据**：它不该进事件流（那是给界面看「发生了什么」的），也不该落盘
 * （历史统计读 `data/events/*.jsonl` 里的 `metrics.timeline`）。这里只做一件事：
 * 按 traceId 攒起来，等 `metrics.finish()` 时一次取走、拼进那份时间线。
 *
 * 攒不到就返回 0 —— 埋点缺一段不能影响任何功能，这一条是硬要求。
 */

/** traceId → { context: [], llm: [], tool: [], search: [] } */
const buckets = new Map()

/** 同一个任务最多攒多少条；防内存无限涨（正常一轮几到几十条） */
const MAX_ENTRIES = 500
/** 最多同时跟多少个任务（同一进程可能并行跑几条对话） */
const MAX_TASKS = 20

/** 哪些工具算「搜索」—— 单独一个桶，别混进 tools 里，否则看不出搜索占了多少 */
const SEARCH_TOOLS = new Set([
  'search_web',
  'browse',
  'browse_elements',
  'browse_click',
  'browse_type',
])

function isSearchTool(name) {
  return SEARCH_TOOLS.has(String(name ?? ''))
}

function bucketOf(traceId, create = false) {
  const key = String(traceId ?? '')
  if (!key) return null
  let bucket = buckets.get(key)
  if (!bucket && create) {
    bucket = { context: [], llm: [], tool: [], search: [] }
    buckets.set(key, bucket)
    while (buckets.size > MAX_TASKS) {
      buckets.delete(buckets.keys().next().value)
    }
  }
  return bucket ?? null
}

/**
 * 记一笔耗时。
 *
 * @param {string} traceId 这一轮的事件流 key（和 metrics.begin 用的是同一个）
 * @param {'context'|'llm'|'tool'|'search'} kind
 * @param {number} ms
 */
function mark(traceId, kind, ms) {
  const bucket = bucketOf(traceId, true)
  if (!bucket || !Array.isArray(bucket[kind])) return
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return
  bucket[kind].push(Math.round(value))
  if (bucket[kind].length > MAX_ENTRIES) bucket[kind].shift()
}

/** 记一次工具调用：搜不搜索由工具名决定，调用方不用操心 */
function markTool(traceId, name, ms) {
  mark(traceId, isSearchTool(name) ? 'search' : 'tool', ms)
}

const sum = (list) => list.reduce((total, value) => total + value, 0)
const max = (list) => (list.length === 0 ? 0 : Math.max(...list))

/**
 * 取走并汇总（取完就清 —— 时间线只算一次）。
 *
 * @returns {{ contextMs: number, llmMs: number, llmCalls: number, llmMaxMs: number,
 *             toolMs: number, toolCalls: number, searchMs: number, searchCalls: number }}
 */
function take(traceId) {
  const key = String(traceId ?? '')
  const bucket = buckets.get(key)
  buckets.delete(key)
  const empty = {
    contextMs: 0,
    llmMs: 0,
    llmCalls: 0,
    llmMaxMs: 0,
    toolMs: 0,
    toolCalls: 0,
    searchMs: 0,
    searchCalls: 0,
  }
  if (!bucket) return empty
  return {
    contextMs: sum(bucket.context),
    llmMs: sum(bucket.llm),
    llmCalls: bucket.llm.length,
    llmMaxMs: max(bucket.llm),
    toolMs: sum(bucket.tool),
    toolCalls: bucket.tool.length,
    searchMs: sum(bucket.search),
    searchCalls: bucket.search.length,
  }
}

function clear() {
  buckets.clear()
}

module.exports = { mark, markTool, take, clear, isSearchTool, SEARCH_TOOLS }
