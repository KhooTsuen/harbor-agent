import type { Message, MessageRound } from '@/types'
import { handleNoticeEvent } from './noticeEvents'
import { rollbackToRoundStart, type RetryMarks } from './retryRollback'

/* ══════════════════════════════════════════════════════════════
   「轻事件」：重试回滚 + 只弹提示的那几种

   从 `streamEvents.ts` 拆出来的（那边这次改完 353 行，贴了 300 红线）。
   挑这一块搬，是因为它有一条**清楚的边界**：下面这些事件**都不产生新内容** ——
   它们要么把已经流出去的字退掉（retry），要么只是说一声（notice / boundary /
   budget / fallback / context_overflow）。

   ★ 为什么 retry 要单独拎出来（2026-10-21 用户真机报的「回答显示两遍」）
   ────────────────────────────────────────────────────────────
   上游报可重试的错（限流 / 超时 / 服务器错）时 `loop-model.cjs:148-152` 会
   **从头重新请求整段**。渲染层以前只把新分片往后追加 —— 于是这一轮变成
   「上次的半截 + 这次的整段」，屏幕上同一段话两遍。用户截图里的形状正是这样：
   第一段断在句子中间，第二段从中间那句话开始把全文再说一遍。

   主进程给扩展侧边栏的那份快照（`ext-chat-streams.cjs:132-139`）早就在同一处
   回滚了，注释写的也是同一句话；只有这条主链路漏了。规则本身在 `retryRollback.ts`。

   提示**保留**（用户拍板）：回滚只管屏幕上的字，不吞「刚才失败过一次」这件事。
   ══════════════════════════════════════════════════════════════ */

/** 这几类事件走这里（其余留在 streamEvents 的 switch 里） */
const LIGHT_TYPES = new Set([
  'retry',
  'boundary',
  'budget',
  'notice',
  'fallback',
  'context_overflow',
])

export function isLightEvent(type: string): boolean {
  return LIGHT_TYPES.has(type)
}

/** 回滚要读写的几个字段（只声明用得到的，省得为了测一个函数造整条消息） */
export interface RetryTarget {
  content: string
  reasoning: string
  rounds: MessageRound[]
  retryMarks: RetryMarks
  patch: (fields: Partial<Message>) => void
}

/**
 * 处理一个轻事件。调用方先确认 `isLightEvent(type)`。
 *
 * @returns 是否真的接住了（`false` = 不在清单里，交回调用方的 switch）
 */
export function dispatchLightEvent(
  type: string,
  event: Record<string, unknown>,
  target: RetryTarget,
): boolean {
  if (!LIGHT_TYPES.has(type)) return false

  if (type === 'retry') {
    const rolled = rollbackToRoundStart(
      target.content,
      target.reasoning,
      target.rounds,
      target.retryMarks,
    )
    /*
     * 一个字都没退就不写字段 —— 那说明这次重试没有任何半截要丢
     * （比如第一次请求就失败），省一次无谓的重渲。
     */
    if (rolled.changed) {
      target.content = rolled.content
      target.reasoning = rolled.reasoning
      target.rounds = rolled.rounds
      target.patch({
        content: target.content,
        reasoning: target.reasoning,
        rounds: [...target.rounds],
      })
    }
  }

  /* 提示照旧（回滚不替代「正在重试」这句话） */
  handleNoticeEvent(event)
  return true
}
