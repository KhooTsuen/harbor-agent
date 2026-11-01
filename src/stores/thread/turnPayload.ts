import type { sendChat } from '@/lib/backend'

/* ══════════════════════════════════════════════════════════════
   一轮对话发给主进程的载荷。

   从 `turns.ts` 拆出来（那边贴着 300 行红线）—— 纯对象拼装，没有别的副作用。
   ══════════════════════════════════════════════════════════════ */

type SendPayload = Parameters<typeof sendChat>[0]

export function buildSendPayload(opts: {
  requestId: string
  resumeTaskId: string
  /** AG-003：让主进程能用真正的「按下发送」时刻算延迟 */
  requestTime: number
  mode: string
  /** 这一轮是怎么起来的（只进日志）：用户发送 / 点继续 / 编辑后重答 / 重新生成 / 重试 */
  reason?: string
  origin?: 'edge-sidepanel'
  /** 「重新生成」的关联：被替代那条的磁盘 key */
  regeneratedFrom?: string
  regenerateIsLast?: boolean
  messages: SendPayload['messages']
  sessionId: string
  /** 这条会话自己选的模型；空/未选 = 交给内核用全局默认 */
  model?: string
  projectId?: string
  temporary?: boolean
  threadSettings?: SendPayload['threadSettings']
  workdir?: string
  /** 多模型协作的 A/B 选择（有 = 走协作链路，不是单模型 loop） */
  collab?: SendPayload['collab']
}): SendPayload {
  return {
    requestId: opts.requestId,
    resumeTaskId: opts.resumeTaskId,
    requestTime: opts.requestTime,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.regeneratedFrom
      ? { regenerateOf: opts.regeneratedFrom, regenerateIsLast: opts.regenerateIsLast === true }
      : {}),
    mode: opts.mode,
    /*
     * ★ 会话自己选的模型**必须发出去**（2026-09-28 用户报的 bug）：选择器只写了
     *   thread.model，内核以前从不读它 —— 「新建对话选了 gpt，实际还是 deepseek-flash」。
     */
    ...(opts.model ? { model: opts.model } : {}),
    messages: opts.messages,
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    temporary: opts.temporary,
    /* 思考档位跟着 threadSettings 一起发 —— 以前漏了，档位从没到过主进程 */
    threadSettings: opts.threadSettings,
    ...(opts.workdir ? { workdir: opts.workdir } : {}),
    ...(opts.collab ? { collab: opts.collab } : {}),
  }
}
