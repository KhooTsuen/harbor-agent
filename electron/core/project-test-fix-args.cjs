/**
 * `apply_test_fix` 的**参数层**（2026-10-17 · 3B-2）
 *
 * ── 为什么单列 ────────────────────────────────────────────────
 *
 * `project-test-fix.cjs` 贴着 300 行红线，而这两个函数是纯形状判据：
 * 「起点从哪儿取」「提案长什么样」。搬出来后自检可以直接喂假数据跑，
 * 不必真去改文件。
 *
 * ── ★ 两件事都不放行 ──────────────────────────────────────────
 *
 *   · `pickSnapshot`：**只认已落盘的执行快照**。调用方说不出"这是一次 FAIL"，
 *     只能指 `executionId` / `testId`，status 一律从快照读（3B-1 的 B14 继续有效）。
 *   · `cleanProposals`：一次只收 **1** 个文件；`before` 与 `after` 相同直接拒
 *     （那不是修改）；超长文本拒（防上下文膨胀）。
 *
 * ⚠️ 不 require electron。
 */

const history = require('./project-test-history.cjs')

/** 一次最多改几个文件（3B-2/3B-3 的硬上限：1） */
const MAX_PROPOSALS = 1
/** 单个提案的文本上限 */
const MAX_TEXT = 200_000

/**
 * 取失败起点：只认已落盘的快照。
 *
 * @param {{ executionId?: unknown, testId?: unknown }} args
 * @returns {{ ok: true, snapshot: object } | { ok: false, code: string, message: string }}
 */
function pickSnapshot(args) {
  const id = String(args?.executionId ?? '').trim()
  if (id) {
    const one = history.get(id)
    if (one) return { ok: true, snapshot: one }
    return { ok: false, code: 'UNKNOWN_EXECUTION', message: `没有这条执行记录：${id}` }
  }
  const testId = String(args?.testId ?? '').trim()
  if (testId) {
    const one = history.latest(testId)
    if (one) return { ok: true, snapshot: one }
    return { ok: false, code: 'NO_EXECUTION', message: `条目 ${testId} 还没有任何执行记录` }
  }
  return {
    ok: false,
    code: 'NEED_ID',
    message: '必须给 executionId（推荐）或 testId —— 本工具只修**已经真实跑过**的失败',
  }
}

/**
 * 收提案：只要 path / before / after / note 四个字符串。
 *
 * @param {unknown} input
 * @returns {{ ok: true, proposals: Array<object> } | { ok: false, message: string }}
 */
function cleanProposals(input) {
  if (!Array.isArray(input)) return { ok: false, message: 'proposals 必须是数组' }
  if (input.length === 0) return { ok: false, message: 'proposals 是空的 —— 没有具体改法就不要调这个工具' }
  if (input.length > MAX_PROPOSALS) {
    return { ok: false, message: `一次最多改 ${MAX_PROPOSALS} 个文件（收到了 ${input.length} 个）` }
  }
  const out = []
  for (const one of input) {
    if (!one || typeof one !== 'object') return { ok: false, message: 'proposals 里每一项都必须是对象' }
    const p = {
      path: String(one.path ?? '').trim(),
      before: String(one.before ?? ''),
      after: String(one.after ?? ''),
      note: String(one.note ?? '').trim(),
    }
    if (!p.path) return { ok: false, message: 'proposal.path 必填（项目根下的相对路径）' }
    if (p.before.length > MAX_TEXT || p.after.length > MAX_TEXT) {
      return { ok: false, message: 'proposal 文本过长（上限 200000 字符）' }
    }
    if (p.before === p.after) {
      return { ok: false, message: `proposal 的 before 与 after 相同（${p.path}）—— 这不是修改` }
    }
    out.push(p)
  }
  return { ok: true, proposals: out }
}

module.exports = { MAX_PROPOSALS, MAX_TEXT, pickSnapshot, cleanProposals }
