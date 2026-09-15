import { useState } from 'react'
import { Globe, Plus, RotateCw, X } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
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
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState('')
  const [draft, setDraft] = useState('')
  /** 换一个值就是强制重建 webview（重载用） */
  const [reloadKey, setReloadKey] = useState(0)

  const active = tabs.find((tab) => tab.id === activeId)

  function open(input: string): void {
    const url = normalizeUrl(input)
    if (!url) return
    const id = `tab-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    setTabs((prev) => [...prev, { id, url }])
    setActiveId(id)
    setDraft(url)
  }

  function select(tab: Tab): void {
    setActiveId(tab.id)
    setDraft(tab.url)
  }

  function close(id: string): void {
    const next = tabs.filter((tab) => tab.id !== id)
    setTabs(next)
    if (id === activeId) {
      const fallback = next[next.length - 1]
      setActiveId(fallback?.id ?? '')
      setDraft(fallback?.url ?? '')
    }
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
          <IconButton label="重新加载" size={28} onClick={() => setReloadKey((v) => v + 1)}>
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
          <webview
            key={`${active.id}-${reloadKey}`}
            src={active.url}
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
