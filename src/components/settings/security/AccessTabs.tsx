import { cn } from '@/lib/utils'
import { ACCESS_TABS, useAccessTabStore, type AccessTab } from '@/stores/useAccessTabStore'

/* ══════════════════════════════════════════════════════════════
   「权限与安全」页内的四个分组

   ── 为什么这一页也要分组 ──────────────────────────────────────
   原来六个面板纵向平铺（权限档 / 文件范围 / Shell 策略 / 网络 / 会话加密 /
   授权 / 审批 / 审计 / 密钥），真机要滚五六屏才能找到「撤销某个授权」。
   分成四组之后每屏都短，且四件事发生在不同时刻：

     · 权限策略  配一次就不动
     · 数据保护  偶尔来看看状态
     · 授权与审计 出事时才来（撤销 / 查它干了什么）
     · 高级与危险 平时不看

   ★ 用「标签」而不是「折叠面板」：折叠会让用户以为没展开的那几块
     没生效（恰恰相反 —— 安全设置一直生效）。标签是平级的，不存在
     「被收起来 = 关掉了」这种误读。

   ⚠️ 这只是交互分层，**不是安全边界** —— 判据始终在内核里。
   ══════════════════════════════════════════════════════════════ */

const LABELS: Record<AccessTab, string> = {
  policy: '权限策略',
  protection: '数据与会话保护',
  audit: '授权与审计',
  advanced: '高级与危险操作',
}

export function AccessTabs(): React.ReactElement {
  const current = useAccessTabStore((s) => s.tab)
  const setTab = useAccessTabStore((s) => s.setTab)

  const step = (delta: number): void => {
    const at = ACCESS_TABS.indexOf(current)
    const next = Math.min(ACCESS_TABS.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))
    setTab(ACCESS_TABS[next])
  }

  return (
    <div
      role="tablist"
      aria-label="权限与安全的分类"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          step(1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          step(-1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          setTab(ACCESS_TABS[0])
        } else if (event.key === 'End') {
          event.preventDefault()
          setTab(ACCESS_TABS[ACCESS_TABS.length - 1])
        }
      }}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-subtle pb-2"
    >
      {ACCESS_TABS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={current === id}
          tabIndex={current === id ? 0 : -1}
          onClick={() => setTab(id)}
          className={cn(
            'shrink-0 rounded-sm px-3 py-1.5 text-dense transition-colors duration-fast',
            current === id
              ? 'bg-bg-raised text-fg-primary'
              : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
          )}
        >
          {LABELS[id]}
        </button>
      ))}
    </div>
  )
}
