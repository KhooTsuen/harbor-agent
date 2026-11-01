/**
 * 「这条扩展内容该落进哪条会话」—— **唯一一处判定**
 *
 * ── 为什么单列一个文件（2026-10-20）──────────────────────────
 *
 * 用户报的 bug：侧边栏选着 **A**，主窗口开着 **B**，点「读当前页」→ 内容落进了 **B**。
 * 根因是 `ext-ops.cjs` 的 `ingest()` 只认 `getActiveSession()`（主窗口那条），
 * 而侧边栏自己有 `selectedSessionId`（`ext-chat.cjs`）—— 两套归属各写各的。
 *
 * 三条上行链路（`ext:page` / `page:observe` / `page:elements`）都走同一个 `ingest`，
 * 所以判定只在这一处；但**调用方各自传什么**也必须一致，因此把决策本身抽成
 * 这个纯函数：不碰 fs、不 require 任何东西 → 自检能直接跑。
 *
 * ── 优先级（顺序本身就是规矩）────────────────────────────────
 *
 *   ① **explicit**　扩展在请求里明确带了 sessionId → 用它（它最清楚自己要什么）
 *      ★ 但它**已失效**时**立刻拒绝**（2026-10-20 用户指出的第三处洞）：
 *        以前会 continue 到下一个候选，于是「侧边栏选着 A（已删）、主窗口开着 B」
 *        时内容会静默落进 B —— 那正是串线，只是换了个触发条件。
 *        明确指定 = 调用方在说「就放这里」；放不了就**报错让它重选**，不许替它挑。
 *   ② **selected**　侧边栏选中的那条 → 用它　← **这一条就是修串线**
 *   ③ **active**　　主窗口当前打开的那条 → 用它（Phase 2 的老行为：没开过侧边栏时
 *      不制造多余会话。此时用户心里的「当前对话」就是主窗口那条）
 *   ④ 都不活 → `sessionId:''` + `create:true`，由调用方新建一条专用会话
 *
 * ★ 为什么 ②在③前面，而 ②为空时要退回③（而不是直接新建）：
 *   从没用过侧边栏的用户，侧边栏里什么都没有。这时读页面落进主窗口那条**恰好**
 *   是他看得到的地方；直接新建会让他觉得「怎么莫名多了一条会话」。
 *   而只要侧边栏**选过**，它的选择就是唯一归属 —— 串线正是从「不认这个选择」来的。
 *
 * ★ 回退链**只对「用户没指定」成立**：①②③ 的区别是「谁在指定」，
 *   一旦某一层**明确指定了但那条会话没了**，正确答案是「问用户」，不是「往下找」。
 */

/**
 * 「明确指定了会话，但那条已经不在了」—— 文案给用户看，所以要能照着操作。
 * 单独一个常量：调用方（`ext-ops.cjs`）与自检引用同一份，避免两处各写一句。
 */
const EXPLICIT_MISSING = '这条扩展请求指定了会话，但那条会话已经不在了（可能被删了）——请在侧边栏重新选一条对话再试'

/**
 * @typedef {object} DecideInput
 * @property {string} [explicit] 请求里明确带的 sessionId
 * @property {string} [selected] 侧边栏选中的（`ext-chat.cjs` 的 `selectedSessionId`）
 * @property {string} [active] 主窗口当前打开的（`ext-bridge` 的 `activeSessionId`）
 * @property {(id: string) => boolean} alive 这条会话还在不在（注入：判定要读盘）
 */

/**
 * @param {DecideInput} input
 * @returns {{ sessionId: string, source: string, error?: string }}
 *   `error` 非空 = **明确指定了但那条会话不在了**，调用方必须报错、不许回退。
 */
function decideSessionId(input) {
  const alive = typeof input?.alive === 'function' ? input.alive : () => false
  const explicit = String(input?.explicit ?? '')

  /* ★ 明确指定但已失效 → 拒绝（不回退）。理由见文件头 ① 那段。 */
  if (explicit && !alive(explicit)) {
    return { sessionId: '', source: 'explicit-missing', error: EXPLICIT_MISSING }
  }

  /** @type {Array<[string, string]>} */
  const candidates = [
    ['explicit', explicit],
    ['selected', String(input?.selected ?? '')],
    ['active', String(input?.active ?? '')],
  ]
  for (const [source, id] of candidates) {
    if (!id) continue
    /* ★ 不活就继续看下一个候选 —— 不在这里新建（新建是调用方的事，
       它还要写 meta 标题等上下文；纯函数只管「选谁」）
       ⚠️ 能走到这里的 explicit 一定已经过了上面那道「失效即拒绝」。 */
    if (alive(id)) return { sessionId: id, source }
  }
  return { sessionId: '', source: 'new' }
}

module.exports = { decideSessionId, EXPLICIT_MISSING }
