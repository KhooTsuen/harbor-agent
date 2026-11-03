/**
 * 侧边栏要的**整条会话**（2026-11-03，从 `service-worker.js` 拆出）
 *
 * ── 为什么拆 ────────────────────────────────────────────────
 *
 * SW 已经 302 行（≤300 硬约束），而这次要加「读历史消息」。这条是**整块能搬走**
 * 的东西：它只管「问主进程要这段 → 顺手把形状理干净」，与面板 / 权限 / 指令
 * 那些业务无关。搬走后 SW 只多一行注入。
 *
 * ── 为什么必须走主进程 ──────────────────────────────────────
 *
 * 消息在会话文件里（`data/sessions/*.jsonl`），扩展侧读不到磁盘。而切片的判据
 * （尾部条数 / 单条上限 / 字节预算）在主进程只有一份
 * （`electron/core/ext-session-messages.cjs`）—— 扩展侧**不自己再切一遍**，
 * 否则就是硬约束 #9 要消灭的「两边各一套」。
 *
 * ── 不缓存 ─────────────────────────────────────────────────
 *
 * 用户发完一条就要重读（`useSessionHistory` 在发送成功、一轮跑完时都会问一次）。
 * 缓存只会让侧边栏显示旧内容，而这种错看起来像「消息丢了」。
 */

/**
 * @param {(type: string, payload?: Record<string, unknown>) => Promise<Record<string, any>>} requestHost
 *   通道层的请求函数（`lib/native.js` 的 `requestHost`）—— 由 SW 注入，
 *   本文件不直接 import，免得与 SW 互相依赖。
 * @returns {(sessionId?: string) => Promise<object>} 处理器（挂在面板路由的 `session-messages`）
 */
export function createSessionMessages(requestHost) {
  return async function getSessionMessages(sessionId) {
    /* 带了就带上；不带 → 让主进程按「侧边栏选中的 / 主窗口开着的」自己退 */
    const ask = sessionId ? { sessionId: String(sessionId) } : {}
    const reply = await requestHost('session-messages', ask)
    if (reply && reply.ok === true) {
      return {
        ok: true,
        sessionId: String(reply.sessionId ?? ''),
        title: String(reply.title ?? ''),
        messages: Array.isArray(reply.messages) ? reply.messages : [],
        /* 条数与丢弃数如实带回：界面据此说「还有 N 条更早的没显示」 */
        total: Number(reply.total ?? 0),
        dropped: Number(reply.dropped ?? 0),
        truncated: reply.truncated === true,
      }
    }
    return {
      ok: false,
      error: (reply && reply.error) || '拿不到这条对话的消息',
      code: (reply && reply.code) || '',
    }
  }
}
