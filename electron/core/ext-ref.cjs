/**
 * 元素引用（ref）的解析 —— **唯一一处判定**（2026-10-16 从 `ext-command.cjs` 拆出）
 *
 * ── 为什么拆 ─────────────────────────────────────────────────
 *
 * `ext-command.cjs` 在 M04 剩余 + M05 之后要转调动作层 / 标签页层 / 敏感判定，
 * 已经贴到 350 行红线。而 ref 解析是**纯函数、自成一体**（输入 ref + 当前版本 +
 * 元素列表 → 输出「有效 / 失效及原因」），谁都要用、自检直接喂假数据就能跑。
 *
 * `ext-command.cjs` 会 require 它并**原样再导出**，所以 `C.inspectRef` 这类调用点
 * （含自检 160 组）不用改 —— 与 `ext-kinds.cjs` 那个拆法同源。
 *
 * ⚠️ 本模块**不 require electron**（自检要能在纯 Node 里直接跑它）。
 */

/**
 * 解析一个元素引用（**纯函数** —— 三条判定，自检钉的就是它）。
 *
 * ref 形态（M03 定的）：`<pageVersion>.<序号>`，如 `60684574.3`。
 *
 *   ① 版本对不上 → 引用失效（`page-changed`）—— **必须重新观察**，否则会误点
 *   ② 版本对得上、ref 在列表里 → 有效，附它**当前**的状态
 *   ③ 版本对得上、ref 不在列表里 → 元素没了 / 不再可交互（`not-found`）
 *
 * ★ 为什么不用「deref 元素还在不在」当判据：deref 只能证明元素还在内存，
 *   **证明不了页面没变** —— 而防误点靠的正是后者。
 *
 * @param {string} ref
 * @param {string} currentVersion
 * @param {Array<{ref?: string}>} elements
 */
function inspectRef(ref, currentVersion, elements) {
  const want = String(ref ?? '')
  if (!want) return { kind: 'list', stale: false, element: null }
  const dot = want.lastIndexOf('.')
  const version = dot > 0 ? want.slice(0, dot) : want
  const cur = String(currentVersion ?? '')
  const found = (elements ?? []).find((e) => e && e.ref === want) ?? null
  if (version !== cur) {
    return { kind: 'stale', stale: true, reason: 'page-changed', version, currentVersion: cur, element: found }
  }
  if (!found) {
    return { kind: 'stale', stale: true, reason: 'not-found', version, currentVersion: cur, element: null }
  }
  return { kind: 'ok', stale: false, reason: '', version, currentVersion: cur, element: found }
}

module.exports = { inspectRef }
