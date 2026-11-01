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

import { useCallback, useEffect, useRef, useState } from 'react'
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
  /** M02-C：设置抽屉（与会话抽屉同款，从左侧滑出） */
  const [settings, setSettings] = useState(false)
  /** 状态行（读页面结果 / 发送提示 / 占位按钮的说明，共用对话区那一条） */
  const [status, setStatus] = useState<StatusMessage | null>(null)
  /**
   * 侧边栏**自己**在看哪条会话（Phase 3c）。
   *
   * ★ 与「Harbor 主窗口当前打开的那条」是**两回事** —— 用户 2026-10-16 拍板
   *   「侧边栏独立看一条，主窗口不动」。空串 = 还没选（这时发消息会新建一条）。
   * ★ 真相在主进程（`ext-chat.cjs` 的 `selectedSessionId`）：它推 `session:selected`
   *   过来，这里跟着设。冷启动先读 `chrome.storage` 里那份，免得闪一下空。
   */
  const [sessionId, setSessionId] = useState('')
  /** 当前会话的标题（只用于顶栏显示；从会话快照里查） */
  const [title, setTitle] = useState('')
  /** 会话快照（抽屉刷新 / 顶栏查标题都用它） */
  const [sessions, setSessions] = useState<SessionBrief[]>([])
  const selectionVersion = useRef(0)

  useEffect(() => {
    /* ① 先拿快照：SW 可能要几百毫秒才醒，不能让界面空着 */
    try {
      const startedAt = selectionVersion.current
      chrome.storage.local.get(['harborState', 'harborSessions', 'harborSelected']).then((out) => {
        if (out && out.harborState) setState(out.harborState as HarborState)
        const snap = out && out.harborSessions
        if (snap && Array.isArray(snap.sessions)) setSessions(snap.sessions as SessionBrief[])
        const sel = out && out.harborSelected
        if (selectionVersion.current === startedAt && sel && typeof sel.sessionId === 'string') setSessionId(sel.sessionId)
      })
    } catch {
      /* 拿不到就用默认值 */
    }

    /* ② 订阅 SW 广播：连接状态 + 主进程推来的「侧边栏现在在看哪条」 */
    const onMsg = (msg: { type?: string; state?: HarborState; push?: { kind?: string; payload?: { sessionId?: string } } }) => {
      if (msg && msg.type === 'status' && msg.state) {
        setState(msg.state)
        return
      }
      if (msg && msg.type === 'harbor-push' && msg.push?.kind === 'session:selected') {
        selectionVersion.current += 1
        const id = String(msg.push.payload?.sessionId ?? '')
        setStatus(null)
        setSessionId(id)
        try {
          chrome.storage.local.set({ harborSelected: { sessionId: id } })
        } catch {
          /* 存不下不影响本次 */
        }
      }
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

  /* 会话快照变了就带上标题（抽屉刷新后会 setSessions） */
  useEffect(() => {
    if (!sessionId) return setTitle('')
    const hit = sessions.find((s) => s.id === sessionId)
    setTitle(String(hit?.title ?? ''))
  }, [sessionId, sessions])

  /* Phase 3c：抽屉里点了一条 —— **只切侧边栏**（主窗口不动），顺手收起抽屉 */
  const selectSession = useCallback((id: string) => {
    setDrawer(false)
    setStatus(null)
    try {
      const p = chrome.runtime.sendMessage({ type: 'session-select', sessionId: id })
      if (p && typeof p.then === 'function') p.then((res: { ok?: boolean; error?: string } | undefined) => {
        if (!res?.ok) setStatus({ text: String(res?.error ?? '切换对话失败'), tone: 'danger' })
      }).catch((e: unknown) => setStatus({ text: String((e as Error)?.message ?? e), tone: 'danger' }))
    } catch {
      setStatus({ text: '切换对话失败：扩展连接不可用', tone: 'danger' })
    }
  }, [])

  /* Phase 3c：顶栏 ＋ —— 新建一条（渲染层会切过去；新 id 由 push 回来） */
  const newSession = useCallback(() => {
    setDrawer(false)
    try {
      const p = chrome.runtime.sendMessage({ type: 'session-new' })
      if (p && typeof p.then === 'function') {
        p.then((res: { ok?: boolean; error?: string } | undefined) => {
          if (!res || res.ok !== true) setStatus({ text: String(res?.error ?? '新建会话失败'), tone: 'danger' })
        }).catch((e: unknown) => setStatus({ text: String((e as Error)?.message ?? e), tone: 'danger' }))
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

  const closeDrawer = useCallback(() => setDrawer(false), [])

  const titleText = title || (sessionId ? sessionId : '未选对话')

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

        {/* 右：新建 + 设置。＋ 现在是**真的**（Phase 3c）：新建一条并两侧切过去。 */}
        <IconButton label="新建对话" onClick={newSession}>
          <Plus size={16} aria-hidden="true" />
        </IconButton>
        {/* M02-C：设置抽屉（以前是个**假按钮**，点了只弹一句「还没做」） */}
        <IconButton label="设置" onClick={() => setSettings(true)}>
          <Settings size={16} aria-hidden="true" />
        </IconButton>
      </header>

      {/* ── 对话区（占满顶栏与输入框之间的全部空间）───────────── */}
      <ChatPanel
        connected={state.connected}
        sessionId={sessionId}
        drawerOpen={drawer}
        onCloseDrawer={closeDrawer}
        onSelectSession={selectSession}
        status={status}
        onStatus={setStatus}
        lastError={state.lastError ?? null}
        onRetry={retry}
        settingsOpen={settings}
        onCloseSettings={() => setSettings(false)}
      />
    </div>
  )
}

export default App
