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
 *           payload?: Record<string, unknown>, idPrefix?: string }} options
 * @returns {Promise<{ approved: boolean, answer: string, timeout: boolean, id: string }>}
 */
function ask({ emitReply, timeoutMs = 5 * 60 * 1000, payload = {}, idPrefix = 'cfm' }) {
  return new Promise((resolve) => {
    const id = newId(idPrefix)
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      /* 超时：**不是**用户拒绝 —— 澄清那边要按默认选项继续（`timeout: true`） */
      resolve({ approved: false, answer: '', timeout: true, id })
    }, timeoutMs)

    pending.set(id, { resolve, timer })
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

/** 还挂着几条（排查「界面没回话」用；自检要断言） */
function pendingCount() {
  return pending.size
}

/** 测试与热重载用：清空（真机上不该有半路的残留） */
function reset() {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}

module.exports = { ask, settle, pendingCount, reset }
