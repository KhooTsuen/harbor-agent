import { Search, X } from 'lucide-react'
import type { SettingsTabId } from './parts'
import { locationOf, searchSettings, type SettingsEntry } from './settingsSearch'

/* ══════════════════════════════════════════════════════════════
   P3 #20：设置搜索框 + 结果列表

   从 `SettingsModal.tsx` 拆出来的（那边贴着 300 行）。这一块自成一体：
   输入、结果、定位三件事，和标签栏 / 内容区的布局没关系。

   ── 三条「不生成不存在的设置」的落地 ─────────────────────────
     · 只从 `SETTINGS_INDEX` 出结果，那个表只收真实存在的项
     · 页面被删掉的项不算命中（`tabOf` 查不到就跳过）
     · 结果里显示**分类名**，用户点之前就知道它会跳到哪

   ── 简洁视图搜到详细页 ──────────────────────────────────────
   结果后面标「在详细视图里」并给一句说明。点它仍然会跳过去
   （`visibleTabsOf` 允许当前页例外显示），所以不会「点了没反应」。
   ══════════════════════════════════════════════════════════════ */

export interface SettingsSearchBoxProps {
  query: string
  onQueryChange: (value: string) => void
  tabOf: (id: SettingsTabId) => { label: string; detailedOnly?: boolean } | undefined
  view: 'simple' | 'detailed'
  /** 点某条结果 → 切到它所在的页（并清空搜索，让用户看见那一页） */
  onPick: (entry: SettingsEntry) => void
}

export function SettingsSearchBox({
  query,
  onQueryChange,
  tabOf,
  view,
  onPick,
}: SettingsSearchBoxProps) {
  const results = searchSettings(query, tabOf)
  const showing = query.trim().length > 0

  return (
    <div className="mb-2 shrink-0">
      <div className="relative">
        <Search
          size={13}
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-tertiary"
        />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索设置（试试「深色」「备份」「权限」）"
          aria-label="搜索设置"
          className="w-full rounded-sm border border-line-subtle bg-bg-input py-1 pl-7 pr-7 text-xs text-fg-primary placeholder:text-fg-tertiary"
        />
        {showing ? (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="清空搜索"
            title="清空搜索"
            className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      {showing ? (
        results.length === 0 ? (
          <p role="status" className="px-1 pt-1.5 text-2xs text-fg-tertiary">
            没有找到「{query.trim()}」相关的设置。换个说法试试，或者去左边的分类里翻。
          </p>
        ) : (
          <div className="pt-1.5">
            <p className="px-1 text-2xs text-fg-tertiary" role="status">
              找到 {results.length} 项
            </p>
            <ul
              className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto"
              aria-label="搜索结果"
            >
              {results.map((entry) => (
                <li key={`${entry.tab}:${entry.label}`}>
                  <button
                    type="button"
                    onClick={() => onPick(entry)}
                    className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left transition-colors duration-fast hover:bg-bg-hover"
                  >
                    <span className="shrink-0 text-xs text-fg-primary">{entry.label}</span>
                    <span className="min-w-0 flex-1 truncate text-2xs text-fg-tertiary">
                      {entry.hint}
                    </span>
                    {/* 分类名 —— 点之前就知道会跳到哪一页 */}
                    <span className="shrink-0 rounded-sm bg-bg-raised px-1 text-2xs text-fg-secondary">
                      {locationOf(entry, tabOf, view)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
    </div>
  )
}
