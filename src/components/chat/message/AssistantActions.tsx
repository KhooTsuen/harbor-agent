import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Languages, RotateCcw } from 'lucide-react'
import type { Message } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { sceneTranslate } from '@/lib/sceneApi'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   助手消息的操作条（复制 / 重新生成 / 赞踩 / 分支）

   从 MessageItem.tsx 拆出来的 —— 那边加了 citation / artifact 渲染之后
   过了 300 行。这一段和「消息长什么样」没关系，纯操作，拆开很干净。
   ══════════════════════════════════════════════════════════════ */

export function AssistantActions({ message }: { message: Message }) {
  const branchThread = useAppStore((s) => s.branchThread)
  const continueThread = useThreadStore((s) => s.continueThread)
  const regenerate = useThreadStore((s) => s.regenerateMessage)
  const showToast = useUIStore((s) => s.showToast)
  const [copied, setCopied] = useState(false)
  const [translation, setTranslation] = useState('')
  const [translating, setTranslating] = useState(false)
  /*
   * 被中止 / 出错的回复 → 语义是「重试」（试着把同一目标跑完）
   * 正常回复 → 「重新生成」（换个写法再来一版）
   */
  const retry =
    message.interrupted === true || message.status === 'error' || message.kind === 'error'

  /** 再点一次收起译文；没翻过就去翻 */
  async function translate(): Promise<void> {
    if (translation) {
      setTranslation('')
      return
    }
    setTranslating(true)
    const result = await sceneTranslate(message.content)
    setTranslating(false)
    if (result.ok && result.text) setTranslation(result.text)
    else showToast('error', '翻译失败', result.error)
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* 忽略剪贴板失败 */
    }
  }

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          aria-label={copied ? '已复制' : '复制回复'}
          title="复制"
          onClick={() => void copy()}
          className="rounded p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          {copied ? (
            <Check size={13} style={{ color: colorOf('completed') }} />
          ) : (
            <Copy size={13} />
          )}
        </button>
        <button
          type="button"
          aria-label={translation ? '收起译文' : '翻译'}
          title={translation ? '收起译文' : '翻译（中英互译）'}
          onClick={() => void translate()}
          className="rounded p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <Languages size={13} className={translating ? 'animate-pulse' : undefined} />
        </button>
        <button
          type="button"
          aria-label="继续"
          title="继续"
          onClick={continueThread}
          className="rounded p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          aria-label="建立分支"
          title="建立分支"
          onClick={() => branchThread(message.threadId, message.id)}
          className="rounded p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <ChevronRight size={13} />
        </button>
        <button
          type="button"
          aria-label={retry ? '重试' : '重新生成'}
          title={retry ? '重试（这条没跑完 / 出错了，试着把同一目标完成）' : '重新生成'}
          onClick={() => regenerate(message.id)}
          className="rounded p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <RotateCcw size={13} />
        </button>
      </div>

      {/* 译文：单独一块，不覆盖原文 —— 对照着看才有用 */}
      {translation ? (
        <div className="mt-1.5 rounded-base border border-line-hairline bg-bg-raised/30 px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-2xs text-fg-tertiary">
            <Languages size={11} />
            译文
            <button
              type="button"
              onClick={() => setTranslation('')}
              className="ml-auto rounded px-1 transition-colors hover:bg-bg-hover hover:text-fg-primary"
            >
              收起
            </button>
          </div>
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-secondary">
            {translation}
          </div>
        </div>
      ) : null}
    </div>
  )
}
