/**
 * 「需要你确认」的通知文案（2026-10-03 用户报的 P1-3）
 *
 * 要解决的问题：用户切到别的窗口之后，Harbor 弹了澄清卡 / 权限确认，
 * 他**不知道**，任务就一直挂在那个卡上等。原来 AG-029 的通知只覆盖
 * 「任务完成 / 失败」，没有覆盖「需要你确认」。
 *
 * 和 `core/clarify-notice.cjs` 的分工（别把两件事混起来）：
 *   · `clarify-notice.cjs` —— 澄清**超时**之后「我替你定了什么」（事后告知）
 *   · 这个文件 —— **卡刚弹出来**时「我在等你点头」（事前叫人）
 *
 * 纯函数、不碰 Electron、不碰 IO：文案能单独断言（自检 32 组），
 * 「什么时候发」在 `handlers/chat-confirm.cjs`，「怎么发」在 `handlers/notify.cjs`。
 *
 * ⚠️ 权限那条**不另写一份工具名词表** —— `request.summary` 本来就是人话
 *   （内核各工具自己写的，见 `tools/permission.cjs` / `plugin-tool.cjs` 等），
 *   在这儿再映射一遍就是「同一件事两处定义」，迟早漂。
 */

/** 通知标题：用户一眼要看出「跟我有关、要我做点什么」 */
const TITLE = 'Harbor 需要你确认'

/** 正文里「在问什么」那一句的上限（Windows 通知正文放不下更多） */
const MAX_ASK_CHARS = 200

const clip = (value, max) => {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 多行摘要（权限那类常带换行）→ 通知里只留第一行有用的话 */
const firstLine = (value) =>
  String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? ''

/**
 * 澄清卡：在问什么。
 *
 * @param {Array<{question?: string}>} questions `core/clarify.cjs` 规范化后的问题
 */
function clarifyAsk(questions) {
  const list = Array.isArray(questions) ? questions : []
  const first = String(list[0]?.question ?? '').trim()
  if (!first) return '开工前想问几个问题'
  /* 问题多的时候要说清「不止这一个」—— 不然用户以为点一下答完就完了 */
  return list.length > 1 ? `开工前想问：${first}（共 ${list.length} 个问题）` : `开工前想问：${first}`
}

/**
 * 权限确认：在问什么。
 *
 * @param {{ summary?: string, toolName?: string }} request 和 `chat-confirm.askUser` 收到的同一份
 */
function permissionAsk(request = {}) {
  const summary = firstLine(request.summary)
  if (summary) return summary
  const tool = String(request.toolName ?? '').trim()
  return tool ? `要执行一步需要你点头的操作（${tool}）` : '要执行一步需要你点头的操作'
}

/** 拼一条通知的标题 + 正文（正文里带上「在问什么」） */
function confirmNotice(ask) {
  return { title: TITLE, body: clip(ask, MAX_ASK_CHARS) }
}

module.exports = { confirmNotice, clarifyAsk, permissionAsk, TITLE, MAX_ASK_CHARS }
