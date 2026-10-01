/**
 * 「问界面一句话，等它回话」的往返（AG-053）
 *
 * 从 `handlers/chat.cjs` 抽出来的**可测**部分：那边顶层 require 了 `loop.cjs`，
 * 自检在纯 Node 里不方便把它整块拉起来；而「等回话 / 超时 / 回话里带东西」
 * 这套语义是这一轮唯一真正需要钉死的地方（AG-053 要求：老的布尔往返与新的
 * 可选答复**行为隔离**）。
 *
 * ★ 语义（三条，缺一条就会静默改坏老路径）：
 *   ① 老路径（写操作确认）：`approved === true` 才算同意，**别的一律是拒绝**
 *      —— 不是真值判断（破坏性测试传过 `{ ok: false }`，本意是拒绝却被当同意）。
 *   ② 新路径（澄清）：多一个 `answer`（字符串，IPC 友好），`timeout` 要能区分
 *      「用户拒绝」和「用户不在」—— 后者要采纳默认选项而不是当拒绝。
 *   ③ 两条路径共用同一套 pending / 超时，但**回话形状不同**：老路径只取 approved，
 *      新路径拿整个对象。改这里时先看第 3 组自检（101-confirm-bridge）。
 *
 * 依赖注入 `emit`（渲染层那边谁去弹窗不归它管），所以它不 require electron。
 */

/** confirmId → { resolve, timer } */
const pending = new Map()

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 挂一条请求并等回话。
 *
 * @param {{ emitReply: (payload: Record<string, unknown>) => void, timeoutMs?: number,
 *           payload?: Record<string, unknown>, idPrefix?: string, owner?: string }} options
 *          `owner` = 这条确认属于哪一轮对话（chat 的 requestId）。
 *          一轮结束时（成功/失败/中断）要把还没回话的那些**按拒绝结算掉**，
 *          否则界面一直挂着一张卡、promise 一直悬着（AG-053 批③ 把那段
 *          从 chat.cjs 收回来时发现它引用的 `pendingConfirms` 已经搬走了）。
 * @returns {Promise<{ approved: boolean, answer: string, timeout: boolean, id: string }>}
 */
function ask({ emitReply, timeoutMs = 5 * 60 * 1000, payload = {}, idPrefix = 'cfm', owner = '' }) {
  return new Promise((resolve) => {
    const id = newId(idPrefix)
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      /* 超时：**不是**用户拒绝 —— 澄清那边要按默认选项继续（`timeout: true`） */
      resolve({ approved: false, answer: '', timeout: true, id })
    }, timeoutMs)

    pending.set(id, { resolve, timer, owner: String(owner ?? '') })
    emitReply({ confirmId: id, ...payload })
  })
}

/**
 * 渲染层回话。
 *
 * @param {string} id
 * @param {unknown} approved 老路径的布尔；新路径也带（是否「算数」）
 * @param {unknown} [answer] 新路径的可选答复（字符串）。**不传时老路径行为完全不变**。
 */
function settle(id, approved, answer) {
  const entry = pending.get(String(id ?? ''))
  if (!entry) return { ok: false, error: '这个确认已经过期了' }
  pending.delete(String(id))
  clearTimeout(entry.timer)
  entry.resolve({
    approved: approved === true,
    answer: typeof answer === 'string' ? answer : '',
    timeout: false,
    id: String(id),
  })
  return { ok: true }
}

/**
 * 一轮结束了：把**属于它**的、还没回话的确认都按「拒绝」结算掉。
 *
 * 为什么要它：不结算的话 promise 一直悬着、界面上那张卡也不会消失；
 * 用户看到的是「任务已经完了，但还在问我允许不允许」。
 * 只动 `owner` 相同的那几条 —— 同时跑着两条对话时，别把另一条的卡也灭了。
 *
 * @param {string} owner chat 的 requestId
 * @returns {{ closed: number }} 结算了几条（排查用；通常是 0）
 */
function settleAllFor(owner) {
  const key = String(owner ?? '')
  if (!key) return { closed: 0 }
  let closed = 0
  for (const [id, entry] of pending) {
    if (entry.owner !== key) continue
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve({ approved: false, answer: '', timeout: false, id })
    closed += 1
  }
  return { closed }
}

/** 还挂着几条（排查「界面没回话」用；自检要断言） */
function pendingCount() {
  return pending.size
}

/**
 * 按「超时」结算（AG-053 批③）。
 *
 * 给**外部时钟**用的：离场状态机（`clarify-timeout.cjs`）判定用户走开了之后，
 * 由主进程的 sweep 把这条请求按超时推进，而不是等 `ask()` 里那个 5 分钟的硬定时器。
 * 语义与自然超时**一字不差**（`timeout: true`）—— 两者走的是同一条下游。
 *
 * @returns {{ ok: boolean, error?: string }}
 */
function settleAsTimeout(id) {
  const entry = pending.get(String(id ?? ''))
  if (!entry) return { ok: false, error: '这个确认已经过期了' }
  pending.delete(String(id))
  clearTimeout(entry.timer)
  entry.resolve({ approved: false, answer: '', timeout: true, id: String(id) })
  return { ok: true }
}

/** 测试与热重载用：清空（真机上不该有半路的残留） */
function reset() {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}

module.exports = { ask, settle, settleAsTimeout, settleAllFor, pendingCount, reset }
