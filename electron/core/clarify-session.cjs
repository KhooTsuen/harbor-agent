/**
 * 澄清：**这条对话现在是什么状态**（AG-053 批③ 从 `clarify.cjs` 拆出来的）
 *
 * 两件按对话记的事，都是「要不要问他」的前置判断：
 *   ① **静音** —— 同一对话连续跳过 2 次就不再主动问（纯内存、不写偏好：
 *      用户连拒两次是「这次别打扰我」，不是「以后都别问」）。
 *   ② **无人值守** —— 定时任务那一轮：没人在场，**不弹卡、不挂请求**，
 *      直接按默认选项开工（见 `tools/ask_user.cjs`）。
 *
 * 为什么拆：`clarify.cjs` 加完无人值守变成了 314 行（硬约束 #2 是 300）。
 * 拆的口子选在这里而不是随便切一半 —— 校验（`normalize`）和措辞（`render`）
 * 是**纯函数**，这里两个是**按对话累积的状态**，改动的理由完全不同：
 * 前者跟着需求变，后者跟着「用户怎么对待这张卡」变。
 *
 * ⚠️ 不 require electron（自检/单测要能裸跑）。
 */

/** 连续跳过几次就静音（用户连拒两次说明不想被打扰，第三次还问是骚扰） */
const SKIP_LIMIT = 2

/* ── ① 静音 ───────────────────────────────────────────────── */

/** sessionId → 连续跳过的次数 */
const skips = new Map()

/** 用户跳过一次 */
function noteSkip(sessionId) {
  const key = String(sessionId ?? '')
  if (!key) return 0
  const next = (skips.get(key) ?? 0) + 1
  skips.set(key, next)
  return next
}

/** 用户答过一次（哪怕只答了一问）→ 计数清零：他愿意被问，之前的跳过不算数 */
function noteAnswered(sessionId) {
  skips.delete(String(sessionId ?? ''))
}

/** 这个对话现在静音了吗 */
function muted(sessionId) {
  return (skips.get(String(sessionId ?? '')) ?? 0) >= SKIP_LIMIT
}

/**
 * 手动唤醒（「问我想清楚」按钮 / 用户说「你问我几个问题」）。
 *
 * 静音是「别老问了」，不是「永远别问」——用户主动要求的时候要能立刻恢复。
 * 唤醒是**一次性**的：问完这一次，如果他再跳过，计数从头开始。
 */
function wake(sessionId) {
  const key = String(sessionId ?? '')
  if (key) skips.set(key, 0)
  return 0
}

/** 测试与排查用：看当前计数（自检要断言；生产代码不调它） */
function skipCount(sessionId) {
  return skips.get(String(sessionId ?? '')) ?? 0
}

/* ── ② 无人值守（定时任务） ───────────────────────────────── */

/** 正在跑的无人值守对话（sessionId） */
const unattended = new Set()

/**
 * 标上「这个对话是无人值守的」（定时任务开跑时调）。
 *
 * 为什么是「对话登记表」而不是给 `ctx` 加字段：拼 ctx 的 `loop.cjs` 是硬禁区
 * （它只认自己知道的那几个键），而**发起方**（`schedule-run.cjs`）恰好知道 sessionId。
 *
 * @returns {() => void} 清理函数 —— 请放在 finally 里，否则这条对话永远不再问。
 */
function markUnattended(sessionId) {
  const key = String(sessionId ?? '')
  if (!key) return () => {}
  unattended.add(key)
  return () => unattended.delete(key)
}

/** 这个对话现在是不是无人值守 */
function isUnattended(sessionId) {
  return unattended.has(String(sessionId ?? ''))
}

module.exports = {
  SKIP_LIMIT,
  noteSkip,
  noteAnswered,
  muted,
  wake,
  skipCount,
  markUnattended,
  isUnattended,
}
