import { ArrowUp, LoaderCircle, Pause, Send, Square } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'

/*
 * 发送 / 暂停 / 停止 三个按钮（AG-011 从 Composer 抽出来 —— 那边 300 行顶格了）。
 *
 * 暂停和停止是**两件事**，所以给两个按钮：
 *   暂停 —— 做完手上这步再停，之后能接着做
 *   停止 —— 立刻断，正在跑的命令会被杀掉
 * 合成一个按钮会让人不敢按，也说不清按下去到底是哪种。
 */

export function SendControls({
  sending,
  hasContent,
  canSend,
  unavailableReason,
  onSend,
  onPause,
  onStop,
  onSendImmediately,
}: {
  sending: boolean
  /** 输入框里有东西吗 —— 决定停止按钮的提示要不要多说一句 */
  hasContent: boolean
  canSend: boolean
  unavailableReason: string | null
  onSend: () => void
  onPause: () => void
  onStop: () => void
  onSendImmediately: () => Promise<boolean>
}) {
  const [sendingImmediately, setSendingImmediately] = useState(false)
  if (sending) {
    return (
      <>
        <Tooltip content="暂停（做完手上这步再停）">
          <IconButton label="暂停生成" size={32} onClick={onPause} className="rounded-full">
            <Pause size={14} fill="currentColor" />
          </IconButton>
        </Tooltip>
        <Tooltip content="停止生成">
          <IconButton label="停止生成" size={32} onClick={onStop} className="rounded-full">
            <Square size={14} fill="currentColor" />
          </IconButton>
        </Tooltip>
        {/*
         * AG-025：跑着的时候，输入框里有内容就多一个「排队发送」。
         * 点它 → 消息进队列、输入框清空，当前任务完成后自动发。
         */}
        {hasContent ? (
          <Tooltip content="加入队列，当前任务完成后自动发送">
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              aria-label="排队发送"
              className={cn(
                'grid size-8 place-items-center rounded-full transition-colors duration-fast',
                'bg-accent text-fg-on-emphasis hover:bg-accent-hover',
              )}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </Tooltip>
        ) : null}
        {hasContent ? (
          <Tooltip content="先停止当前任务，确认停止后立即发送这条消息；原队列保留">
            <button
              type="button"
              disabled={!canSend}
              onClick={() => {
                if (sendingImmediately) return
                setSendingImmediately(true)
                void onSendImmediately().finally(() => setSendingImmediately(false))
              }}
              aria-label="立即发送（先停止当前任务）"
              className={cn(
                'flex h-8 items-center gap-1 rounded-full px-2.5 text-xs transition-colors duration-fast',
                'bg-bg-raised text-fg-primary hover:bg-bg-hover disabled:opacity-60',
              )}
            >
              {sendingImmediately ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <Send size={13} />
              )}
              立即发送
            </button>
          </Tooltip>
        ) : null}
      </>
    )
  }

  return (
    <Tooltip content={canSend ? '发送' : (unavailableReason ?? '暂时无法发送')}>
      <button
        type="button"
        onClick={onSend}
        disabled={!canSend}
        aria-label="发送消息"
        className={cn(
          'grid size-8 place-items-center rounded-full transition-colors duration-fast',
          'bg-cta text-cta-fg hover:bg-cta-hover',
          'disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-tertiary',
        )}
      >
        <ArrowUp size={16} strokeWidth={2.5} />
      </button>
    </Tooltip>
  )
}
