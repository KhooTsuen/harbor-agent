import { useRef, useState } from 'react'
import { Globe, Plus, RotateCw, X } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { useBrowseDriver } from './browser/useBrowseDriver'
import { useBrowserStore } from '@/stores/useBrowserStore'
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
  const reloadKey = useBrowserStore((s) => s.reloadKey)
  const openTab = useBrowserStore((s) => s.open)
  const selectTab = useBrowserStore((s) => s.select)
  const closeTab = useBrowserStore((s) => s.close)

  const [draft, setDraft] = useState('')
  /** Agent 的 `browse` 工具要通过它操作当前这个 webview */
  const webviewRef = useRef<HTMLElement | null>(null)

  useBrowseDriver(webviewRef)

  const active = tabs.find((tab) => tab.id === activeId)

  function open(input: string): void {
    const url = normalizeUrl(input)
    if (!url) return
    openTab(url)
    setDraft(url)
  }

  function select(tab: Tab): void {
    selectTab(tab.id)
    setDraft(tab.url)
  }

  function close(id: string): void {
    /* 关掉的是当前标签时，地址栏要跟着换到接替的那个 */
    if (id === activeId) {
      const fallback = tabs.filter((tab) => tab.id !== id).at(-1)
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

      {/* ── 标签页（在地址栏下面）── */}
      {tabs.length > 0 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-subtle px-1.5 py-1">
          {tabs.map((tab) => {
            const isActive = tab.id === activeId
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
      ) : null}

      {/* ── 内容 ── */}
      {active ? (
        /* webview 高度要由外面这层给死，不然它在 flex 里会塌成 0 */
        <div className="min-h-0 flex-1 bg-bg-base">
          {/*
            隔离说明（都是刻意写的，别删）：
              · partition —— 独立会话，网页碰不到应用自己的存储
              · webpreferences —— 明确写死沙箱，不靠默认值
              · ref —— Agent 的 browse 工具靠它驱动这个 webview
          */}
          <webview
            key={`${active.id}-${reloadKey}`}
            ref={webviewRef as React.RefObject<never>}
            src={active.url}
            partition="persist:agent-browser"
            webpreferences="sandbox=yes,contextIsolation=yes,nodeIntegration=no"
            allowpopups="false"
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      ) : (
        <EmptyState
          icon={<Globe size={28} />}
          title="内置浏览器"
          description="在上面输入网址回车，网页会在这里打开。也可以在终端里跑起本地服务，再访问 localhost。"
        />
      )}
    </div>
  )
}
