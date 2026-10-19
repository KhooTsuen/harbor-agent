import { useState } from 'react'
import { Check, ChevronRight, Cpu, Search } from 'lucide-react'
import type { ReasoningLevel } from '@/types'
import { REASONING_LABEL } from '@/constants'
import { cn } from '@/lib/utils'
import type { CollabValue, Pickable, Role } from './collabOptions'

/* ══════════════════════════════════════════════════════════════
   选择器面板的左右两栏（从 CollabPicker.tsx 拆出来 —— 那边 360 行）

   左栏 = 供应商（单模型）或 A/B 预览（双模型）+ 底部切换条
   右栏 = 模型列表（可搜）+ 单模型时的推理档位

   两栏都**不判断**谁能当角色、谁可用 —— 那些判据在 collabOptions.ts，
   这里拿到什么就画什么，禁用项连理由一起显示。
   ══════════════════════════════════════════════════════════════ */

/** 模型多于这个数才出搜索框；少的时候加了只是噪音 */
const SEARCH_THRESHOLD = 8
const LEVELS: readonly ReasoningLevel[] = ['low', 'high', 'max']

export function SourceColumn({
  collab,
  planner,
  executor,
  choosing,
  onChoose,
  groups,
  activeId,
  model,
  onProvider,
  modeHint,
  onSwitchMode,
}: {
  collab: CollabValue
  planner?: Pickable
  executor?: Pickable
  choosing: Role
  onChoose: (role: Role) => void
  groups: Array<{ id: string; name: string; models: string[] }>
  activeId: string
  model: string
  onProvider: (id: string) => void
  modeHint: string
  onSwitchMode: () => void
}): React.JSX.Element {
  return (
    <div className="flex w-44 shrink-0 flex-col border-r border-line-subtle p-2">
      {collab ? (
        <>
          <div className="px-1 py-1.5 text-sm font-medium text-fg-primary">这是双模型状态选择</div>
          {(['planner', 'executor'] as const).map((role) => {
            const selected = role === 'planner' ? planner : executor
            return (
              <button
                key={role}
                type="button"
                aria-expanded={choosing === role}
                onClick={() => onChoose(role)}
                className={cn(
                  'mb-2 rounded-md border border-line-subtle px-2 py-2 text-left transition-colors hover:bg-bg-hover',
                  choosing === role && 'bg-bg-raised',
                )}
              >
                <span className="block text-xs text-fg-tertiary">
                  {role === 'planner' ? '模型 A 预览' : '模型 B 预览'}
                </span>
                <span className="mt-0.5 block truncate text-sm text-fg-primary">
                  {selected?.label ?? '未选择'}
                </span>
                <span className="mt-0.5 block text-2xs text-fg-tertiary">
                  选择{role === 'planner' ? ' A 时 B 选项显示不可选' : ' B 时 A 选项显示不可选'}
                </span>
              </button>
            )
          })}
        </>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ maxHeight: '16rem' }}
          aria-label="供应商"
        >
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => onProvider(group.id)}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-sm px-2 py-2 text-left text-sm transition-colors',
                group.id === activeId
                  ? 'bg-bg-raised text-fg-primary'
                  : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
              )}
            >
              <span className="w-3 shrink-0">
                {group.models.includes(model) ? <Check size={12} /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate" title={group.name}>
                {group.name}
              </span>
              <ChevronRight size={12} className="shrink-0 opacity-50" />
            </button>
          ))}
          {groups.length === 0 ? (
            <p className="px-2 py-3 text-xs text-fg-tertiary">尚未配置供应商</p>
          ) : null}
        </div>
      )}
      {/* 单 / 双模型切换 —— **永远可点**：缺条件时告诉用户缺什么，而不是变灰 */}
      <button
        type="button"
        aria-label={collab ? '切换为单模型' : '切换为双模型'}
        onClick={onSwitchMode}
        className="mt-auto w-full rounded-md border border-line-subtle px-2 py-2 text-center text-sm text-fg-primary transition-colors hover:bg-bg-hover"
      >
        {modeHint}
      </button>
    </div>
  )
}

export function ModelColumn({
  collab,
  title,
  rows,
  activeKey,
  otherKey,
  model,
  onPick,
  reasoning,
  onReasoning,
}: {
  collab: CollabValue
  title: string
  rows: Pickable[]
  activeKey?: string
  otherKey?: string
  model: string
  onPick: (option: Pickable) => void
  reasoning: ReasoningLevel
  onReasoning: (level: ReasoningLevel) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLowerCase()
  const shown = keyword ? rows.filter((row) => row.label.toLowerCase().includes(keyword)) : rows

  return (
    <div className="flex min-w-0 flex-1 flex-col p-2">
      <div className="mb-1 px-2 text-xs text-fg-tertiary">{title}</div>
      {rows.length > SEARCH_THRESHOLD || query ? (
        <div className="shrink-0 px-1 pb-1">
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
              className="w-full rounded-sm border border-line-subtle bg-bg-input py-1 pl-6 pr-2 text-xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
            />
          </div>
        </div>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ maxHeight: '16rem' }}
        role={collab ? 'listbox' : undefined}
        aria-label={collab ? title : '模型列表'}
      >
        {shown.map((option) => {
          const selected = collab ? option.key === activeKey : option.model === model
          const blocked = collab ? option.disabled || option.key === otherKey : false
          return (
            <button
              key={option.key}
              type="button"
              disabled={blocked}
              title={option.reason || (option.key === otherKey ? '该模型已被另一角色选择' : '')}
              onClick={() => onPick(option)}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm transition-colors',
                selected
                  ? 'bg-bg-raised text-fg-primary'
                  : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary',
                blocked && 'cursor-not-allowed opacity-40',
              )}
            >
              <Cpu size={13} className="shrink-0 text-fg-tertiary" />
              <span className="min-w-0 flex-1 truncate" title={option.label}>
                {option.label}
              </span>
              {selected ? <Check size={12} className="shrink-0" /> : null}
            </button>
          )
        })}
        {shown.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-fg-tertiary">没有可选模型</p>
        ) : null}
      </div>
      {!collab ? (
        <div className="mt-2 border-t border-line-subtle pt-2">
          <div className="mb-1 px-2 text-2xs text-fg-tertiary">推理强度</div>
          <div className="flex gap-1">
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => onReasoning(level)}
                className={cn(
                  'flex-1 rounded-sm px-1 py-1 text-2xs',
                  reasoning === level
                    ? 'bg-bg-raised text-fg-primary'
                    : 'text-fg-tertiary hover:bg-bg-hover',
                )}
              >
                {REASONING_LABEL[level]}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
