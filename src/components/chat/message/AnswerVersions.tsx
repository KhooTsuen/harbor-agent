import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Message } from '@/types'
import { answersOfVersion } from '@/lib/answers'
import { useThreadStore } from '@/stores/useThreadStore'

/* ══════════════════════════════════════════════════════════════
   回答的 ‹ n / N ›

   同一次提问可以有好几个回答（重新生成过、或者编辑后重跑过）。以前这些回答
   会**并排堆在会话里**，而切提问版本时又会再生成一个 —— 用户报的就是这个。

   现在读会话时内核按 (answersKey, answersVersion) 把它们收成一条的多个版本，
   这里只负责切：**换一条显示，不重跑**。
   和用户消息那边的版本切换器同一个形状（常显、不放进悬停操作条）——
   它得让人一眼看到「这个回答有好几版」。
   ══════════════════════════════════════════════════════════════ */

export function AnswerVersions({ message }: { message: Message }) {
  const activateAnswer = useThreadStore((s) => s.activateAnswer)
  const records = answersOfVersion(message.answerRecords, message.answersVersion ?? 0)
  if (records.length < 2) return null
  const index = Math.min(message.answerIndex ?? records.length - 1, records.length - 1)

  return (
    <div
      className="mt-1 flex items-center gap-0.5 text-2xs text-fg-tertiary"
      data-answer-versions="true"
    >
      <button
        type="button"
        aria-label="上一个回答"
        disabled={index <= 0}
        onClick={() => activateAnswer(message.threadId, message.id, index - 1)}
        className="rounded-sm p-0.5 transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronLeft size={12} />
      </button>
      <span className="tabular-nums" title="这条提问有好几个回答，可以来回切（切换不会重新生成）">
        {index + 1} / {records.length}
      </span>
      <button
        type="button"
        aria-label="下一个回答"
        disabled={index >= records.length - 1}
        onClick={() => activateAnswer(message.threadId, message.id, index + 1)}
        className="rounded-sm p-0.5 transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronRight size={12} />
      </button>
    </div>
  )
}
