/**
 * M02-B：**这一轮的推送状态**（流式正文 + 任务卡状态）—— 从 `ChatPanel` 拆出来
 *
 * ── 为什么拆 ───────────────────────────────────────────────────
 *
 * `ChatPanel.tsx` 2026-10-20 已经 299 行（≤300 硬约束），而 M02-B 还要往里加
 * 当前网页卡 + 任务卡。这块「订阅 chat:event → 累加两份状态（正文 / 任务）」
 * 是整块能搬走的东西：它只管**被动接收**，与发送 / 停止那些副作用无关。
 *
 * ── 两条状态，一个订阅 ─────────────────────────────────────────
 *
 * 同一批 `chat:event` 喂给两个累加器：
 *   · `turn`      —— 正文（content 增量 / done 带全文 / aborted / error）→ `TurnBubble`
 *   · `task`      —— 任务卡（相位 / 工具 / 待确认）→ `TaskCard`
 * 判定逻辑都在纯函数里（`TurnBubble` 的 `TurnView` 形状 + `task-state.ts`），
 * 这里只负责「收事件、调函数、setState」。
 *
 * ── 为什么 sidRef 在这里 ───────────────────────────────────────
 *
 * 它原来在 `ChatPanel` 里，服务于两件事：① 过滤「不是我在看的会话」的推送；
 * ② `stop()` 要拿「此刻」的会话 id（闭包里会过期）。两件事都发生在**收事件**
 * 与**停这一轮**上，属于同一套状态，所以一起搬过来、由 hook 返回给组件用。
 */

/* global chrome */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TurnView } from './TurnBubble'
import { emptyTask, nextTaskState, type TaskState } from './task-state'

/** 主进程推来的分片（形状见 `electron/core/ext-protocol.cjs` 的 push） */
interface PushPayload {
  sessionId?: string
  requestId?: string
  seq?: number
  type?: string
  text?: string
  done?: boolean
  [k: string]: unknown
}

interface SessionView { turn: TurnView | null; task: TaskState; requestId: string }

/**
 * @param {string} sessionId 侧边栏**自己**在看的那条（空串 = 还没选）
 * @returns 正文、任务卡状态、以及「此刻的会话 id」的 ref
 */
export function useChatStream(sessionId: string) {
  const [views, setViews] = useState<Record<string, SessionView>>({})
  const sidRef = useRef(sessionId)
  sidRef.current = sessionId
  const turn = views[sessionId]?.turn ?? null
  const task = views[sessionId]?.task ?? emptyTask()
  const setTurn = useCallback((change: TurnView | null | ((prev: TurnView | null) => TurnView | null)) => {
    const owner = sessionId
    setViews((all) => {
      const current = all[owner] ?? { turn: null, task: emptyTask(), requestId: '' }
      const next = typeof change === 'function' ? change(current.turn) : change
      return { ...all, [owner]: { ...current, turn: next } }
    })
  }, [sessionId])

  /** 当前在看的会话 —— 存 ref，避免闭包里拿到过期的值 */

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
      if (!incoming || incoming !== sidRef.current) return

      /* 任务卡：同一批事件喂给纯函数（它认不出的事件会原样返回同一个对象） */
      const seq = Number(payload.seq ?? 0)
      const type = String(payload.type ?? '')
      setViews((all) => {
        const current = all[incoming] ?? { turn: null, task: emptyTask(), requestId: '' }
        const requestId = String(payload.requestId ?? '')
        const fresh = Boolean(requestId && current.requestId && current.requestId !== requestId)
        const base = fresh ? null : current.turn
        const prev = base ?? (['content', 'done', 'aborted', 'error'].includes(type)
          ? { ask: '', text: '', seq: 0, done: false }
          : null)
        let next = prev
        if (prev && (!seq || seq > prev.seq)) {
          next = { ...prev, seq: seq || prev.seq }
          if (type === 'content' && typeof payload.text === 'string') next.text += payload.text
          /*
           * ★ 2026-10-21 重试：主进程已经把本轮正文退回到重试前的位置，并推来**全文**。
           *   这里必须**覆盖**，不能追加 —— 追加就等于「上一次尝试 + 这一次尝试」两遍。
           *   （为什么只有侧栏需要这一步：主窗口收尾时有 `reconcileFinalRounds` 合并。）
           */
          if (type === 'retry') next.text = String(payload.text ?? '')
          if (type === 'done' || type === 'aborted') {
            next.done = true
            if (typeof payload.text === 'string' && payload.text) next.text = payload.text
          }
          if (type === 'error') {
            next.done = true
            next.error = String(payload.text ?? '出错了')
          }
        }
        return { ...all, [incoming]: { turn: next, task: nextTaskState(fresh ? emptyTask() : current.task, payload), requestId: requestId || current.requestId } }
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
      p.then((res: { ok?: boolean; requestId?: string; seq?: number; text?: string; done?: boolean } | undefined) => {
        if (!res || res.ok !== true) return
        setViews((all) => {
          const current = all[sessionId] ?? { turn: null, task: emptyTask(), requestId: '' }
          const seq = Number(res.seq ?? 0)
          const requestId = String(res.requestId ?? '')
          if (current.requestId === requestId && current.turn && current.turn.seq >= seq) return all
          return { ...all, [sessionId]: {
            ...current,
            requestId: requestId || current.requestId,
            turn: { ask: current.turn?.ask ?? '', text: String(res.text ?? ''), seq, done: res.done === true },
          } }
        })
      }).catch(() => {})
    } catch {
      /* 忽略 */
    }
  }, [sessionId])

  return { turn, setTurn, task, sidRef }
}
