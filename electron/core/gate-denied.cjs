/**
 * 「计划被否决后停手」的硬拦截（A 闸门 · 2026-10-07）
 *
 * 背景：模型调 `ask_user({ gate: true })` 被拒之后，回话文本写着「立刻停手」，
 * 但那只是**提示** —— 它不听时还会接着调工具。2026-10-07 真机走查逮到过：
 * 判定「没批准」之后 36 秒，模型照样执行了一次 read_file（那次的 `ask_user`
 * 是它会话里唯一一次 plan gate）。
 *
 * 这个模块记下「哪个会话刚被否决」，由**工具咽喉** `core/tools/index.cjs`
 * 在每次调用前查一次 —— 命中就直接拒绝、不执行。
 *
 * ★ 状态只按**会话**记，且只活到下一轮：用户重新说话 = 新一轮，
 *   `loop-run.cjs` 的 run() 开头把它清掉。为什么不按任务记：gate 是
 *   「用户当场说先别动」的产物，用户下一条消息就是新指令，不该被上一轮绑住。
 * ★ 不 require electron（自检在纯 Node 里裸跑）。
 */

/** sessionId → 被否决的时刻（留它是为了排查「隔了多久才又想动手」） */
const denied = new Map()

/** 这一轮刚被否决（`ask-user-gate.runGate` 判出「没批准」时调） */
function deny(sessionId) {
  const key = String(sessionId ?? '')
  if (!key) return
  denied.set(key, Date.now())
}

/** 批准了、或者新一轮开始了 —— 解除 */
function allow(sessionId) {
  denied.delete(String(sessionId ?? ''))
}

/** 这次调用该不该被拦下（真机与自检共用这一处判据） */
function stopped(sessionId) {
  return denied.has(String(sessionId ?? ''))
}

/** 测试与热重载用：清空 */
function reset() {
  denied.clear()
}

const STOP_TEXT =
  '错误：这一次的执行已经被「计划复核」否决了（用户选了「先别动」/ 自己写了话 / 离场）。' +
  '按规矩这一轮到此为止：不要再调工具，把要改什么、还拿不准什么写成几行收尾，等他回来。'

module.exports = { deny, allow, stopped, reset, STOP_TEXT }
