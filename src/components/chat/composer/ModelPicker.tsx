import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Cpu, Search, Sparkles, Wand2 } from 'lucide-react'
import type { ReasoningLevel } from '@/types'
import { MODELS, REASONING_HINT, REASONING_LABEL } from '@/constants'
import { Popover } from '@/components/ui/Popover'
import { useConfigStore } from '@/stores/useConfigStore'
import { cn } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   模型 + 推理档位选择器（级联）

   左边一栏是供应商，鼠标移上去右边就换成那家的模型。
   为什么做成级联：中转站动不动上百个模型，平铺出来根本没法找 ——
   分家之后至少能按来源缩小范围，太多了还有搜索框。

   浏览器预览下没有真实配置，退回内置模型列表。
   ══════════════════════════════════════════════════════════════ */

const ALL_LEVELS: readonly ReasoningLevel[] = ['low', 'medium', 'high']
/** 模型多于这个数才出搜索框 —— 少的时候加了只是噪音 */
const SEARCH_THRESHOLD = 8

interface ProviderGroup {
  id: string
  name: string
  models: string[]
}

export function ModelPicker({
  model,
  reasoning,
  onModel,
  onReasoning,
}: {
  model: string
  reasoning: ReasoningLevel
  onModel: (id: string) => void
  onReasoning: (level: ReasoningLevel) => void
}) {
  const [open, setOpen] = useState(false)
  const [activeGroupId, setActiveGroupId] = useState('')
  const [pane, setPane] = useState<'models' | 'reasoning'>('models')
  const [query, setQuery] = useState('')

  const config = useConfigStore((s) => s.config)

  const groups: ProviderGroup[] = useMemo(
    () =>
      (config?.providers ?? []).map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: provider.models,
      })),
    [config],
  )
  const hasConfig = groups.length > 0

  /* 每次打开都定位到「当前模型属于哪家」，省得自己找 */
  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const owner = groups.find((group) => group.models.includes(model))
    setActiveGroupId(owner?.id ?? groups[0]?.id ?? '')
    setPane('models')
  }, [open, model, groups])

  const active = groups.find((group) => group.id === activeGroupId) ?? groups[0]
  const sourceModels = useMemo(
    () => (hasConfig ? (active?.models ?? []) : MODELS.map((m) => m.id)),
    [hasConfig, active],
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sourceModels
    return sourceModels.filter((id) => id.toLowerCase().includes(q))
  }, [sourceModels, query])

  const levels = hasConfig
    ? ALL_LEVELS
    : (MODELS.find((m) => m.id === model)?.reasoning ?? ALL_LEVELS)

  /** 换模型时，新模型不支持当前档位就落到它支持的最后一档 */
  function pickModel(id: string): void {
    onModel(id)
    if (!levels.includes(reasoning)) {
      onReasoning(levels[levels.length - 1] ?? 'medium')
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="end"
      /* min-w-0 / p-0：把默认的单栏内边距去掉，改成自己的两栏 */
      className="min-w-0 p-0"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          data-model-trigger="true"
          className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <Wand2 size={13} className="shrink-0" />
          <span className="font-medium text-fg-primary">{model}</span>
          <span className="text-fg-tertiary">{REASONING_LABEL[reasoning]}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      )}
    >
      <div className="flex">
        {/* ── 左栏：供应商 + 推理入口 ── */}
        <div className="flex w-40 shrink-0 flex-col border-r border-line-subtle p-1">
          <div className="min-h-0 flex-1 overflow-y-auto" style={{ maxHeight: '16rem' }}>
            {hasConfig ? (
              groups.map((group) => {
                const isActive = pane === 'models' && group.id === active?.id
                const ownsCurrent = group.models.includes(model)
                return (
                  <button
                    key={group.id}
                    type="button"
                    onMouseEnter={() => {
                      setActiveGroupId(group.id)
                      setPane('models')
                    }}
                    onFocus={() => {
                      setActiveGroupId(group.id)
                      setPane('models')
                    }}
                    onClick={() => {
                      setActiveGroupId(group.id)
                      setPane('models')
                    }}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-fast',
                      isActive
                        ? 'bg-bg-raised text-fg-primary'
                        : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                    )}
                  >
                    <span className="w-3 shrink-0">
                      {ownsCurrent ? (
                        <Check size={12} style={{ color: 'var(--accent-blue)' }} />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={group.name}>
                      {group.name}
                    </span>
                    <ChevronRight size={12} className="shrink-0 opacity-50" />
                  </button>
                )
              })
            ) : (
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded-sm bg-bg-raised px-2 py-1.5 text-left text-sm text-fg-primary"
              >
                <span className="w-3 shrink-0" />
                <span className="min-w-0 flex-1">内置模型</span>
                <ChevronRight size={12} className="shrink-0 opacity-50" />
              </button>
            )}
          </div>

          <div className="my-1 h-px shrink-0 bg-line-subtle" role="separator" />

          <button
            type="button"
            onMouseEnter={() => setPane('reasoning')}
            onFocus={() => setPane('reasoning')}
            onClick={() => setPane('reasoning')}
            className={cn(
              'flex w-full shrink-0 items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-fast',
              pane === 'reasoning'
                ? 'bg-bg-raised text-fg-primary'
                : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
            )}
          >
            <Sparkles size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">推理</span>
            <span className="shrink-0 text-2xs text-fg-tertiary">{REASONING_LABEL[reasoning]}</span>
            <ChevronRight size={12} className="shrink-0 opacity-50" />
          </button>
        </div>

        {/* ── 右栏：模型列表 或 推理档位 ── */}
        <div className="flex w-56 shrink-0 flex-col">
          {pane === 'reasoning' ? (
            <div className="p-1">
              {ALL_LEVELS.map((level) => {
                const supported = levels.includes(level)
                return (
                  <button
                    key={level}
                    type="button"
                    disabled={!supported}
                    onClick={() => {
                      onReasoning(level)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-fast',
                      reasoning === level
                        ? 'bg-bg-raised text-fg-primary'
                        : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                      !supported && 'cursor-not-allowed opacity-40',
                    )}
                  >
                    <span className="shrink-0">{REASONING_LABEL[level]}</span>
                    <span className="min-w-0 flex-1 truncate text-2xs text-fg-tertiary">
                      {REASONING_HINT[level]}
                    </span>
                    {reasoning === level ? (
                      <Check
                        size={12}
                        className="shrink-0"
                        style={{ color: 'var(--accent-blue)' }}
                      />
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : (
            <>
              {sourceModels.length > SEARCH_THRESHOLD || query ? (
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

              <div className="min-h-0 flex-1 overflow-y-auto p-1" style={{ maxHeight: '16rem' }}>
                {shown.length === 0 ? (
                  <p className="px-2 py-3 text-center text-2xs text-fg-tertiary">没有匹配的模型</p>
                ) : (
                  shown.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        pickModel(id)
                        setOpen(false)
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-fast',
                        id === model
                          ? 'bg-bg-raised text-fg-primary'
                          : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                      )}
                    >
                      <Cpu size={13} className="shrink-0 text-fg-tertiary" />
                      <span className="min-w-0 flex-1 truncate font-mono" title={id}>
                        {id}
                      </span>
                      {id === model ? (
                        <Check
                          size={12}
                          className="shrink-0"
                          style={{ color: 'var(--accent-blue)' }}
                        />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Popover>
  )
}
