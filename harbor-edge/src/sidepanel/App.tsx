/**
 * Harbor 侧边栏（Phase 1c 第二步：骨架 + 连接状态）
 *
 * 本步**故意不做对话**（那是 Phase 3）。这里只有三块：
 *   ① 顶部：与 Harbor 的连接状态（已连接 / 未连接 + 一键重试）
 *   ② 中间：占位说明
 *   ③ 底部：输入框占位（**不能真发**）
 *
 * ── 视觉为什么能跟主应用一致 ────────────────────────────────
 *
 * 不是「照抄一份样式」，是真的走同一套东西：
 *   · Tailwind theme 从主 config **继承**（harbor-edge/postcss.config.js）；
 *   · CSS 变量来自主 `src/index.css` + `src/styles/theme-primer-dark.css`
 *     （见 sidepanel.css 的 @import）；
 *   · 连 `Button` 组件都是直接 import 主应用那份 —— 零新依赖，
 *     它用的 `bg-cta` / `rounded` / `duration-fast` 全在 theme 里。
 *
 * ── 连接状态怎么来 ──────────────────────────────────────────
 *
 * Service Worker 才是持 native port 的那个（见 extension/service-worker.js）。
 * 这里只做两件事：先读 chrome.storage 的快照（打开即有内容，不用等 SW 醒），
 * 再 `sendMessage` 要一次最新状态，并订阅后续变化。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'

/* global chrome */

interface HarborState {
  connected: boolean
  lastError: string | null
  lastPongAt: number
  host: string
}

const INITIAL: HarborState = { connected: false, lastError: null, lastPongAt: 0, host: 'com.harbor.agent' }

/**
 * 连接状态点 —— 为什么不在扩展侧复用主应用的 `StatusDot`：
 * 那个组件依赖 `@/types` + `@/lib/agentPhase` + `@/lib/statusLanguage` 三处，
 * 而且语义是「**线程**执行状态」（执行中 / 已完成 / 失败…），
 * 跟这里要的「**与 Harbor 的连接**通没通」不是同一件事。
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

  useEffect(() => {
    /* ① 先拿快照：SW 可能要几百毫秒才醒，不能让界面空着 */
    try {
      chrome.storage.local.get('harborState').then((out) => {
        if (out && out.harborState) setState(out.harborState as HarborState)
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

      {/* ── ② 中间：占位 ─────────────────────────────────── */}
      <main className="flex flex-1 items-center justify-center px-6">
        <div className="text-center">
          <h1 className="text-title font-semibold">Harbor</h1>
          <p className="mt-2 text-meta text-fg-secondary">浏览器伴侣</p>
          <p className="mt-3 text-2xs text-fg-tertiary">
            侧边栏骨架（Phase 1c 第二步）
            <br />
            读页面与对话将在后续阶段接入
          </p>
        </div>
      </main>

      {/* ── ③ 底部：输入框占位（本步**不能真发**）─────────── */}
      <footer className="shrink-0 border-t border-line-hairline p-3">
        <div className="flex items-end gap-2 rounded-base border border-line-hairline bg-bg-raised p-2">
          <textarea
            rows={1}
            disabled
            placeholder="对话功能开发中（Phase 3）"
            aria-label="输入框（占位）"
            className="max-h-24 min-h-[28px] flex-1 resize-none bg-transparent text-dense text-fg-primary placeholder:text-fg-tertiary focus:outline-none disabled:cursor-not-allowed"
          />
          <Button size="sm" variant="primary" disabled>
            发送
          </Button>
        </div>
      </footer>
    </div>
  )
}

export default App
