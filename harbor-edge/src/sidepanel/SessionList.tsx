/**
 * 侧边栏的「会话列表」区块（Phase 3a：**只读**）
 *
 * 数据来自 SW 的 `session-list` 消息（→ host → 主进程 `session.list()`）。
 * ⚠️ 本阶段**不做**点击切换会话（那是 3c），也不发消息（3b）—— 纯展示 + 刷新。
 *
 * 冷启动：先读 chrome.storage 的快照（打开即有内容，不等 SW 醒），再异步刷新一次
 * （与 App.tsx 里连接状态的套路一致）。
 */

/* global chrome */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'

export interface SessionSummary {
  id: string
  title: string
  mode?: string
  model?: string
  workdir?: string
  messageCount?: number
  createdAt?: number
  updatedAt?: number
}

interface ListResult {
  ok: boolean
  error?: string
  sessions?: SessionSummary[]
}

/** 相对时间：14 分 / 3 时 / 2 天（只读展示够用，不引日期库） */
function relativeTime(ts?: number): string {
  if (!ts || typeof ts !== 'number') return ''
  const min = Math.floor(Math.max(0, Date.now() - ts) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function SessionList() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** 上一次是不是因为「还没连上 Harbor」失败的 —— 连上后要自动补一次 */
  const retryOnConnect = useRef(false)

  const refresh = useCallback(() => {
    setLoading(true)
    try {
      const p = chrome.runtime.sendMessage({ type: 'session-list' })
      if (!p || typeof p.then !== 'function') {
        setError('扩展上下文不可用')
        setLoading(false)
        return
      }
      p.then((res: ListResult | undefined) => {
        if (res && res.ok === true) {
          setSessions(Array.isArray(res.sessions) ? res.sessions : [])
          setError(null)
          retryOnConnect.current = false
        } else {
          setError((res && res.error) || '拿不到会话列表')
          /* ★ 这条是**真机验收逮到的缺陷**：面板打开时 SW 可能还没连上 host
             （port 未建立）→ 列表请求当场失败，而顶部随后显示「已连接」——
             用户看到的是**自相矛盾**的两块（顶上连上了、下面说没连上），
             且不点「刷新」就永远是错的。所以这里记一笔，等连上后自动补一次。 */
          retryOnConnect.current = true
        }
        setLoading(false)
      }).catch((e: unknown) => {
        setError(String((e as Error)?.message ?? e))
        retryOnConnect.current = true
        setLoading(false)
      })
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      retryOnConnect.current = true
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    /* ① 先拿快照（SW 可能要几百毫秒才醒，不给空白） */
    try {
      chrome.storage.local.get('harborSessions').then((out) => {
        const snap = out && out.harborSessions
        if (snap && Array.isArray(snap.sessions)) setSessions(snap.sessions as SessionSummary[])
      })
    } catch {
      /* 拿不到就用空列表 */
    }
    /* ② 再异步刷新一次最新 */
    refresh()

    /* ③ 连接状态一变「已连接」就把之前那条失败补上（见 refresh 里的说明） */
    const onMsg = (msg: { type?: string; state?: { connected?: boolean } }) => {
      if (msg && msg.type === 'status' && msg.state?.connected && retryOnConnect.current) {
        refresh()
      }
    }
    try {
      chrome.runtime.onMessage.addListener(onMsg)
    } catch {
      /* 不在扩展上下文时忽略 */
    }
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(onMsg)
      } catch {
        /* 忽略 */
      }
    }
  }, [refresh])

  return (
    <section aria-label="Harbor 会话列表" className="flex min-h-0 flex-1 flex-col border-t border-line-hairline">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="text-dense font-medium">Harbor 会话</span>
        <span className="text-2xs text-fg-tertiary">
          {sessions.length > 0 ? `${sessions.length} 条` : ''}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" aria-label="刷新会话列表" loading={loading} onClick={refresh}>
          刷新
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {error ? (
          <div role="status" aria-live="polite" className="text-2xs text-danger">
            {error}
          </div>
        ) : sessions.length === 0 ? (
          <div role="status" aria-live="polite" className="text-2xs text-fg-tertiary">
            还没有会话（在 Harbor 里新建一条，或点上面的「刷新」）
          </div>
        ) : (
          <ul role="list" className="flex flex-col gap-1">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="rounded-base border border-line-hairline bg-bg-raised px-2.5 py-2"
              >
                <div className="truncate text-dense text-fg-primary">{s.title || '（无标题）'}</div>
                <div className="mt-0.5 flex items-center gap-2 text-2xs text-fg-tertiary">
                  <span className="truncate">{s.id}</span>
                  <span className="shrink-0">{relativeTime(s.updatedAt)}</span>
                  {typeof s.messageCount === 'number' ? (
                    <span className="shrink-0">{s.messageCount} 条消息</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
