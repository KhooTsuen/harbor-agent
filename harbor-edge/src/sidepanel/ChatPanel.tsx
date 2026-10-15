/**
 * 侧边栏的「对话」区块（Phase 3b：发消息 + 看流式回复）
 *
 * ── 它做什么 / 不做什么 ──────────────────────────────────────
 *
 * 做：把用户打的字交给 SW（→ host → 主进程 → **渲染层**去跑），并把主进程推来的
 *     流式分片显示出来。
 * 不做：**不落盘、不判忙**。落盘在渲染层（`replyPersistence.ts`）；「这条会话忙不忙」
 *     由主进程判（见 `electron/core/ext-chat.cjs`）—— 判据只有一处，扩展侧不自己猜。
 *
 * ── 流事件从哪来 ─────────────────────────────────────────────
 *
 * SW 广播 `{type:'harbor-push', push:{kind:'chat:event', payload:{…}}}`。
 * payload 字段（3b 钉死）：`sessionId` / `seq` / `type` / `text` / `done`。
 * `seq` 是**单调序号** —— 只认比手上更大的（网络/广播重排时不会把旧片盖上去）。
 *
 * ── 冷启动 / 重连 ────────────────────────────────────────────
 *
 * 打开面板时问一次 `chat-resume`（按 sessionId）拿**一份快照**（当前全文 + seq），
 * 而不是让主进程补发历史分片 —— 理由见 3b 设计说明 §3.2。
 */

/* global chrome */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'

/** 正在显示的一轮（一次提问 + 它的回答） */
interface TurnView {
  /** 用户发的那句 */
  ask: string
  /** 回答正文（流式累加） */
  text: string
  /** 已收到的最大 seq（只认更大的，防重排） */
  seq: number
  done: boolean
  error?: string | null
}

/** 主进程推来的分片（形状见 electron/core/ext-protocol.cjs 的 push） */
interface PushPayload {
  sessionId?: string
  seq?: number
  type?: string
  text?: string
  done?: boolean
}

export function ChatPanel({ connected }: { connected: boolean }) {
  const [input, setInput] = useState('')
  const [turn, setTurn] = useState<TurnView | null>(null)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** Harbor 界面当前打开的那条会话 —— 落点由**主进程**认定，这里只问不猜 */
  const [sessionId, setSessionId] = useState('')
  /** 当前在看的会话 —— 存 ref，避免闭包里拿到过期的值 */
  const sidRef = useRef(sessionId)
  sidRef.current = sessionId

  /** 问一次「当前打开的是哪条会话」（唤醒 SW；连上后就问得到） */
  const refreshSession = useCallback(() => {
    try {
      const p = chrome.runtime.sendMessage({ type: 'session-active' })
      if (!p || typeof p.then !== 'function') return
      p.then((res: { ok?: boolean; sessionId?: string } | undefined) => {
        if (res && res.ok === true) setSessionId(String(res.sessionId ?? ''))
      }).catch(() => {})
    } catch {
      /* 不在扩展上下文时忽略 */
    }
  }, [])

  /* 连上时问一次（没连上问也白问） */
  useEffect(() => {
    if (connected) refreshSession()
  }, [connected, refreshSession])

  /* 订阅流式推送 */
  useEffect(() => {
    const onMsg = (msg: { type?: string; push?: { kind?: string; payload?: PushPayload } }) => {
      if (!msg || msg.type !== 'harbor-push') return
      const payload = msg.push?.payload
      if (!payload) return
      const incoming = String(payload.sessionId ?? '')
      /*
       * ★ 只认「我正在看的那条会话」—— 但**要能跟着主进程换 id**。
       *
       * 踩到的坑（真机）：主窗口刚点「新建对话」时，`session:active` 给的是
       * **临时 id**（`pending_…`），而真正落盘那条是渲染层随后创建的 `sess_…`。
       * 主进程推来的 `sessionId` 是**真的那个** —— 严格匹配会把每一片都丢掉
       * （现象：侧边栏一直只有一个光标，主窗口却有完整回复）。
       * 所以：本地还是 `pending_`／空时，**以推送为准学过来**。
       */
      if (incoming && incoming !== sidRef.current) {
        const temp = !sidRef.current || sidRef.current.startsWith('pending_')
        if (!temp) return
        setSessionId(incoming)
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
          /* done 那片带**全文**（主进程给的）—— 用它覆盖，把可能丢掉的片补回来 */
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

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setNotice(null)
    /*
     * ★ 有回复正在流的时候**不要**把显示换掉：否则「忙时又发一条」会把自己
     *   正在看的流清空（真机验收逮到：⑩ 判完 SESSION_BUSY，⑨⑪ 就再也收不到字了）。
     *   这时只发请求，让主进程回 SESSION_BUSY 就行 —— 显示保持原样。
     */
    const streaming = Boolean(turn && !turn.done)
    if (!streaming) setTurn({ ask: text, text: '', seq: 0, done: false })
    try {
      const p = chrome.runtime.sendMessage({ type: 'chat-send', text })
      if (!p || typeof p.then !== 'function') {
        setNotice('扩展上下文不可用')
        setSending(false)
        return
      }
      p.then((res: { ok?: boolean; error?: string } | undefined) => {
        setSending(false)
        if (res && res.ok === true) {
          setInput('')
          /* 主进程认的当前会话可能与本地缓存不同 —— 顺手对齐 */
          refreshSession()
          return
        }
        /* 被拒（忙 / 没窗口 / 没会话）—— 显示**主进程给的原话**，不自己编 */
        setNotice(String(res?.error ?? '发不出去'))
        if (!streaming) setTurn(null)
      }).catch((error: unknown) => {
        setSending(false)
        setNotice(String((error as Error)?.message ?? error))
        if (!streaming) setTurn(null)
      })
    } catch (error) {
      setSending(false)
      setNotice(String((error as Error)?.message ?? error))
    }
  }, [input, sending, turn, refreshSession])

  return (
    <section aria-label="对话" className="flex min-h-0 flex-1 flex-col border-t border-line-hairline">
      <div className="shrink-0 px-3 pt-2.5 text-2xs text-fg-tertiary">对话</div>

      {/* 消息流（可滚动）*/}
      <div aria-label="消息流" className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-dense">
        {!turn ? (
          <div className="text-2xs text-fg-tertiary">
            {sessionId ? '在下面输入，发给 Harbor 当前打开的这条对话' : '先在 Harbor 里打开一条对话'}
          </div>
        ) : (
          <>
            {turn.ask ? (
              <div className="mb-2 rounded-base bg-bg-raised px-2 py-1.5 text-fg-secondary">{turn.ask}</div>
            ) : null}
            <div className="whitespace-pre-wrap text-fg-primary" aria-label="回复正文">
              {turn.text}
              {!turn.done && !turn.error ? <span className="text-fg-tertiary">▍</span> : null}
            </div>
            {turn.error ? (
              <div aria-label="回复错误" className="mt-1 text-2xs text-danger">
                {turn.error}
              </div>
            ) : null}
            {turn.done && !turn.error ? (
              <div className="mt-1 text-2xs text-fg-tertiary">已完成（同一条也在 Harbor 主窗口里）</div>
            ) : null}
          </>
        )}
      </div>

      {notice ? (
        <div role="status" aria-label="发送提示" className="shrink-0 px-3 pb-1 text-2xs text-danger">
          {notice}
        </div>
      ) : null}

      {/* 输入区 */}
      <div className="shrink-0 p-3 pt-1.5">
        <div className="flex items-end gap-2 rounded-base border border-line-hairline bg-bg-raised p-2">
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={sessionId ? '说点什么…' : '先在 Harbor 里打开一条对话'}
            aria-label="消息输入框"
            className="max-h-24 min-h-[28px] flex-1 resize-none bg-transparent text-dense text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
          />
          <Button size="sm" variant="primary" loading={sending} disabled={!sessionId || !input.trim()} onClick={send}>
            发送
          </Button>
        </div>
        <p className="mt-2 text-2xs text-fg-tertiary">
          回复由 Harbor 主窗口那条对话产生，两处看到的是**同一条**。
        </p>
      </div>
    </section>
  )
}
