/**
 * 侧边栏的「对话」区块（任务卡 + 当前网页卡 + 发消息 + 看流式回复）
 *
 * 做：把用户打的字交给 SW（→ host → 主进程 → **渲染层**去跑），并把主进程推来的
 *     流式分片显示出来；点顶栏 **☰** 时把会话抽屉滑出来**覆盖**这一块。
 * 不做：**不落盘、不判忙**。落盘在渲染层（`replyPersistence.ts`）；「忙不忙」
 *     由主进程判（`electron/core/ext-chat.cjs`）—— 判据只有一处，扩展侧不自己猜。
 * 一轮的显示（含 Markdown）在 `TurnBubble.tsx`；任务卡在 `TaskCard.tsx`；
 * 当前网页卡在 `PageCard.tsx`；**流式订阅**在 `useChatStream.ts`
 * —— 本文件 2026-10-20 已贴 300 红线，能搬的都搬走了。
 *
 * ── 流事件 / 冷启动 ─────────────────────────────────────────
 * SW 广播 `chat:event`，字段：`sessionId` / `seq` / `type` / `text` / `done`。
 * `seq` 单调 —— 只认更大的（广播重排不会把旧片盖上去）。打开面板时问一次
 * `chat-resume` 拿**快照**（全文 + seq），而不是补发历史分片（见 3b 设计 §3.2）。
 *
 * ── ★ 两个 aria-label 是验收脚本的锚点（改了就静默失效）──────
 *   · `回复正文`（在 TurnBubble）→ accept-phase3b 的 `REPLY_TEXT`
 *   · `发送提示` → `NOTICE_TEXT`，同时是 ext-probe 的 `STATUS_TEXT_EXPR` 锚点
 *     （取文档里**第一个** role=status + aria-live）→ **只能有一个**。
 *
 * 状态行为什么由 App 持有：顶栏那两个占位按钮也要往同一行写话，而「只有一行」
 * 是硬要求（同上是锚点）。
 */

/* global chrome */

import { useCallback, useRef, useState } from 'react'
import { Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ReadPageButton, type StatusMessage } from './ReadPageButton'
import { ObserveButton } from './ObserveButton'
import { SessionDrawer } from './SessionDrawer'
import { SettingsDrawer } from './SettingsDrawer'
import { TaskCard } from './TaskCard'
import { PageCard } from './PageCard'
/* M02-A：一轮的显示 + Markdown 搬到 TurnBubble（本文件贴 300 红线） */
import { TurnBubble } from './TurnBubble'
/* M02-B：流式订阅 + 任务卡状态累加搬到这里（本文件贴 300 红线） */
import { useChatStream } from './useChatStream'
import { useSelectionDraft } from './useSelectionDraft'

export function ChatPanel({
  connected,
  sessionId,
  drawerOpen,
  onCloseDrawer,
  onSelectSession,
  status,
  onStatus,
  settingsOpen,
  onCloseSettings,
  lastError,
  onRetry,
}: {
  connected: boolean
  /**
   * 侧边栏**自己**在看的那条会话（Phase 3c，App 持有并落 `chrome.storage`）。
   * 空串 = 还没选 —— 这时发消息会**新建一条**，而不是悄悄落进主窗口那条（用户拍板）。
   */
  sessionId: string
  drawerOpen: boolean
  onCloseDrawer: () => void
  /** 抽屉里点了某条（Phase 3c）—— App 负责发给 SW，且**只切侧边栏** */
  onSelectSession: (id: string) => void
  /** 状态行**由 App 持有**：顶栏那两个占位按钮也要往同一行写话（单一元素，见文件头） */
  status: StatusMessage | null
  onStatus: (s: StatusMessage | null) => void
  /** M02-C：设置抽屉 —— 连接信息 / 能力清单 / 站点权限指路 */
  settingsOpen: boolean
  onCloseSettings: () => void
  /** 设置抽屉里显示人话错误 + 重试（沿用顶栏那条，不另编一套） */
  lastError: string | null
  onRetry: () => void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const input = drafts[sessionId] ?? ''
  const setInput = useCallback((text: string) => {
    setDrafts((prev) => ({ ...prev, [sessionId]: text }))
  }, [sessionId])
  const appendSelection = useCallback((owner: string, text: string) => {
    setDrafts((prev) => ({ ...prev, [owner]: [prev[owner], text].filter(Boolean).join('\n\n') }))
  }, [])
  useSelectionDraft(sessionId, appendSelection)
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId
  const scopedStatus = useCallback((next: StatusMessage | null) => {
    if (currentSession.current === sessionId) onStatus(next)
  }, [onStatus, sessionId])
  const [sendingIds, setSendingIds] = useState<string[]>([])
  const sending = sendingIds.includes(sessionId)
  const setSending = useCallback((next: boolean) => {
    setSendingIds((ids) => next ? [...new Set([...ids, sessionId])] : ids.filter((id) => id !== sessionId))
  }, [sessionId])
  /** M02-A2：正在等「停止」的回执（防连点） */
  const [stoppingIds, setStoppingIds] = useState<string[]>([])
  const stopping = stoppingIds.includes(sessionId)
  const setStopping = useCallback((next: boolean) => {
    setStoppingIds((ids) => next ? [...new Set([...ids, sessionId])] : ids.filter((id) => id !== sessionId))
  }, [sessionId])
  /* 正文 + 任务卡状态 + 此刻的会话 ref：全在 hook 里（收事件那一摊） */
  const { turn, setTurn, task, sidRef } = useChatStream(sessionId)
  const [regeneratingIds, setRegeneratingIds] = useState<string[]>([])
  const regenerating = regeneratingIds.includes(sessionId)

  /* 有回复正在流吗（组件作用域：发送 / 停止按钮 / 停止本身三处共用）。
     ⚠️ 原先它是 `send` 里的局部 const 却被 JSX 用了 → 真机**整页白屏**
     （ReferenceError: streaming is not defined）—— 那种错只有真机跑才现形。 */
  const streaming = Boolean(turn && !turn.done)

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    scopedStatus(null)
    /* ★ 正在流时**不要**换掉显示：否则「忙时又发一条」会把正在看的流清空（真机逮到） */
    if (!streaming) setTurn({ ask: text, text: '', seq: 0, done: false })
    try {
      const p = chrome.runtime.sendMessage({ type: 'chat-send', text, sessionId })
      if (!p || typeof p.then !== 'function') {
        scopedStatus({ text: '扩展上下文不可用', tone: 'danger' })
        setSending(false)
        return
      }
      p.then((res: { ok?: boolean; error?: string } | undefined) => {
        setSending(false)
        if (res && res.ok === true) {
          setInput('')
          /* 空会话时主进程请渲染层**新建一条**；新 id 由 `session:selected` 推回来，这里不等 */
          return
        }
        /* 被拒（忙 / 没窗口）—— 显示**主进程给的原话**，不自己编 */
        scopedStatus({ text: String(res?.error ?? '发不出去'), tone: 'danger' })
        if (!streaming) setTurn(null)
      }).catch((error: unknown) => {
        setSending(false)
        scopedStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
        if (!streaming) setTurn(null)
      })
    } catch (error) {
      setSending(false)
      scopedStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
      if (!streaming) setTurn(null)
    }
  }, [input, sending, streaming, sessionId, scopedStatus, setTurn, setInput, setSending])

  /* M02-A2：**停止**正在跑的这一轮。
     ★ 不做「本地把显示停掉」—— 那是放弃接收、主进程照跑（规格要的是**真正取消**）。
     回执原话进状态行；**没在跑时它会如实说没停**。 */
  const stop = useCallback(() => {
    setStopping(true)
    const sid = sidRef.current
    try {
      const p = chrome.runtime.sendMessage({ type: 'chat-abort', sessionId: sid })
      if (!p || typeof p.then !== 'function') {
        setStopping(false)
        return
      }
      p.then((res: { ok?: boolean; error?: string } | undefined) => {
        setStopping(false)
        scopedStatus({
          text: res && res.ok === true ? '已请求停止 —— 这条对话正在收尾' : String(res?.error ?? '停不了'),
          tone: res && res.ok === true ? 'info' : 'danger',
        })
      }).catch((error: unknown) => {
        setStopping(false)
        scopedStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
      })
    } catch (error) {
      setStopping(false)
      scopedStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
    }
  }, [scopedStatus, sidRef, setStopping])

  const regenerate = useCallback(() => {
    if (!sessionId || regenerating) return
    const owner = sessionId
    setRegeneratingIds((ids) => [...new Set([...ids, owner])])
    chrome.runtime.sendMessage({ type: 'chat-regenerate', sessionId: owner })
      .then((result: { ok?: boolean; error?: string }) => {
        scopedStatus(result?.ok ? { text: '已请求重新生成，旧回答会保留为历史版本', tone: 'info' } : { text: String(result?.error || '无法重新生成'), tone: 'danger' })
        if (!result?.ok) setRegeneratingIds((ids) => ids.filter((id) => id !== owner))
        else setTimeout(() => setRegeneratingIds((ids) => ids.filter((id) => id !== owner)), 10000)
      })
      .catch((error: unknown) => {
        scopedStatus({ text: String((error as Error)?.message || error), tone: 'danger' })
        setRegeneratingIds((ids) => ids.filter((id) => id !== owner))
      })
  }, [sessionId, regenerating, scopedStatus])

  return (
    <section aria-label="对话" className="flex min-h-0 flex-1 flex-col">
      {/* M02-B：当前网页卡（扩展自己读，不经主进程）+ 任务卡（有任务时才出现） */}
      <PageCard onStatus={scopedStatus} />
      <TaskCard state={task} />

      {/* 消息区 + 抽屉：抽屉是 absolute 覆盖，**不是**并排（400px 宽容不下并排）*/}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div aria-label="消息流" className="h-full overflow-y-auto px-3 py-2 text-dense">
          {!turn ? (
            /*
             * 空状态垂直居中：原来 `py-2` 直接顶在最上面，下面一大片空黑，
             * 看着像「内容没加载出来」（用户 2026-10-21 指出）。
             */
            <div className="flex h-full items-center justify-center px-2">
              <p className="text-center text-2xs leading-relaxed text-fg-tertiary">
                {/*
                 * ⚠️ 这里**不再重复**「会新建一条对话」——输入框的 placeholder 已经说了。
                 *   同一屏两处说同一件事，是 2026-10-21 截图复查时逮到的（两轮识图都指出）。
                 *   分工：空状态说明「现在能不能发」，placeholder 说明「发了会怎样」。
                 */}
                {!connected ? '还没连上 Harbor' : sessionId ? '在下面输入，发给这条对话' : '在下面输入'}
              </p>
            </div>
          ) : (
            <>
              <TurnBubble turn={turn} />
              {turn.done && sessionId && connected ? <Button size="sm" variant="ghost" disabled={regenerating} onClick={regenerate}>重新生成</Button> : null}
            </>
          )}
        </div>

        {drawerOpen ? (
          <SessionDrawer onClose={onCloseDrawer} selectedId={sessionId} onSelect={onSelectSession} />
        ) : null}

        {/* M02-C：设置抽屉（同一个覆盖层，从左侧滑出；与会话抽屉互不并排） */}
        {settingsOpen ? <SettingsDrawer onClose={onCloseSettings} connected={connected} lastError={lastError} onRetry={onRetry} /> : null}
      </div>

      {/* 状态行：读页面结果 / 发送提示共用一个元素（见文件头） */}
      {status ? (
        <div
          role="status"
          aria-live="polite"
          aria-label="发送提示"
          className={`shrink-0 px-3 pb-1 text-2xs ${status.tone === 'danger' ? 'text-danger' : 'text-fg-tertiary'}`}
        >
          {status.text}
        </div>
      ) : null}

      {/* 输入区（读当前页压成左端一个图标按钮）*/}
      <div className="shrink-0 p-3 pt-1.5">
        <div className="flex items-end gap-1.5 rounded-base border border-line-hairline bg-bg-raised p-2">
          <ReadPageButton onStatus={scopedStatus} sessionId={sessionId} />
          {/* M03：观察页面（结构 / 选区 / 版本号）—— 与「读当前页」是两个动作 */}
          <ObserveButton onStatus={scopedStatus} sessionId={sessionId} />
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => {
              if (drawerOpen) onCloseDrawer()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={sessionId ? '说点什么…' : '说点什么（会新建一条对话）…'}
            aria-label="消息输入框"
            className="max-h-24 min-h-[28px] flex-1 resize-none bg-transparent text-dense text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
          />
          {/* ★ 不再要求「先有会话」：没有会话时发送 = 新建一条（Phase 3c 拍板） */}
          {/* M02-A2：正在跑时给「停止」—— 按 aria-label 找（图标按钮，验收脚本锚点） */}
          {streaming || stopping ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label="停止生成"
              loading={stopping}
              onClick={stop}
            >
              <Square size={14} aria-hidden="true" />
            </Button>
          ) : null}
          <Button size="sm" variant="primary" loading={sending} disabled={!input.trim()} onClick={send}>
            发送
          </Button>
        </div>
        <p className="mt-1.5 text-2xs text-fg-tertiary">
          回复在 Harbor 里跑 · 两端同一条会话
        </p>
      </div>
    </section>
  )
}
