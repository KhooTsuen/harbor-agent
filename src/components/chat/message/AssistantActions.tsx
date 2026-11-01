import { useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Languages,
  RotateCcw,
} from 'lucide-react'
import type { Message } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { sceneTranslate } from '@/lib/sceneApi'
import { colorOf } from '@/lib/statusLanguage'
import { fullRecordText } from '@/lib/export'

/* ══════════════════════════════════════════════════════════════
   助手消息的操作条（复制 / 重新生成 / 赞踩 / 分支）

   从 MessageItem.tsx 拆出来的 —— 那边加了 citation / artifact 渲染之后
   过了 300 行。这一段和「消息长什么样」没关系，纯操作，拆开很干净。

   ── 两个复制（2026-10-21）─────────────────────────────────────
   默认那颗只给**正文** —— 用户要贴出去的通常就是答案本身。
   「复制完整记录」把过程（思考 / 工具 / 用时 / 状态）也带上，
   排查问题和留档用它。两者内容是**分开的**，不是一个按钮两种格式。
   ══════════════════════════════════════════════════════════════ */

export function AssistantActions({ message }: { message: Message }) {
  const branchThread = useAppStore((s) => s.branchThread)
  const continueThread = useThreadStore((s) => s.continueThread)
  const regenerate = useThreadStore((s) => s.regenerateMessage)
  const showToast = useUIStore((s) => s.showToast)
  const [copied, setCopied] = useState(false)
  const [copiedFull, setCopiedFull] = useState(false)
  const [translation, setTranslation] = useState('')
  const [translating, setTranslating] = useState(false)
  /*
   * 被中止 / 出错的回复 → 语义是「重试」（试着把同一目标跑完）
   * 正常回复 → 「重新生成」（换个写法再来一版）
   */
  const retry =
    message.interrupted === true || message.status === 'error' || message.kind === 'error'

  /**
   * 有没有「正文之外的东西」可复制。
   *
   * 判据与 `ProcessPanel` / `processSection` 同一套（思考或工具至少有一个），
   * 而且**不把状态算进去**：一条没跑完但一步都没走的回复，完整记录和正文
   * 只差一句「这条没写完」—— 那不值得多一颗按钮。
   */
  const hasRecord = Boolean(message.reasoning?.trim()) || (message.toolRuns?.length ?? 0) > 0

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
      /* 默认只复制**正文**（用户 2026-10-21 拍板：过程不该混进要贴给别人的答案里） */
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* 忽略剪贴板失败 */
    }
  }

  /** 复制**完整记录**（过程 + 正文 + 状态）—— 排查问题、留档时用 */
  async function copyFull(): Promise<void> {
    try {
      await navigator.clipboard.writeText(fullRecordText(message))
      setCopiedFull(true)
      window.setTimeout(() => setCopiedFull(false), 1400)
    } catch {
      showToast('error', '复制失败')
    }
  }

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          aria-label={copied ? '已复制' : '复制回复'}
          title="复制（只有正文）"
          onClick={() => void copy()}
          className="rounded p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          {copied ? (
            <Check size={13} style={{ color: colorOf('completed') }} />
          ) : (
            <Copy size={13} />
          )}
        </button>
        {/*
          复制完整记录：只在**确实有过程**时出现。
          纯问答也挂一个按钮，点了得到和「复制」一模一样的内容 —— 那是骗人的第二颗按钮。
        */}
        {hasRecord ? (
          <button
            type="button"
            aria-label={copiedFull ? '已复制完整记录' : '复制完整记录'}
            title="复制完整记录（含过程、工具与状态）"
            onClick={() => void copyFull()}
            className="rounded p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
          >
            {copiedFull ? (
              <Check size={13} style={{ color: colorOf('completed') }} />
            ) : (
              <FileText size={13} />
            )}
          </button>
        ) : null}
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
