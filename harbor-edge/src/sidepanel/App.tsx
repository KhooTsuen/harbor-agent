/**
 * Harbor 侧边栏（Phase 3a：会话列表）
 *
 * 四块：
 *   ① 顶部：与 Harbor 的连接状态（已连接 / 未连接 + 一键重试）
 *   ② 「读当前页」按钮 + 读到的结果（字数 / 错误）
 *   ③ 会话列表（Phase 3a，**只读** —— 不点进、不发消息）
 *   ④ 对话（Phase 3b：输入框 + 流式回复，见 ChatPanel.tsx）
 *
 * ── 视觉为什么能跟主应用一致 ────────────────────────────────
 *
 * 不是「照抄一份样式」，是真的走同一套东西：
 *   · Tailwind theme 从主 config **继承**（harbor-edge/postcss.config.js）；
 *   · CSS 变量来自主 `src/index.css` + `src/styles/theme-primer-dark.css`
 *     （见 sidepanel.css 的 @import）；
 *   · 连 `Button` 组件都是直接 import 主应用那份 —— 零新依赖。
 *
 * ── 读页面这条链谁负责哪一段 ────────────────────────────────
 *
 *   侧边栏（这里）：只负责「用户点了」→ 发消息 → 显示结果。
 *   Service Worker：拿活动标签、`chrome.scripting` 读正文、经 native port 送 Harbor。
 *   Harbor：包装（wrapWebText）→ 落进会话 → 审计。**这里不做任何包装**——
 *           防注入的包装是内核的职责，扩展侧自己拼一份就会漂（硬约束 #9）。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SessionList } from './SessionList'
import { ChatPanel } from './ChatPanel'

/* global chrome */

interface HarborState {
  connected: boolean
  lastError: string | null
  lastPongAt: number
  host: string
}

interface PageResult {
  ok: boolean
  error?: string | null
  url?: string
  title?: string
  chars?: number
  truncated?: boolean
  at?: number
}

const INITIAL: HarborState = { connected: false, lastError: null, lastPongAt: 0, host: 'com.harbor.agent' }

/**
 * 连接状态点 —— 为什么不在扩展侧复用主应用的 `StatusDot`：
 * 那个组件依赖 `@/types` + `@/lib/agentPhase` + `@/lib/statusLanguage` 三处，
 * 而且语义是「**线程**执行状态」，跟这里要的「**与 Harbor 的连接**」不是同一件事。
 * 所以按「不能跨目录复用就在扩展侧写一份等价的」办 —— 颜色仍走主应用的 token。
 */
function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span
      role="status"
      aria-label={connected ? '已连接' : '未连接'}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${connected ? 'bg-success' : 'bg-warning'}`}
    />
  )
}

export function App() {
  const [state, setState] = useState<HarborState>(INITIAL)
  const [page, setPage] = useState<PageResult | null>(null)
  const [reading, setReading] = useState(false)

  useEffect(() => {
    /* ① 先拿快照：SW 可能要几百毫秒才醒，不能让界面空着 */
    try {
      chrome.storage.local.get(['harborState', 'harborLastPage']).then((out) => {
        if (out && out.harborState) setState(out.harborState as HarborState)
        if (out && out.harborLastPage) setPage(out.harborLastPage as PageResult)
      })
    } catch {
      /* 拿不到就用默认值 */
    }

    /* ② 订阅 SW 广播 */
    const onMsg = (msg: { type?: string; state?: HarborState }) => {
      if (msg && msg.type === 'status' && msg.state) setState(msg.state)
    }
    try {
      chrome.runtime.onMessage.addListener(onMsg)
    } catch {
      /* 不在扩展上下文（纯浏览器预览）时忽略 */
    }

    /* ③ 主动问一次最新（顺带唤醒 SW） */
    requestStatus()

    return () => {
      try {
        chrome.runtime.onMessage.removeListener(onMsg)
      } catch {
        /* 同上 */
      }
    }
  }, [])

  const requestStatus = useCallback(() => {
    try {
      const p = chrome.runtime.sendMessage({ type: 'get-status' })
      if (p && typeof p.then === 'function') {
        p.then((res: { state?: HarborState } | undefined) => {
          if (res && res.state) setState(res.state)
        }).catch(() => {})
      }
    } catch {
      /* 忽略 */
    }
  }, [])

  const retry = useCallback(() => {
    try {
      const p = chrome.runtime.sendMessage({ type: 'ping' })
      if (p && typeof p.then === 'function') p.catch(() => {})
    } catch {
      /* 忽略 */
    }
    requestStatus()
  }, [requestStatus])

  /** ★ 用户主动点击才读页面 —— 没有任何定时器会自己调这个 */
  const readPage = useCallback(() => {
    setReading(true)
    setPage(null)
    try {
      const p = chrome.runtime.sendMessage({ type: 'read-page' })
      if (!p || typeof p.then !== 'function') {
        setPage({ ok: false, error: '扩展上下文不可用' })
        setReading(false)
        return
      }
      p.then((res: PageResult | undefined) => {
        setPage(res && typeof res === 'object' ? res : { ok: false, error: '没有拿到结果' })
        setReading(false)
      }).catch((error: unknown) => {
        setPage({ ok: false, error: String((error as Error)?.message ?? error) })
        setReading(false)
      })
    } catch (error) {
      setPage({ ok: false, error: String((error as Error)?.message ?? error) })
      setReading(false)
    }
  }, [])

  return (
    <div className="flex h-screen flex-col bg-canvas text-fg-primary">
      {/* ── ① 顶部：连接状态 ─────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line-hairline px-3 py-2.5">
        <ConnectionDot connected={state.connected} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-dense font-medium">
            {state.connected ? '已连接' : '未连接'}
          </div>
          <div className="truncate text-2xs text-fg-tertiary">
            {state.connected ? 'Harbor 正在运行' : (state.lastError ?? '正在连接 Harbor…')}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={retry}>
          重试
        </Button>
      </header>

      {/* ── ② 中间：读当前页 ─────────────────────────────── */}
      <main className="flex shrink-0 flex-col items-center justify-center gap-2 px-5 py-4">
        <Button variant="primary" size="md" loading={reading} onClick={readPage}>
          {reading ? '读取中…' : '读当前页'}
        </Button>

        {/* 结果反馈：成功报字数，失败报人话原因（都在这个元素里，便于脚本读回） */}
        <div
          role="status"
          aria-live="polite"
          className="min-h-[34px] text-center text-2xs text-fg-tertiary"
        >
          {page?.ok ? (
            <>
              <div className="text-dense text-fg-primary">已读取 {page.chars ?? 0} 字</div>
              <div className="mt-0.5 truncate">
                {page.title || page.url}
                {page.truncated ? '（正文过长，已截断）' : ''}
              </div>
              <div className="mt-0.5">已发送给 Harbor，会存进当前会话</div>
            </>
          ) : page && page.error ? (
            <div className="text-dense text-danger">{page.error}</div>
          ) : (
            <div>读取当前标签页的正文，送进 Harbor</div>
          )}
        </div>
      </main>

      {/* ── ③ 会话列表（只读，Phase 3a）───────────────────── */}
      <SessionList />

      {/* ── ④ 对话（Phase 3b：发消息 + 流式回复）──────────── */}
      <ChatPanel connected={state.connected} />
    </div>
  )
}

export default App
