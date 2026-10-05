import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Globe, Plus, RotateCw, X, XCircle } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { useBrowseDriver } from './browser/useBrowseDriver'
import { goInView, navStateOf } from './browser/webviewNav'
import { useBrowserStore, tabsOfSession, visibleTabOf } from '@/stores/useBrowserStore'
import { useAppStore } from '@/stores/useAppStore'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   浏览器标签

   真的内嵌网页 —— 用 Electron 的 <webview>，不是 iframe
   （iframe 会被大多数站点的 X-Frame-Options 挡掉，等于打不开）。

   结构：地址栏 → 标签页 → 网页。
   一开始是空的，不预填地址 —— 以前默认塞了个 localhost，看着像配置错了。
   ══════════════════════════════════════════════════════════════ */

/** 补协议：用户一般不会自己打 https:// */
function normalizeUrl(input: string): string {
  const text = input.trim()
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) return text
  /* 本地地址走 http —— https 在本地开发服务器上通常不通 */
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\d+\.\d+\.\d+\.\d+)(:\d+)?(\/|$)/i.test(text)) {
    return `http://${text}`
  }
  /* 看着像域名的就补 https，其余的当搜索词 */
  if (/^[\w-]+(\.[\w-]+)+/.test(text)) return `https://${text}`
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}

/** 标签页上显示的短标题 */
function titleOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname + (parsed.pathname === '/' ? '' : parsed.pathname)
  } catch {
    return url
  }
}

interface Tab {
  id: string
  url: string
}

export function BrowserTab() {
  /*
   * 标签状态放在 store 里，不是 useState —— Agent 的 browse 工具
   * 要能自己开标签（见 useBrowserStore 的注释，那里写了踩过的坑）。
   */
  const tabs = useBrowserStore((s) => s.tabs)
  const activeId = useBrowserStore((s) => s.activeId)
  const openTab = useBrowserStore((s) => s.open)
  const selectTab = useBrowserStore((s) => s.select)
  const closeTab = useBrowserStore((s) => s.close)
  /* 会话号就是 Thread.id —— 标签栏按会话隔离靠它（真机反馈 6） */
  const sessionId = useAppStore((s) => s.activeThreadId)

  const [draft, setDraft] = useState('')
  /** Agent 的 `browse` 工具要通过它操作当前这个 webview */
  const webviewRef = useRef<HTMLElement | null>(null)
  /* 前进/后退能不能点（webview 的 API 是同步的，但按钮要重渲才知道） */
  const [nav, setNav] = useState({ back: false, forward: false })

  useBrowseDriver(webviewRef)

  /* 前进/后退：调用一律走 webviewNav —— 那边裹了 try/catch（没就绪时调它会抛） */
  function go(step: 'back' | 'forward'): void {
    goInView(webviewRef.current, step)
  }

  /*
   * 本会话的标签（标签栏只摆这些）+ 当前该显示 / 被 Agent 驱动的那一个。
   * 两个口径都从 store 里取（见 useBrowserStore 的 tabsOfSession / visibleTabOf），
   * 不在这里重写一遍筛选条件 —— 否则跟 useBrowseBridge 那边的判断会慢慢走垪。
   */
  const mine = tabsOfSession(tabs, sessionId)
  const active = visibleTabOf(tabs, sessionId, activeId)

  /*
   * 导航事件里刷一次前进/后退的可用性。
   * 依赖里带 `active?.id` 是因为 webview 元素会随当前标签换 —— 换了就得重新挂监听。
   * （监听挂在**元素**上，所以类型要带上 HTMLElement 那一半边。）
   */
  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    /*
     * ⚠️ 状态一律用 navStateOf 取（它裹了 try/catch）—— 直接调 `view.canGoBack()`
     * 在 guest 没就绪时会抛，而异常从 effect 冒出去就是整个面板「这一块出错了」（真机踩过）。
     * `dom-ready` 也得听：页面如果是「已经加载好」才挂上来的，只有它会响。
     */
    const sync = (): void => setNav(navStateOf(view))
    sync()
    const names = [
      'dom-ready',
      'did-navigate',
      'did-navigate-in-page',
      'did-finish-load',
      'did-fail-load',
    ]
    for (const name of names) view.addEventListener(name, sync)
    return () => {
      for (const name of names) view.removeEventListener(name, sync)
    }
  }, [active?.id])

  function open(input: string): void {
    const url = normalizeUrl(input)
    if (!url) return
    /* 带上会话号：这个标签从此属于本会话（切到别的会话就不会摆在人家那儿） */
    openTab(url, sessionId)
    setDraft(url)
  }

  function select(tab: Tab): void {
    selectTab(tab.id)
    setDraft(tab.url)
  }

  function close(id: string): void {
    /* 关掉的是当前标签时，地址栏要跟着换到接替的那个（只在**本会话**里找） */
    if (id === active?.id) {
      const fallback = mine.filter((tab) => tab.id !== id).at(-1)
      setDraft(fallback?.url ?? '')
    }
    closeTab(id)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── 地址栏 ── */}
      <form
        className="flex shrink-0 items-center gap-1.5 border-b border-line-subtle px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          open(draft)
        }}
      >
        <IconButton label="后退" size={28} disabled={!nav.back} onClick={() => go('back')}>
          <ChevronLeft size={13} />
        </IconButton>
        <IconButton label="前进" size={28} disabled={!nav.forward} onClick={() => go('forward')}>
          <ChevronRight size={13} />
        </IconButton>
        <Globe size={13} className="shrink-0 text-fg-tertiary" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="输入网址，回车打开"
          aria-label="地址栏"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />
        {active ? (
          <IconButton
            label="重新加载"
            size={28}
            onClick={() => useBrowserStore.getState().reload()}
          >
            <RotateCw size={12} />
          </IconButton>
        ) : null}
        <IconButton
          label="新标签页"
          size={28}
          onClick={() => open(draft || 'https://www.bing.com')}
        >
          <Plus size={13} />
        </IconButton>
      </form>

      {/* ── 标签页（在地址栏下面）—— 只摆**本会话**的（别的会话的标签留着但不摆出来）── */}
      {mine.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-line-subtle px-1.5 py-1">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {mine.map((tab) => {
              const isActive = tab.id === active?.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => select(tab)}
                  title={tab.url}
                  className={cn(
                    'group flex max-w-44 shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-xs transition-colors duration-fast',
                    isActive
                      ? 'bg-bg-raised text-fg-primary'
                      : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                  )}
                >
                  <Globe size={11} className="shrink-0 opacity-60" />
                  <span className="min-w-0 flex-1 truncate font-mono">{titleOf(tab.url)}</span>
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label="关闭标签页"
                    onClick={(e) => {
                      e.stopPropagation()
                      close(tab.id)
                    }}
                    className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-bg-overlay group-hover:opacity-100"
                  >
                    <X size={11} />
                  </span>
                </button>
              )
            })}
          </div>
          {/* 一次性关掉本对话的全部标签（真机反馈 3） */}
          <IconButton
            label="关闭全部标签（只关这条对话的）"
            size={28}
            onClick={() => useBrowserStore.getState().closeAll(sessionId)}
          >
            <XCircle size={13} />
          </IconButton>
        </div>
      ) : null}

      {/* ── 内容 ── */}
      {/*
        每个标签一个**常驻** webview（真机反馈 1a）。

        以前只渲染当前标签那一个（`key` 里带 activeId）：切标签 = 卸载旧的、挂载新的
        = 底下那个 webContents 被销毁 → 切回来网页从头加载（滚动位置、填了一半的表单、
        SPA 状态全没）。现在切标签只是换 `display`，页面本身一直活着。

        `key` 里只放这个标签**自己**的 reloadKey（手动重载才重建它自己），
        所以切标签、别的标签重载，都不会重建它。

        这一层**永远挂着**（哪怕本会话一个标签都没有）：别的会话的页面还在里面活着，
        只是 `display:none`（真机反馈 6：会话之间不互相销毁）。

        隔离说明（都是刻意写的，别删）：
          · partition —— 独立会话，网页碰不到应用自己的存储
          · webpreferences —— 明确写死沙箱，不靠默认值
          · ref —— Agent 的 browse 工具靠它驱动**当前**这个 webview

        webview 高度要由外面这层给死，不然它在 flex 里会塌成 0。
      */}
      <div className="relative min-h-0 flex-1 bg-bg-base">
        {tabs.map((tab) => (
          <webview
            key={`${tab.id}-${tab.reloadKey}`}
            /*
             * 只有当前标签那个交给 Agent（驱动只认一个元素）。
             * 用回调 ref 而不是 ref 对象：ref 对象会被 React 挂到**最后一个**上面。
             * 每次重渲会先以 null 调旧回调、再以元素调新回调 —— null 那次忽略即可。
             */
            ref={
              ((el: HTMLElement | null) => {
                if (el && tab.id === active?.id) webviewRef.current = el
              }) as React.RefCallback<never>
            }
            src={tab.url}
            partition="persist:agent-browser"
            webpreferences="sandbox=yes,contextIsolation=yes,nodeIntegration=no"
            allowpopups="true"
            style={{
              /*
               * ★ 绝对定位铺满，**不能用 `display:none` 藏**（真机反馈 2：切回来后半截黑屏）。
               * display:none → 元素尺寸变 0×0 → 底下的 guest 视图跟着塌，
               * 再显示时它不一定重排（页面就停在那个小尺寸上，下面一大块是空的）。
               * 现在是 `visibility:hidden` + 绝对定位：元素**始终**是一个完整尺寸，
               * 只是看不见、也不吃鼠标。
               */
              position: 'absolute',
              inset: 0,
              visibility: tab.id === active?.id ? 'visible' : 'hidden',
              pointerEvents: tab.id === active?.id ? 'auto' : 'none',
              zIndex: tab.id === active?.id ? 1 : 0,
            }}
          />
        ))}
        {/* 本会话没有页面时叠一层空状态（位置跟以前一样：就在标签栏下面） */}
        {active ? null : (
          <EmptyState
            className="absolute inset-0"
            icon={<Globe size={28} />}
            title="内置浏览器"
            description="在上面输入网址回车，网页会在这里打开。也可以在终端里跑起本地服务，再访问 localhost。"
          />
        )}
      </div>
    </div>
  )
}
