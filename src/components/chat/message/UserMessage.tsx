import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Message } from '@/types'
import type { ForkPoint } from '@/lib/branchPath'
import { cn, clockTime } from '@/lib/utils'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { ForkBadge } from '@/components/chat/branch/ForkBadge'
import { MessageEditor } from '../MessageEditor'

/* ══════════════════════════════════════════════════════════════
   用户那一侧

   从 MessageItem 抽出来的（那边贴着 300 行上限）：图片 / 气泡（或就地编辑）/
   版本切换 / 悬停操作条 —— 这几块都只跟「用户消息」有关，和助手那条的渲染没有交集。

   ★ 版本切换 `‹ 2 / 2 ›` 是**常显**的（不放进悬停操作条）：
     它得让人一眼看到「这条改过几次」，而不是鼠标划过去才知道。
     这条消息改过几版存在 message.versions / versionIndex 上 ——
     编辑一次是**同一条消息**多一版，不是多出一条一模一样的提问。
   ══════════════════════════════════════════════════════════════ */

export function UserMessage({ message, fork }: { message: Message; fork?: ForkPoint }) {
  const [editing, setEditing] = useState(false)
  const editAndRerun = useThreadStore((s) => s.editAndRerun)
  const activateUserVersion = useThreadStore((s) => s.activateUserVersion)
  const branchThread = useAppStore((s) => s.branchThread)

  const versions = message.versions ?? []
  const versionIndex = message.versionIndex ?? 0

  return (
    <div className={cn('flex flex-col gap-1', editing ? 'w-full' : 'max-w-[78%] items-end')}>
      {/* 用户贴的图：贴在气泡上方，和聊天软件的习惯一致 */}
      {message.images && message.images.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-2">
          {message.images.map((src) => (
            <img
              key={src.slice(-32)}
              src={src}
              alt="我贴的图片"
              className="max-h-48 rounded-md border border-line-hairline"
            />
          ))}
        </div>
      ) : null}

      {editing ? (
        <MessageEditor
          initial={message.content}
          onCancel={() => setEditing(false)}
          onSave={(text) => {
            setEditing(false)
            /* 改内容 + 按新内容重新回答（同一条消息多一版，不会多出一条提问） */
            editAndRerun(message.threadId, message.id, text)
          }}
        />
      ) : message.content ? (
        <div className="rounded-md rounded-br-sm bg-bg-raised px-3.5 py-2 text-base leading-relaxed text-fg-primary">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      ) : null}

      {versions.length > 1 ? (
        <div
          className="flex items-center gap-0.5 text-2xs text-fg-tertiary"
          data-message-versions="true"
        >
          <button
            type="button"
            aria-label="上一版"
            disabled={versionIndex <= 0}
            onClick={() => activateUserVersion(message.threadId, message.id, versionIndex - 1)}
            className="rounded-sm p-0.5 transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronLeft size={12} />
          </button>
          <span className="rounded-sm border border-accent-border bg-accent-subtle px-1 tabular-nums text-fg-primary">
            {versionIndex + 1} / {versions.length}
          </span>
          <button
            type="button"
            aria-label="下一版"
            disabled={versionIndex >= versions.length - 1}
            onClick={() => activateUserVersion(message.threadId, message.id, versionIndex + 1)}
            className="rounded-sm p-0.5 transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronRight size={12} />
          </button>
          {fork ? <ForkBadge fork={fork} /> : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          className="text-2xs text-fg-tertiary hover:text-fg-primary"
          onClick={() => setEditing(true)}
        >
          编辑
        </button>
        <button
          type="button"
          className="text-2xs text-fg-tertiary hover:text-fg-primary"
          onClick={() => branchThread(message.threadId, message.id)}
        >
          分支
        </button>
        {message.edited ? (
          <span className="text-2xs text-fg-tertiary" title="这条消息被改过">
            已编辑
          </span>
        ) : null}
        <span className="pr-0.5 text-2xs text-fg-tertiary">{clockTime(message.timestamp)}</span>
      </div>
    </div>
  )
}
