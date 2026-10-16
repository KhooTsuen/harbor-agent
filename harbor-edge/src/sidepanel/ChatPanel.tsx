/**
 * 侧边栏的「对话」区块（发消息 + 看流式回复）
 *
 * 做：把用户打的字交给 SW（→ host → 主进程 → **渲染层**去跑），并把主进程推来的
 *     流式分片显示出来；点顶栏 **☰** 时把会话抽屉滑出来**覆盖**这一块。
 * 不做：**不落盘、不判忙**。落盘在渲染层（`replyPersistence.ts`）；「忙不忙」
 *     由主进程判（`electron/core/ext-chat.cjs`）—— 判据只有一处，扩展侧不自己猜。
 * 一轮的显示（含 Markdown）在 `TurnBubble.tsx`（本文件贴 300 红线，拆出去）。
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ReadPageButton, type StatusMessage } from './ReadPageButton'
import { ObserveButton } from './ObserveButton'
import { SessionDrawer } from './SessionDrawer'
/* M02-A：一轮的显示 + Markdown 搬到 TurnBubble（本文件贴 300 红线） */
import { TurnBubble, type TurnView } from './TurnBubble'

/** 主进程推来的分片（形状见 `electron/core/ext-protocol.cjs` 的 push） */
interface PushPayload {
  sessionId?: string
  seq?: number
  type?: string
  text?: string
  done?: boolean
}

export function ChatPanel({
  connected,
  sessionId,
  drawerOpen,
  onCloseDrawer,
  onSelectSession,
  status,
  onStatus,
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
}) {
  const [input, setInput] = useState('')
  const [turn, setTurn] = useState<TurnView | null>(null)
  const [sending, setSending] = useState(false)
  /** M02-A2：正在等「停止」的回执（防连点） */
  const [stopping, setStopping] = useState(false)
  /** 当前在看的会话 —— 存 ref，避免闭包里拿到过期的值 */
  const sidRef = useRef(sessionId)
  sidRef.current = sessionId

  /* 订阅流式推送（只认 chat:event；session:selected 归 App 处理） */
  useEffect(() => {
    const onMsg = (msg: { type?: string; push?: { kind?: string; payload?: PushPayload } }) => {
      if (!msg || msg.type !== 'harbor-push') return
      if (msg.push?.kind !== 'chat:event') return
      const payload = msg.push?.payload
      if (!payload) return
      const incoming = String(payload.sessionId ?? '')
      /*
       * ★ 只认「我正在看的那条会话」—— 但**要能跟着换 id**（真机踩过）：
       * 刚新建的会话在渲染层那边先是**临时 id**（`pending_…`），主进程推来的是
       * 落盘后的真 id —— 严格匹配会把每一片都丢掉（现象：侧边栏只有一个光标，
       * 主窗口却有完整回复）。所以本地还是 `pending_`／空时，以推送为准学过来。
       */
      if (incoming && incoming !== sidRef.current) {
        const temp = !sidRef.current || sidRef.current.startsWith('pending_')
        if (!temp) return
        sidRef.current = incoming
      }
      const seq = Number(payload.seq ?? 0)
      const type = String(payload.type ?? '')
      setTurn((prev) => {
        if (!prev) return prev
        if (seq && seq <= prev.seq) return prev /* 旧片 / 重排 —— 丢掉 */
        const next: TurnView = { ...prev, seq: seq || prev.seq }
        if (type === 'content' && typeof payload.text === 'string') next.text += payload.text
        if (type === 'done' || type === 'aborted') {
          next.done = true
          /* done 那片带**全文** —— 用它覆盖，把可能丢掉的片补回来 */
          if (typeof payload.text === 'string' && payload.text) next.text = payload.text
        }
        if (type === 'error') {
          next.done = true
          next.error = String(payload.text ?? '出错了')
        }
        return next
      })
    }
    try {
      chrome.runtime.onMessage.addListener(onMsg)
    } catch {
      /* 不在扩展上下文（纯浏览器预览）时忽略 */
    }
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(onMsg)
      } catch {
        /* 同上 */
      }
    }
  }, [])

  /*
   * 打开 / 换会话时问一次快照：SW 可能刚醒、或者回复在我们没看时就开始跑了。
   * 拿到就用它初始化（**不覆盖**已经在显示的那条 —— 快照只在没有本地内容时用）。
   */
  useEffect(() => {
    if (!sessionId) return
    try {
      const p = chrome.runtime.sendMessage({ type: 'chat-resume', sessionId })
      if (!p || typeof p.then !== 'function') return
      p.then((res: { ok?: boolean; seq?: number; text?: string; done?: boolean } | undefined) => {
        if (!res || res.ok !== true) return
        setTurn((prev) => {
          if (prev) return prev
          return { ask: '', text: String(res.text ?? ''), seq: Number(res.seq ?? 0), done: res.done === true }
        })
      }).catch(() => {})
    } catch {
      /* 忽略 */
    }
  }, [sessionId])

  /* 有回复正在流吗（组件作用域：发送 / 停止按钮 / 停止本身三处共用）。
     ⚠️ 原先它是 `send` 里的局部 const 却被 JSX 用了 → 真机**整页白屏**
     （ReferenceError: streaming is not defined）—— 那种错只有真机跑才现形。 */
  const streaming = Boolean(turn && !turn.done)

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    onStatus(null)
    /* ★ 正在流时**不要**换掉显示：否则「忙时又发一条」会把正在看的流清空（真机逮到） */
    if (!streaming) setTurn({ ask: text, text: '', seq: 0, done: false })
    try {
      const p = chrome.runtime.sendMessage({ type: 'chat-send', text, sessionId })
      if (!p || typeof p.then !== 'function') {
        onStatus({ text: '扩展上下文不可用', tone: 'danger' })
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
        onStatus({ text: String(res?.error ?? '发不出去'), tone: 'danger' })
        if (!streaming) setTurn(null)
      }).catch((error: unknown) => {
        setSending(false)
        onStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
        if (!streaming) setTurn(null)
      })
    } catch (error) {
      setSending(false)
      onStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
    }
  }, [input, sending, turn, sessionId, onStatus])

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
        onStatus({
          text: res && res.ok === true ? '已请求停止 —— 这条对话正在收尾' : String(res?.error ?? '停不了'),
          tone: res && res.ok === true ? 'info' : 'danger',
        })
      }).catch((error: unknown) => {
        setStopping(false)
        onStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
      })
    } catch (error) {
      setStopping(false)
      onStatus({ text: String((error as Error)?.message ?? error), tone: 'danger' })
    }
  }, [onStatus])

  return (
    <section aria-label="对话" className="flex min-h-0 flex-1 flex-col">
      {/* 消息区 + 抽屉：抽屉是 absolute 覆盖，**不是**并排（400px 宽容不下并排）*/}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div aria-label="消息流" className="h-full overflow-y-auto px-3 py-2 text-dense">
          {!turn ? (
            <div className="text-2xs text-fg-tertiary">
              {!connected
                ? '还没连上 Harbor'
                : sessionId
                  ? '在下面输入，发给这条对话'
                  : '在下面输入 —— 会新建一条对话'}
            </div>
          ) : (
            <TurnBubble turn={turn} />
          )}
        </div>

        {drawerOpen ? (
          <SessionDrawer onClose={onCloseDrawer} selectedId={sessionId} onSelect={onSelectSession} />
        ) : null}
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
          <ReadPageButton onStatus={onStatus} />
          {/* M03：观察页面（结构 / 选区 / 版本号）—— 与「读当前页」是两个动作 */}
          <ObserveButton onStatus={onStatus} />
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => {
              if (drawerOpen) onCloseDrawer()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
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
        <p className="mt-2 text-2xs text-fg-tertiary">
          回复由 Harbor 跑，两处看到的是**同一条**会话。
        </p>
      </div>
    </section>
  )
}
