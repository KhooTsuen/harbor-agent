/**
 * M04-3：**敏感操作确认**的接线层（复用 Harbor 既有的确认卡）
 *
 * ── 为什么单独一个文件 / 为什么这么薄 ─────────────────────────
 *
 * 「要不要问用户」的**判定**在 `core/ext-gate.cjs`（纯函数、可自检）；
 * 「怎么问」是**既有机制** —— `handlers/chat-confirm.cjs` 的 `askUser`
 * （写操作确认走的就是它）。这里只干一件事：**把两者接起来**。
 *
 * ★ 为什么必须接在 `handlers/` 这一层（而不是 `core/ext-command.cjs` 里直接调）：
 *   确认卡要向**渲染层**推一条 `chat:event`，而 `send` 只有这一层有。
 *   所以 `ext-command` 收的是**注入的** `confirm` 函数（`register-handlers.cjs` 注入），
 *   内核模块之间仍然互不 require —— 自检因此能单独跑 `ext-command`（喂一个假 confirm）。
 *
 * ── ★ 会话归属（`sessionId` 从哪来）────────────────────────────
 *
 * 确认卡要带 `sessionId`（渲染层据此把卡挂到那条对话上、并在轮次结束时收掉它）。
 * 这里用**渲染层上报的当前会话**（`extBridge.getActiveSession()`）—— 它正好对：
 * 会走到「模型点提交」这一步时，主窗口正在跑那条对话，而上报的值就是它。
 * （侧边栏**自己**选的会话是另一回事，那条只在 `ext-chat.cjs` 里 —— 与本卡无关。）
 *
 * ⚠️ 拿不到会话时**照样发卡**（`sessionId: ''`）：卡片仍会出现，只是不参与
 *    「切走时自动收卡」那条清理。宁可多留一张卡，也不要因为拿不到上下文就不问。
 */

const chatConfirm = require('./chat-confirm.cjs')

/**
 * @param {{ send: (channel: string, payload: object) => void,
 *           getSessionId?: () => string,
 *           log?: { info?: (m: string) => void, warn?: (m: string) => void } }} deps
 * @returns {(request: object, meta?: object) => Promise<boolean>} true = 用户允许
 */
function createExtConfirm(deps) {
  const send = deps.send
  const getSessionId = typeof deps.getSessionId === 'function' ? deps.getSessionId : () => ''
  const log = deps.log

  return async function confirmSensitive(request, meta) {
    const sessionId = String(getSessionId() ?? '')
    /* ★ 与写操作确认**同一条出口**：推给渲染层，由它弹那张熟悉的卡 */
    const emit = (payload) => send('chat:event', payload)
    const approved = await chatConfirm.askUser(
      /* requestId 只用于日志（不是审批 id —— 那个由 decisions 生成，见 chat-confirm 文件头） */
      'ext-browser-action',
      {
        name: String(request?.name ?? 'browser.click'),
        summary: String(request?.summary ?? '这一步要动网页，先跟你确认'),
        kind: String(request?.kind ?? 'browser-action'),
        impact: Array.isArray(request?.impact) ? request.impact : [],
        args: { ref: String(meta?.ref ?? '') },
      },
      emit,
      sessionId,
    )
    log?.info?.(`扩展通道：敏感操作确认（ref=${String(meta?.ref ?? '')} · 会话 ${sessionId || '(空)'}）→ ${approved ? '允许' : '拒绝/超时'}`)
    return approved === true
  }
}

module.exports = { createExtConfirm }
