import { useEffect, useMemo, useState } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'
import { useAppStore, sortThreads } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Modal } from '@/components/ui/Modal'
import { cn, truncate } from '@/lib/utils'
import { MODES } from '@/constants'

/* ══════════════════════════════════════════════════════════════
   命令面板（Ctrl+K）

   两类结果：跳转到某个线程、执行一个动作。
   上下键选择，回车执行。
   ══════════════════════════════════════════════════════════════ */

interface PaletteItem {
  id: string
  label: string
  hint?: string
  run: () => void
}

export function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen)
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen)
  const openSettings = useUIStore((s) => s.openSettings)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const openBottomPanel = useUIStore((s) => s.openBottomPanel)
  const closeSettings = useUIStore((s) => s.closeSettings)

  const threads = useAppStore((s) => s.threads)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const createThread = useAppStore((s) => s.createThread)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const searchHistory = useSettingsStore((s) => s.settings.searchHistory)
  const addSearchHistory = useSettingsStore((s) => s.addSearchHistory)
  const clearSearchHistory = useSettingsStore((s) => s.clearSearchHistory)

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        id: 'action:new',
        label: '新建对话',
        hint: 'Ctrl N',
        run: () => {
          createThread()
          setOpen(false)
        },
      },
      {
        id: 'action:settings',
        label: '打开设置',
        hint: 'Ctrl ,',
        run: () => {
          setOpen(false)
          openSettings()
        },
      },
      {
        id: 'action:diff',
        label: '打开审查面板',
        hint: 'Ctrl Shift G',
        run: () => {
          setActiveRightTab('diff')
          setOpen(false)
        },
      },
      {
        id: 'action:terminal',
        label: '打开终端面板',
        run: () => {
          /* 终端只在底栏 —— 命令也一样，开底栏的终端那一栏 */
          openBottomPanel('terminal')
          setOpen(false)
        },
      },
      {
        id: 'action:files',
        label: '打开文件面板',
        hint: 'Ctrl P',
        run: () => {
          setActiveRightTab('files')
          setOpen(false)
        },
      },
    ]

    const jumps: PaletteItem[] = sortThreads(threads).map((thread) => ({
      id: `thread:${thread.id}`,
      label: thread.title,
      hint: MODES.find((m) => m.id === thread.mode)?.label,
      run: () => {
        setActiveThread(thread.id)
        closeSettings()
        setOpen(false)
      },
    }))

    /* 消息内容匹配：命中时显示所在线程 + 内容片段 */
    /* 空查询时先显示最近搜过的词，点一下就填回去 */
    const historyItems: PaletteItem[] = !query.trim()
      ? searchHistory.slice(0, 6).map((text) => ({
          id: `history:${text}`,
          label: text,
          hint: '历史',
          run: () => setQuery(text),
        }))
      : []

    const q = query.trim().toLowerCase()
    const messageHits: PaletteItem[] = q
      ? threads
          .flatMap((thread) =>
            thread.messages
              .filter((m) => m.content.toLowerCase().includes(q))
              .map((m) => ({ thread, message: m })),
          )
          .slice(0, 5)
          .map(({ thread, message }) => ({
            id: `msg:${message.id}`,
            label: thread.title,
            hint: truncate(message.content.replace(/\s+/g, ' '), 30),
            run: () => {
              setActiveThread(thread.id)
              closeSettings()
              setOpen(false)
            },
          }))
      : []

    return [...historyItems, ...actions, ...messageHits, ...jumps]
  }, [
    threads,
    query,
    searchHistory,
    createThread,
    openBottomPanel,
    setOpen,
    openSettings,
    setActiveRightTab,
    setActiveThread,
    closeSettings,
  ])

  /** 统一入口：执行前把搜索词记进历史（历史项本身不再重复记） */
  const execute = (item: PaletteItem | undefined): void => {
    if (!item) return
    if (!item.id.startsWith('history:')) addSearchHistory(query)
    item.run()
  }

  const filtered = useMemo(() => {
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter((item) => item.label.toLowerCase().includes(q))
  }, [items, query])

  /* 打开时清空输入和光标 */
  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
    }
  }, [open])

  useEffect(() => {
    setCursor(0)
  }, [query])

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="命令面板" width="md">
      <div className="flex items-center gap-2 rounded border border-line-subtle bg-bg-input px-2.5 py-2 focus-within:border-line-focus">
        <Search size={15} className="shrink-0 text-fg-tertiary" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, filtered.length - 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              execute(filtered[cursor])
            }
          }}
          placeholder="输入要有做的事，或者搜对话标题"
          aria-label="命令面板输入"
          className="min-w-0 flex-1 bg-transparent text-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />
        <kbd className="shrink-0 rounded-sm border border-line-subtle px-1.5 py-0.5 font-mono text-2xs text-fg-tertiary">
          Esc
        </kbd>
      </div>

      <ul className="mt-3 flex max-h-72 flex-col gap-0.5 overflow-y-auto" role="listbox">
        {filtered.length === 0 ? (
          <li className="px-2 py-6 text-center text-xs text-fg-tertiary">没有匹配的结果</li>
        ) : (
          filtered.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === cursor}
                onMouseEnter={() => setCursor(index)}
                onClick={() => execute(item)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
                  index === cursor
                    ? 'bg-bg-raised text-fg-primary'
                    : 'text-fg-secondary hover:bg-bg-hover',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint ? (
                  <span className="shrink-0 font-mono text-2xs text-fg-tertiary">{item.hint}</span>
                ) : null}
                {index === cursor ? (
                  <CornerDownLeft size={12} className="shrink-0 text-fg-tertiary" />
                ) : null}
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="mt-3 flex items-center gap-2 border-t border-line-subtle pt-2 text-2xs text-fg-tertiary">
        <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
        {searchHistory.length > 0 && !query ? (
          <button
            type="button"
            onClick={() => clearSearchHistory()}
            className="ml-auto shrink-0 rounded-small px-1.5 py-0.5 transition-colors hover:bg-bg-hover hover:text-fg-primary"
          >
            清空历史
          </button>
        ) : null}
      </div>
    </Modal>
  )
}
