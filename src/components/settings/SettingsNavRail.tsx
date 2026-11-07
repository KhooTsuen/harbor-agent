import { cn } from '@/lib/utils'
import { SETTINGS_GROUPS, SETTINGS_NAV, type SettingsTabId } from './settingsNav'

/* ══════════════════════════════════════════════════════════════
   设置工作区 · 左侧导航

   ── 这个文件只负责「一列能点的分类」 ───────────────────────────
   分组、顺序、图标全在 `settingsNav.ts`（唯一真相源），这里不复制一份。
   加一页 = 改那边一处，这里自动出现。

   ── 键盘操作（第一阶段验收要求）───────────────────────────────
   整列是一个 roving tabindex 的 listbox：
     · 只有当前页是 tabIndex=0，Tab 进来落在选中项上
     · ↑ / ↓ 在页之间移动并**立即切换**（不用再按 Enter）
     · Home / End 跳第一页 / 最后一页
   这样「不用鼠标也能走完 13 页」，而且是标准 listbox 语义
   （读屏会念「13 项中的第 4 项」）。
   ══════════════════════════════════════════════════════════════ */

export interface SettingsNavRailProps {
  current: SettingsTabId
  onPick: (id: SettingsTabId) => void
}

export function SettingsNavRail({ current, onPick }: SettingsNavRailProps): React.ReactElement {
  const ids = SETTINGS_NAV.map((item) => item.id)

  const step = (delta: number): void => {
    const at = ids.indexOf(current)
    const next = Math.min(ids.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))
    onPick(ids[next])
  }

  return (
    <nav
      aria-label="设置分类"
      className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-line-subtle px-2 py-3"
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          step(1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          step(-1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          onPick(ids[0])
        } else if (event.key === 'End') {
          event.preventDefault()
          onPick(ids[ids.length - 1])
        }
      }}
    >
      {SETTINGS_GROUPS.map((group) => {
        const items = SETTINGS_NAV.filter((item) => item.group === group)
        if (items.length === 0) return null
        return (
          <div key={group} className="mb-2 last:mb-0">
            <p className="mb-1 px-2 text-2xs uppercase tracking-wide text-fg-tertiary">{group}</p>
            <ul role="listbox" aria-label={group} className="flex flex-col gap-0.5">
              {items.map(({ id, label, icon: Icon }) => {
                const active = id === current
                return (
                  <li key={id} role="none">
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-current={active ? 'page' : undefined}
                      tabIndex={active ? 0 : -1}
                      onClick={() => onPick(id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-fast',
                        active
                          ? 'bg-bg-raised font-medium text-fg-primary'
                          : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                      )}
                    >
                      <Icon size={14} className="shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">{label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}
