/**
 * 侧边栏读取**这条会话的历史消息**（2026-11-03）
 *
 * ── 为什么要它 ─────────────────────────────────────────────────
 *
 * 以前侧边栏只有「当前这一轮」：靠 SW 广播的 `chat:event` 累加（`useChatStream`）。
 * 打开面板、切到另一条会话时，之前说过什么**完全看不到** —— 主窗口有整条会话，
 * 侧边栏只有最后一轮，用户说的「分裂感」主要就是这一条。
 *
 * 现在的主进程多了一条只读请求（`session-messages` → `core/ext-session-messages.cjs`），
 * 这里只管「什么时候问、结果放哪、失败怎么不打扰人」。
 *
 * ── 什么时候重读（三条，缺一条就会显示旧内容）──────────────────
 *
 *   ① **挂载 / 换会话**：`sessionId` 变了必须重读，否则会显示上一条会话的消息。
 *   ② **连接好了之后**：冷启动时 SW 可能还没醒（`chrome.runtime.sendMessage` 会
 *      失败或超时）—— `connected` 从 false 变 true 就是「通道通了」，补读一次。
 *   ③ **一轮跑完**（`tick` 变）+ **发送成功后**：新消息刚落了盘，重读才看得见；
 *      并且晚 `SETTLE_MS` 再补读一次（收尾那条是异步落盘的，见 ③ 的注释）。
 *      `tick` 由调用方数（`useChatStream` 的 `done` 次数）—— 本 hook 不猜事件形状。
 *
 * ── 失败为什么不弹红字 ────────────────────────────────────────
 *
 * 通道断 / 冷启动竞态是**常态**，不是用户的操作失败。这里只记 `error` 供界面
 * 在空列表时说一句「这条对话没读到」，红字留给真正由用户动作触发的失败
 * （发送 / 停止 / 读页面那些，仍走 `onStatus`）。
 */

/* global chrome */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SideMessage } from './mergeMessages'

/** 一轮跑完后**补读**的延迟（毫秒）—— 见 ③ 里那段注释 */
const SETTLE_MS = 900

interface HistoryReply {
  ok?: boolean
  error?: string
  messages?: SideMessage[]
  total?: number
  dropped?: number
  truncated?: boolean
}

/** 重读时机（hook 的入参） */
export interface HistoryDeps {
  /** 侧边栏自己选中的那条（空串 = 还没选，此时不读） */
  sessionId: string
  /** 与 Harbor 的通道是否已连上 —— 连上才有必要问（见文件头②） */
  connected: boolean
  /** 轮次变化计数：每跑完一轮 +1（由调用方数，见文件头③） */
  tick: number
  /** 发送成功也 +1（那一问刚落盘/正在跑，历史要跟着更新） */
  sentTick: number
}

export interface HistoryState {
  messages: SideMessage[]
  /** 被丢掉多少条（内核回的，界面据此说「还有 N 条没显示」） */
  dropped: number
  /** 正在读（第一次读时界面画骨架，之后静默刷新） */
  loading: boolean
  /** 上一次读失败的原因（空 = 没失败） */
  error: string
  /** 手动重读（比如用户点「重试」） */
  refresh: () => void
}

/**
 * @param deps 见 `HistoryDeps`
 */
export function useSessionHistory({ sessionId, connected, tick, sentTick }: HistoryDeps): HistoryState {
  const [messages, setMessages] = useState<SideMessage[]>([])
  const [dropped, setDropped] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [manual, setManual] = useState(0)

  /**
   * 会话切换的**代次**：请求回来时如果已经不是同一个会话了，结果就丢掉。
   * 不判的话「切到 B 后 A 的响应才回来」会把 A 的消息显示在 B 下面（真机很容易撞）。
   */
  const generation = useRef(0)

  /** 此刻看的是哪条 —— ②③ 不想因为换会话就重跑一次（换会话归 ① 管） */
  const targetRef = useRef(sessionId)
  targetRef.current = sessionId

  const read = useCallback((target: string, gen: number) => {
    if (!target) return
    setLoading(true)
    let called = false
    try {
      const p = chrome.runtime.sendMessage({ type: 'session-messages', sessionId: target })
      if (!p || typeof p.then !== 'function') {
        setLoading(false)
        setError('扩展通道不可用')
        return
      }
      called = true
      p.then((res: HistoryReply | undefined) => {
        if (generation.current !== gen) return
        setLoading(false)
        if (res && res.ok === true) {
          setMessages(Array.isArray(res.messages) ? (res.messages as SideMessage[]) : [])
          setDropped(Number(res.dropped ?? 0))
          setError('')
          return
        }
        /* 失败**不清空**已有内容：读到过一次之后，刷新失败不该让界面突然变空 */
        setError(String(res?.error ?? '没有读到这条对话的消息'))
      }).catch((e: unknown) => {
        if (generation.current !== gen) return
        setLoading(false)
        setError(String((e as Error)?.message ?? e))
      })
    } catch (e) {
      setLoading(false)
      setError(String((e as Error)?.message ?? e))
    } finally {
      if (!called && target) setLoading(false)
    }
  }, [])

  /* ① 挂载 / 换会话：换会话要**先清空**（否则新会话下面会挂着旧的几条） */
  useEffect(() => {
    generation.current += 1
    const gen = generation.current
    setMessages([])
    setDropped(0)
    setError('')
    if (!sessionId) {
      setLoading(false)
      return
    }
    read(sessionId, gen)
  }, [sessionId, read])

  /* ② 通道连上（含冷启动后第一次连上）→ 补读一次 */
  useEffect(() => {
    if (!connected) return
    const target = targetRef.current
    if (!target) return
    read(target, generation.current)
  }, [connected, read])

  /*
   * ③ 一轮跑完 / 发送成功 → 立刻读，**再晚一点补读一次**。
   *
   * ★ 为什么要补那一次（2026-11-03 真机）：流式落盘是分段追加的（`partial: true`），
   *   收尾那条是**异步**写的。`done` 那一刻立刻重读，磁盘上常常还是半截快照
   *   （`collapseByKey` 会给它标 `interrupted`）—— 于是侧边栏说「这条回复没写完」，
   *   切回主窗口却是完整的。晚 SETTLE_MS 再读一次，收尾那条就落盘了。
   */
  useEffect(() => {
    if (!connected || (!tick && !sentTick)) return
    const target = targetRef.current
    if (!target) return
    const gen = generation.current
    read(target, gen)
    const timer = setTimeout(() => {
      if (generation.current === gen) read(target, gen)
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [connected, tick, sentTick, read])

  /* 手动重读：代次不变（还是同一条会话），只是再问一次 */
  useEffect(() => {
    if (!manual) return
    read(sessionId, generation.current)
  }, [manual, sessionId, read])

  const refresh = useCallback(() => setManual((n) => n + 1), [])

  return { messages, dropped, loading, error, refresh }
}
