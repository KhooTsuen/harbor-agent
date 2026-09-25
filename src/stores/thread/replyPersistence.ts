import type { StoredMessage } from '@/types/backend'
import { useAppStore } from '@/stores/useAppStore'
import { shouldFlushPartial } from '@/lib/partialFlush'

/* ══════════════════════════════════════════════════════════════
   助手回复的落盘

   从 turns.ts 抽出来的（那边贴到 300 行上限了），顺便让它可测 ——
   以前这两段是埋在发送流程里的闭包，只能靠真机试。

   两条来由：

   ① 助手那条**只在 done / aborted 时落盘**。进程被强杀 / 崩溃时这两个事件
      都不会来，于是半截回复全丢（实测：会话文件里只剩用户那句）。
      → 所以有了 flushPartial：流式过程中分段落盘。

   ② 分段落盘会往同一个 key 追加好几行（会话文件是追加式的，没地方原地更新），
      收尾那条也带同一个 key，读的一侧按 key 收敛成一条。
   ══════════════════════════════════════════════════════════════ */

export interface ReplyPersistence {
  /** 流式过程中定期调用（判断很便宜，不满足就直接返回） */
  flushPartial: () => void
  /** 收到结束事件后调用一次 */
  persistReply: () => void
}

export function createReplyPersistence(opts: {
  threadId: string
  /** 占位消息的 id —— 同一条回复的所有记录共用它当 key */
  messageId: string
  timestamp: number
  /**
   * 这一轮答的是哪条提问、第几版 —— 落盘时带上。
   * 读会话时靠它把「同一次提问的几个回答」收成一条的多个版本
   * （以前没有这个标记，编辑/重生成产生的回答会并排堆在会话里）。
   */
  answersKey?: string
  answersVersion?: number
  /**
   * 这条回答是「重新生成」来的：指向被替代的那条回答（磁盘 key）。
   * 分段快照与收尾那条都带上 —— 进程被强杀后重开，也知道它是从哪条重来的。
   */
  regeneratedFrom?: string
  getContent: () => string
  getReasoning: () => string
  /** 最后一个事件类型：只有 done / aborted 才值得存 */
  getEventType: () => string
}): ReplyPersistence {
  const { threadId, messageId, timestamp, getContent, getReasoning, getEventType } = opts
  const answer = {
    ...(opts.answersKey ? { answersKey: opts.answersKey } : {}),
    ...(opts.answersVersion !== undefined ? { answersVersion: opts.answersVersion } : {}),
    ...(opts.regeneratedFrom ? { regeneratedFrom: opts.regeneratedFrom } : {}),
  }
  let lastFlushAt = 0
  let lastFlushLen = 0

  return {
    /*
     * 流式过程中分段落盘。
     *
     * 节奏交给 shouldFlushPartial（至少隔几秒、且内容长了才写）。
     * 记录里**不带 toolRuns** —— 每次都要写整段，把工具日志每几秒重写一遍
     * 太浪费；工具干过什么在任务台账里有（步骤摘要）。
     */
    flushPartial: () => {
      const content = getContent()
      const now = Date.now()
      if (!shouldFlushPartial(content.length, lastFlushLen, now, lastFlushAt)) return
      lastFlushAt = now
      lastFlushLen = content.length
      const reasoning = getReasoning()
      useAppStore.getState().persistMessage(threadId, {
        role: 'assistant',
        key: messageId,
        partial: true,
        content,
        ...(reasoning ? { reasoning } : {}),
        ...answer,
        ts: timestamp,
      })
    },

    /*
     * 收尾。**只在收到结束事件时调用**。
     *
     * 存的是**收尾后状态里的那条消息**，不是闭包里那几个变量：usage 只在状态里，
     * toolRuns 在流式过程中被复制过几份，读它更稳。
     * aborted 也存 —— 那是用户自己按停的，半截回复也是结果；error 不存，
     * 把报错当历史喂回模型没有意义。
     */
    persistReply: () => {
      const type = getEventType()
      if (type !== 'done' && type !== 'aborted') return
      const final = useAppStore
        .getState()
        .threads.find((t) => t.id === threadId)
        ?.messages.find((m) => m.id === messageId)
      if (!final) return
      const text = final.content ?? ''
      /* 空回复（比如刚发出去就被停掉）不写 —— 免得会话里多一条空消息 */
      if (!text.trim() && (final.toolRuns ?? []).length === 0) return
      const message: StoredMessage = {
        role: 'assistant',
        key: messageId,
        content: text,
        ...(final.reasoning ? { reasoning: final.reasoning } : {}),
        ...(final.toolRuns?.length ? { toolRuns: final.toolRuns } : {}),
        ...(final.citations?.length ? { citations: final.citations } : {}),
        ...(final.usage ? { usage: final.usage } : {}),
        /* 被中止的那条：落盘标上 aborted —— 重开会话后「重试」文案还能回来 */
        ...(type === 'aborted' ? { aborted: true } : {}),
        ...answer,
        ts: final.timestamp,
      }
      useAppStore.getState().persistMessage(threadId, message)
    },
  }
}
