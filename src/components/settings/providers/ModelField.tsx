import { useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Cpu, Search, Trash2 } from 'lucide-react'
import type { ProviderConfig } from '@/types/backend'
import { Popover } from '@/components/ui/Popover'
import { IconButton } from '@/components/ui/IconButton'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import { cn } from '@/lib/utils'
import { diagnoseModel, modelAfterRemoval } from '@/lib/modelCheck'
import { STATUS_CLASS, colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   模型输入框

   三件事：
     · 能直接打字（中转站新上线的模型还没进清单时用得上）
     · 能下拉挑（按供应商分组 + 搜索）
     · 能删（把当前这个模型从所属供应商的清单里去掉）

   顺带把「用户输错了」的情况说清楚 —— 光秃秃一个输入框，
   用户打错一个字就得自己猜为什么发不出消息。
   ══════════════════════════════════════════════════════════════ */

/** 模型多于这个数才出搜索框 */
const SEARCH_THRESHOLD = 8

export interface ModelFieldProps {
  value: string
  onChange: (value: string) => void
  providers: readonly ProviderConfig[]
}

export function ModelField({ value, onChange, providers }: ModelFieldProps) {
  const updateProvider = useConfigStore((s) => s.updateProvider)
  const showToast = useUIStore((s) => s.showToast)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => providers.filter((p) => p.models.length > 0), [providers])
  const allModels = useMemo(() => [...new Set(providers.flatMap((p) => p.models))], [providers])

  const trimmed = value.trim()
  const owner = providers.find((p) => p.models.includes(trimmed))
  const searchable = allModels.length > SEARCH_THRESHOLD

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter((m) => m.toLowerCase().includes(q)),
      }))
      .filter((group) => group.models.length > 0)
  }, [groups, query])

  const problem = useMemo(() => diagnoseModel(value, providers), [value, providers])

  /** 把当前模型从所属供应商的清单里删掉 */
  async function removeModel(): Promise<void> {
    const target = owner ?? providers.find((p) => p.enabled) ?? providers[0]
    if (!target) {
      showToast('error', '没有供应商', '先去上面加一个')
      return
    }

    const next = target.models.filter((m) => m !== trimmed)
    await updateProvider(target.id, { models: next })

    /* 删掉的正好是当前在用的 —— 得换一个，不然设置里挂着一个不存在的模型 */
    const fallback = modelAfterRemoval(value, trimmed, next)
    if (fallback !== value) onChange(fallback)
    showToast('success', '已从清单删掉', `${trimmed}（${target.name}）`)
  }

  return (
    <div>
      <div className="flex gap-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="选择或直接输入模型名"
          spellCheck={false}
          aria-label="模型名"
          aria-invalid={problem !== null}
          className={cn(
            'min-w-0 flex-1 rounded-base border bg-bg-surface px-2.5 py-1.5 font-mono text-dense text-fg-primary',
            'placeholder:text-fg-tertiary focus:outline-none',
            problem ? STATUS_CLASS.warning.border : 'border-line-hairline focus:border-line-focus',
          )}
        />

        <Popover
          open={open}
          onOpenChange={setOpen}
          side="bottom"
          align="end"
          className="min-w-0 p-0"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-label="从清单里选"
              aria-expanded={open}
              className="flex h-full items-center rounded-base border border-line-hairline bg-bg-surface px-2 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
            >
              <ChevronDown size={12} />
            </button>
          )}
        >
          <div className="flex w-64 flex-col">
            {searchable || query ? (
              <div className="shrink-0 p-1 pb-0">
                <div className="relative">
                  <Search
                    size={12}
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-tertiary"
                  />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜模型"
                    aria-label="搜索模型"
                    spellCheck={false}
                    className="w-full rounded-sm border border-line-subtle bg-bg-raised/60 py-1 pl-6 pr-2 text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
                  />
                </div>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto p-1" style={{ maxHeight: '15rem' }}>
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-2xs text-fg-tertiary">
                  {groups.length === 0 ? '还没有配置模型清单' : '没有匹配的模型'}
                </p>
              ) : (
                filtered.map((group, index) => (
                  <div key={group.id}>
                    <div
                      className={cn(
                        'px-2 pb-1 text-2xs uppercase tracking-wide text-fg-tertiary',
                        index === 0 ? 'pt-1' : 'pt-2',
                      )}
                    >
                      {group.name}
                      {group.enabled ? null : '（已停用）'}
                    </div>
                    {group.models.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          onChange(m)
                          setOpen(false)
                          setQuery('')
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-fast',
                          m === trimmed
                            ? 'bg-bg-raised text-fg-primary'
                            : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                        )}
                      >
                        <Cpu size={12} className="shrink-0 text-fg-tertiary" />
                        <span className="min-w-0 flex-1 truncate font-mono" title={m}>
                          {m}
                        </span>
                        {m === trimmed ? (
                          <Check
                            size={12}
                            className="shrink-0"
                            style={{ color: 'var(--accent-blue)' }}
                          />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </Popover>

        <IconButton
          label="从清单里删掉这个模型"
          size={28}
          disabled={!trimmed}
          onClick={() => void removeModel()}
        >
          <Trash2 size={13} />
        </IconButton>
      </div>

      {problem ? (
        <p
          className="mt-1 flex items-start gap-1 text-2xs"
          style={{ color: colorOf('warning') }}
          role="status"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>{problem}</span>
        </p>
      ) : (
        <p className="mt-1 text-2xs text-fg-tertiary">
          清单里没有的可以直接打字；右侧按钮把它从清单里删掉
        </p>
      )}
    </div>
  )
}
