/**
 * Harbor 侧边栏（Phase 3b 布局返工 v2：顶栏三区 + 对话区 + 输入框 + 会话抽屉）
 *
 * ── 形态（用户 2026-10-16 定的）──────────────────────────────
 *
 *   ┌──────────────────────────────────────┐
 *   │ ☰   ● 已连接 · 当前对话名      ＋  ⚙ │ ← 顶栏（一行三区）
 *   ├──────────────────────────────────────┤
 *   │            对话区（占满）             │
 *   │   （点 ☰ 时抽屉从**左侧**滑进来覆盖） │
 *   ├──────────────────────────────────────┤
 *   │ 📄 [ 输入框                ]  发送    │ ← 输入框（底部）
 *   └──────────────────────────────────────┘
 *
 * 顶栏三区各自的职责：
 *   · 左 **☰** —— 会话列表抽屉的开关（点它开、再点收；Esc / 点抽屉外也能收）。
 *   · 中 **状态区** —— 「已连接 / 未连接」+（有的话）当前会话名。**纯文本**。
 *   · 右 **设置 + 新建对话**图标。
 *
 * 「读当前页」压成输入框左端一个图标按钮（原来它独占一块 + 三行结果文字）。
 *
 * ── ★ 两条可访问文案是验收脚本的锚点（改了就静默失效）────────
 *
 *   · ☰ 的 `aria-label="选择对话"`：`lib/ext-probe-panel.cjs` 的
 *     `CLICK_TITLE_EXPR` 按它找（点它开抽屉）。
 *   · 状态区里当前会话名那条的 `aria-label="当前对话"`：`TITLE_EXPR` 读它。
 *   · **顶栏里绝不能出现 role=status 且同时带 aria-live 的元素**：
 *     `STATUS_TEXT_EXPR` 取的是文档里**第一个**那样的元素，而它要读到的是对话区
 *     那行状态文字（读页面结果 / 发送提示）。顶栏的连接文字因此是**纯文本**
 *     （状态点只有 `role=status`、**没有** `aria-live`，两者同现才算命中）。
 *
 * ── 视觉为什么能跟主应用一致 ────────────────────────────────
 *
 * 不是「照抄一份样式」，是真的走同一套东西：
 *   · Tailwind theme 从主 config **继承**（harbor-edge/postcss.config.js）；
 *   · CSS 变量来自主 `src/index.css` + `src/styles/theme-primer-dark.css`
 *     （见 sidepanel.css 的 @import）；
 *   · 连 `Button` / `IconButton` 都是直接 import 主应用那份 —— 零新依赖。
 */

/* global chrome */

import { useCallback, useEffect, useState } from 'react'
import { Menu, Plus, Settings } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import type { StatusMessage } from './ReadPageButton'
import { ChatPanel } from './ChatPanel'

interface HarborState {
  connected: boolean
  lastError: string | null
  lastPongAt: number
  host: string
}

/** 会话快照里的一条（只取标题要用到的字段） */
interface SessionBrief {
  id: string
  title?: string
}

const INITIAL: HarborState = { connected: false, lastError: null, lastPongAt: 0, host: 'com.harbor.agent' }

/**
 * 连接状态点 —— 为什么不在扩展侧复用主应用的 `StatusDot`：
 * 那个组件依赖 `@/types` + `@/lib/agentPhase` + `@/lib/statusLanguage` 三处，
 * 而且语义是「**线程**执行状态」，跟这里要的「**与 Harbor 的连接**」不是同一件事。
 * 所以按「不能跨目录复用就在扩展侧写一份等价的」办 —— 颜色仍走主应用的 token。
 *
 * ⚠️ 这里**只带** `role=status`，**不带** `aria-live` —— 见文件头那条锚点规矩。
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
  /** 会话抽屉开没开（挂在对话区上方，覆盖它） */
  const [drawer, setDrawer] = useState(false)
  /** 状态行（读页面结果 / 发送提示 / 占位按钮的说明，共用对话区那一条） */
  const [status, setStatus] = useState<StatusMessage | null>(null)
  /** Harbor 当前打开的是哪条会话 + 它的标题（标题让用户知道在跟谁对话） */
  const [sessionId, setSessionId] = useState('')
  const [title, setTitle] = useState('')

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

  /*
   * 状态区里那个会话名：问「当前是哪条会话」→ 从会话快照里取它的标题。
   *
   * ★ 为什么不去改 SW 让 `session-active` 直接回标题：那要动 `service-worker.js`，
   *   超出本次「只改扩展侧这几个文件」的边界。用已有的 `session-active` + 冷启动
   *   快照就够，且**不碰** 3b 那条已被真机验证过的链路。
   *   代价：Harbor 刚点「新建对话」时 active 是临时 id（`pending_…`），快照里查不到
   *   → 名字显示成「Harbor」。这是**已知取舍**，记在交付报告里。
   */
  const refreshTitle = useCallback(() => {
    try {
      const p = chrome.runtime.sendMessage({ type: 'session-active' })
      if (!p || typeof p.then !== 'function') return
      p.then((res: { ok?: boolean; sessionId?: string } | undefined) => {
        if (!res || res.ok !== true) return
        const id = String(res.sessionId ?? '')
        setSessionId(id)
        if (!id) return setTitle('')
        try {
          chrome.storage.local.get('harborSessions').then((out) => {
            const list = (out && out.harborSessions && out.harborSessions.sessions) as SessionBrief[] | undefined
            const hit = Array.isArray(list) ? list.find((s) => s.id === id) : undefined
            setTitle(String(hit?.title ?? ''))
          })
        } catch {
          /* 忽略 */
        }
      }).catch(() => {})
    } catch {
      /* 忽略 */
    }
  }, [])

  useEffect(() => {
    if (state.connected) refreshTitle()
  }, [state.connected, refreshTitle])

  const retry = useCallback(() => {
    try {
      const p = chrome.runtime.sendMessage({ type: 'ping' })
      if (p && typeof p.then === 'function') p.catch(() => {})
    } catch {
      /* 忽略 */
    }
    requestStatus()
  }, [requestStatus])

  /* 抽屉收起时把标题/状态重问一次（刚在 Harbor 里换了对话，回来要看见） */
  const closeDrawer = useCallback(() => {
    setDrawer(false)
    refreshTitle()
  }, [refreshTitle])

  const titleText = title || (sessionId ? sessionId : 'Harbor')

  return (
    <div className="flex h-screen flex-col bg-canvas text-fg-primary">
      {/* ── 顶栏（一行三区）───────────────────────────────────── */}
      <header aria-label="顶栏" className="flex shrink-0 items-center gap-1 border-b border-line-hairline px-2 py-1.5">
        {/* 左：会话抽屉的开关 */}
        <IconButton
          label="选择对话"
          aria-expanded={drawer}
          onClick={() => setDrawer((v) => !v)}
          className="shrink-0"
        >
          <Menu size={16} aria-hidden="true" />
        </IconButton>

        {/* 中：状态区（已连接/未连接 · 当前会话名）。★ 纯文本，不带 aria-live */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1">
          <ConnectionDot connected={state.connected} />
          <span aria-label="连接状态" className="shrink-0 text-2xs text-fg-tertiary">
            {state.connected ? '已连接' : '未连接'}
          </span>
          <span className="shrink-0 text-2xs text-fg-tertiary">·</span>
          <span aria-label="当前对话" title={titleText} className="truncate text-dense text-fg-secondary">
            {titleText}
          </span>
          {state.connected ? null : (
            <button
              type="button"
              aria-label="重试连接"
              onClick={retry}
              className="shrink-0 rounded-sm px-1 text-2xs text-fg-secondary hover:bg-bg-hover hover:text-fg-primary"
            >
              重试
            </button>
          )}
        </div>

        {/* 右：新建 + 设置。
            ⏭ 这两个是本轮的**占位**：真做要加 SW / host 的新 kind，超出
            「只改扩展侧这几个文件」的边界 —— 所以点它们只如实说一句，不假装能用。*/}
        <IconButton
          label="新建对话"
          onClick={() => setStatus({ text: '新建对话目前要在 Harbor 主窗口里点（侧边栏的新建还没做）', tone: 'info' })}
        >
          <Plus size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="设置"
          onClick={() => setStatus({ text: '扩展设置还没做（现在只有这几个：连接、选对话、读当前页、发消息）', tone: 'info' })}
        >
          <Settings size={16} aria-hidden="true" />
        </IconButton>
      </header>

      {/* ── 对话区（占满顶栏与输入框之间的全部空间）───────────── */}
      <ChatPanel
        connected={state.connected}
        drawerOpen={drawer}
        onCloseDrawer={closeDrawer}
        status={status}
        onStatus={setStatus}
      />
    </div>
  )
}

export default App
