/**
 * 「这一轮要不要问他」—— 澄清开关的**唯一判断点**（AG-053 批④）
 *
 * 三件事以前散在三处（配置在 `clarify-config`、静音在 `clarify-session`、
 * 判断却在 `loop-prompt` 里手写），于是出现过这种形状的 bug：
 * `loop-prompt` 读的是 `options.clarifyMuted`，而**那个字段根本没人赋值** ——
 * 静音之后提示词里照旧写着「先问」，模型就去问了，工具那边却拒绝（两边说法不一致）。
 *
 * 现在判断只有这一处，工具侧（`tools/ask_user.cjs` 的 `muted()`）和提示词侧
 * 读的是**同一份状态**：
 *
 *   ① 这条对话静音了吗（连跳两次）→ 规则不注入、工具也不问
 *   ② 他这轮明确说「你问我几个问题」→ **当场解除静音**（一次性，不写偏好）
 *
 * ⚠️ 为什么单独一个文件：`loop-prompt.cjs` 本来就贴着 300 行。
 *   那边只剩「取一次值」的一行，理由留在这儿。
 * ⚠️ 不 require electron（自检/单测要能裸跑）。
 */

const session = require('./clarify-session.cjs')

/**
 * 这一轮该不该按「静音」处理。
 *
 * @param {{ sessionId?: string, lastUserText?: string }} input
 * @returns {boolean} true = 别问了（规则不注入 + 工具会拒绝）
 */
function mutedFor({ sessionId = '', lastUserText = '' } = {}) {
  /* 用户明确要求被问 → 先解除静音，再按解除后的状态判 */
  if (session.looksLikeAskMe(lastUserText)) session.wake(sessionId)
  return session.muted(sessionId)
}

module.exports = { mutedFor }
