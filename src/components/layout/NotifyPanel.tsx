import { useMemo, useState } from 'react'
import { Bell, Settings2, Trash2, X } from 'lucide-react'
import type { NotifyRoute } from '@/types'
import { NOTIFY_CATEGORIES } from '@/lib/notifyCenter'
import { useNotifyCenter } from '@/stores/useNotifyCenter'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { colorOf, statusOfToast } from '@/lib/statusLanguage'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   通知（右栏标签）—— 右下角那些「事后看就行」的提示，收在这里

   ── 为什么要这个面板 ────────────────────────────────────────
   右下角那块以前混装三类性质完全不同的东西：要你现在处理的、事后看就行的、
   过程播报的。后两类把第一类挤没了 —— 所以给它们一个收件箱，让「要你处理的」
   独占右下角（分流规则见 `lib/notifyCenter.ts`）。

   ── 和「错误」标签的分工 ────────────────────────────────────
     · 错误 = 内核在出错现场记的诊断（带位置 / 建议 / 技术分类，只读，按天查）
     · 通知 = 给人看的事件流水（可清空、可点按钮回去看）
   一次失败会同时出现在两边，但**用途不同**，不是重复。

   ── 顶部那块设置为什么要在这里 ──────────────────────────────
   用户在设置页里翻三个标签页找到的开关，改完还得回来验证效果 ——
   而「哪类通知烦人」这件事，是他**站在这张列表前**才想得起来的。
   所以设置就地放在列表上面（默认折起，不占地方）。
   ══════════════════════════════════════════════════════════════ */

/** 时间：收件箱里也用绝对时间，但要能一眼看出「多久以前」 */
function ago(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 三档各自怎么写 —— 顺序即展示顺序，选中的那一档高亮 */
const ROUTE_OPTIONS: readonly { value: NotifyRoute; label: string; title: string }[] = [
  { value: 'toast', label: '弹卡片', title: '右下角弹出来，几秒后自己消失' },
  { value: 'center', label: '进这里', title: '不弹，只出现在这张列表里' },
  { value: 'off', label: '都不要', title: '不弹也不记' },
]

export function NotifyPanel() {
  const items = useNotifyCenter((s) => s.items)
  const clear = useNotifyCenter((s) => s.clear)
  const remove = useNotifyCenter((s) => s.remove)
  const routes = useSettingsStore((s) => s.settings.notifyRoutes)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)

  /*
   * 相对时间按「打开面板那一刻」算一次就够 —— 列表通常看几秒，
   * 为它挂一个每秒 tick 的定时器只会让整页白白重渲染（和项目「空闲不动」一致）。
   */
  const now = useMemo(() => Date.now(), [])

  return (
    <div aria-label="通知" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line-subtle px-2 py-1">
        <span className="text-2xs text-fg-tertiary">
          {items.length > 0 ? `${items.length} 条` : '没有通知'}
        </span>
        <button
          type="button"
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          aria-label="哪些通知进这里"
          title="哪些通知进这里（弹卡片 / 只进这里 / 都不要）"
          className={cn(
            'ml-auto grid size-6 shrink-0 place-items-center rounded-sm transition-colors duration-fast',
            settingsOpen
              ? 'bg-bg-raised text-fg-primary'
              : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
          )}
        >
          <Settings2 size={13} />
        </button>
        <button
          type="button"
          onClick={() => clear()}
          disabled={items.length === 0}
          aria-label="清空通知"
          title="清空通知（只清这张列表，不影响错误清单）"
          className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary disabled:opacity-40"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {settingsOpen ? (
        <div className="shrink-0 border-b border-line-subtle px-2 py-1.5">
          <p className="mb-1 text-2xs text-fg-tertiary">
            每一类通知怎么处理。右下角只留「要你处理的事」，其余的可以只进这里。
          </p>
          <ul className="flex flex-col gap-1">
            {NOTIFY_CATEGORIES.map((cat) => (
              <li key={cat.id} className="flex items-center gap-1.5">
                <span
                  className="min-w-0 flex-1 truncate text-xs text-fg-secondary"
                  title={cat.hint}
                >
                  {cat.label}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  {ROUTE_OPTIONS.map((opt) => {
                    const active = routes[cat.id] === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        title={opt.title}
                        aria-pressed={active}
                        onClick={() =>
                          updateSettings({
                            notifyRoutes: { ...routes, [cat.id]: opt.value },
                          })
                        }
                        className={cn(
                          'rounded-sm px-1.5 py-0.5 text-2xs transition-colors duration-fast',
                          active
                            ? 'bg-bg-raised text-fg-primary'
                            : 'text-fg-tertiary hover:bg-bg-hover hover:text-fg-secondary',
                        )}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
            <Bell size={18} className="text-fg-tertiary" aria-hidden />
            <p className="text-2xs text-fg-tertiary">
              这里放「事后看就行」的通知：任务跑完了、下载完成、Agent 在做什么。
              要你立刻处理的事仍然会在右下角弹出来。
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li
                key={item.id}
                className={cn(
                  'group rounded-sm border px-2 py-1.5',
                  item.unread
                    ? 'border-line-subtle bg-bg-raised/60'
                    : 'border-line-hairline bg-transparent',
                )}
              >
                <div className="flex items-start gap-1.5">
                  <span
                    className="mt-1 size-1.5 shrink-0 rounded-full"
                    style={{ background: colorOf(statusOfToast(item.kind)) }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-fg-primary">
                      {item.title}
                      <span className="ml-1.5 text-2xs text-fg-tertiary">{ago(item.at, now)}</span>
                    </p>
                    {item.description ? (
                      <p className="mt-0.5 whitespace-pre-line break-words text-2xs text-fg-secondary">
                        {item.description}
                      </p>
                    ) : null}
                    {item.action ? (
                      <button
                        type="button"
                        onClick={item.action?.run}
                        className="mt-1 rounded-sm border border-line-subtle bg-bg-raised px-2 py-0.5 text-2xs text-fg-primary transition-colors duration-fast hover:bg-bg-active"
                      >
                        {item.action.label}
                      </button>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(item.id)}
                    aria-label="从通知里去掉这一条"
                    title="去掉这一条"
                    className="shrink-0 rounded p-0.5 text-fg-tertiary opacity-0 transition-opacity hover:text-fg-primary group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
