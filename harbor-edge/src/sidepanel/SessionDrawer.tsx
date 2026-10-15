/**
 * 会话抽屉（Phase 3b 布局返工）
 *
 * ── 它取代了什么 ─────────────────────────────────────────────
 *
 * 原来会话列表是**常驻**的一个区块（`SessionList.tsx`，已删）。侧边栏只有 ~400px
 * 宽，常驻列表把对话区压到只剩几条消息 —— 用户 2026-10-16 指出这是理解偏差。
 * 现在改成「点顶栏标题旁的 ▾ 才挂载」的抽屉：从上方滑下来**覆盖对话区**
 * （不是并排），选完 / 点 ✕ / 按 Esc 收起。
 *
 * ── 数据从哪来（与原来一模一样）──────────────────────────────
 *
 * SW 的 `session-list`（→ host → 主进程 `session.list()`）。
 * 冷启动先读 `chrome.storage.local.harborSessions` 快照（打开即有内容，不等 SW 醒），
 * 再异步刷新一次。
 *
 * ⚠️ `aria-label="Harbor 会话列表"` 是**验收脚本的锚点**
 *   （`lib/ext-probe.cjs` 的 `SESSION_LIST_EXPR` 按它找元素）。改名必须同步改那边，
 *   否则脚本**静默失效**（照跑不误、却读不到东西）—— 与 `tools/shot/cards.mjs`
 *   那条规矩同源。
 *
 * ⚠️ 本阶段**不做**点击切换会话（那是 3c）：列表项现在只展示，点击没有动作。
 *   （自检 158 也钉着「侧边栏还没做切会话」。）
 */

/* global chrome */

import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'

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

/** 相对时间：刚刚 / 14 分前 / 3 时前 / 2 天前（只读展示够用，不引日期库） */
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

export function SessionDrawer({ onClose }: { onClose: () => void }) {
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
          /*
           * ★ 这条是 3a 真机逮到的缺陷（搬过来时保留）：抽屉刚打开时 SW 可能还没
           *   连上 host（port 未建立）→ 请求当场失败，而顶栏随后显示「已连接」——
           *   用户看到自相矛盾的两块，且不点「刷新」就永远是错的。
           */
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
    /* ② 再异步刷新一次最新（挂载 = 用户刚点开抽屉） */
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

    /* ④ Esc 收起 —— 抽屉是浮层，键盘要能退出 */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    try {
      document.addEventListener('keydown', onKey)
    } catch {
      /* 忽略 */
    }

    return () => {
      try {
        chrome.runtime.onMessage.removeListener(onMsg)
      } catch {
        /* 忽略 */
      }
      try {
        document.removeEventListener('keydown', onKey)
      } catch {
        /* 忽略 */
      }
    }
  }, [refresh, onClose])

  return (
    <div
      role="dialog"
      aria-label="选择对话"
      /* drawer-in：从上方滑下（见 sidepanel.css；防闪烁开关会关掉它） */
      className="drawer-in absolute inset-0 flex flex-col border-b border-line-hairline bg-canvas"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line-hairline px-3 py-2">
        <span className="text-dense font-medium">选择对话</span>
        <span className="text-2xs text-fg-tertiary">
          {sessions.length > 0 ? `${sessions.length} 条` : ''}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" aria-label="刷新会话列表" loading={loading} onClick={refresh}>
          刷新
        </Button>
        <IconButton label="收起会话列表" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>

      {/* ★ aria-label 是验收脚本的锚点（见文件头）—— 它必须包着那些 li */}
      <div aria-label="Harbor 会话列表" className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? (
          /* ⚠️ 用 `role=alert` 而不是 `role=status aria-live=polite`：后者是
             ext-probe 的 `STATUS_TEXT_EXPR` 锚点（它取文档里**第一个**）——
             抽屉里再来一个就会把状态行那份顶掉（真机判据会读到错的元素）。 */
          <div role="alert" className="text-2xs text-danger">
            {error}
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-2xs text-fg-tertiary">
            还没有会话（在 Harbor 里新建一条，或点上面的「刷新」）
          </div>
        ) : (
          /*
           * 点选切换是 3c 的活（本轮只展示）—— 所以这里是 li 而不是 button：
           * 做成可点的样子却点了没反应，比先不可点更糟。
           */
          <ul role="list" className="flex flex-col gap-1">
            {sessions.map((s) => (
              <li key={s.id} className="rounded-base border border-line-hairline bg-bg-raised px-2.5 py-2">
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
    </div>
  )
}
