import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Users } from 'lucide-react'
import type { ReasoningLevel } from '@/types'
import { REASONING_LABEL } from '@/constants'
import { Popover } from '@/components/ui/Popover'
import { useConfigStore } from '@/stores/useConfigStore'
import { useUIStore } from '@/stores/useUIStore'
import {
  buildOptions,
  collabReady,
  defaultPair,
  matchRole,
  roleValue,
  type CollabValue,
  type Pickable,
  type Role,
  type RoleValue,
} from './collabOptions'
import { ModelColumn, SourceColumn } from './CollabPanels'

/* ══════════════════════════════════════════════════════════════
   单模型 / 双模型 共用一个面板（2026-10-19 按用户手绘参考图重排）

   · **单模型**：左栏供应商，右栏这家供应商的模型（多了能搜），底部还有推理档位。
   · **双模型**：左栏变成「模型 A 预览 / 模型 B 预览」，点哪块右栏就选哪个；
     右栏里**另一个角色已经选中的那一项**显式禁用并写清原因（参考图要求的互斥）。
   · 底部切换条**永远可点**：凑不出两个可用模型时不变灰，而是点了告诉你缺什么 ——
     「点了没反应」比报错更难排查（用户 2026-10-19 截图报的就是这个）。

   判据在 ./collabOptions.ts，两栏的渲染在 ./CollabPanels.tsx，
   这里只留状态、事件与装配（单文件 300 行红线）。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined
/** A/B 能胜任的后端 kind —— 与内核 collab-config.cjs 的 ROLES 同一口径 */
const ROLE_KINDS = ['codex-cli', 'openai'] as const

function toRole(option: Pickable): RoleValue {
  return option.kind === 'openai'
    ? { kind: 'openai', model: option.model, providerId: option.providerId }
    : { kind: 'codex-cli', providerId: option.providerId }
}

export function CollabPicker({
  collab,
  model,
  reasoning,
  onModel,
  onReasoning,
  onChange,
  onClear,
}: {
  collab: CollabValue
  model: string
  reasoning: ReasoningLevel
  onModel: (id: string) => void
  onReasoning: (level: ReasoningLevel) => void
  onChange: (c: { planner?: RoleValue; executor?: RoleValue }) => void
  onClear?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [choosing, setChoosing] = useState<Role>('planner')
  const [providerId, setProviderId] = useState('')
  const [matrix, setMatrix] = useState<Record<string, boolean>>({})
  const providers = useConfigStore((s) => s.config?.providers ?? [])
  const showToast = useUIStore((s) => s.showToast)

  const groups = useMemo(
    () => providers.map((p) => ({ id: p.id, name: p.name, models: p.models ?? [] })),
    [providers],
  )

  /* 能力矩阵：谁现在真的能用（装没装 / 登没登录）。拿不到就**不误禁用**。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const result = await bridge?.collabStatus?.()
        if (alive && result?.ok && result.state?.matrix) setMatrix(result.state.matrix)
      } catch {
        /* 状态不可用时不拦人 */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /* 每次打开都定位到「当前模型属于哪家」；双模型回到选 A */
  useEffect(() => {
    if (!open) return
    if (!collab) {
      setProviderId(groups.find((g) => g.models.includes(model))?.id ?? groups[0]?.id ?? '')
      return
    }
    setChoosing('planner')
  }, [open, model, collab, groups])

  const options = useMemo(() => buildOptions(providers, ROLE_KINDS, matrix), [providers, matrix])
  const readiness = useMemo(() => collabReady(options, options), [options])
  const planner = matchRole(options, collab?.planner)
  const executor = matchRole(options, collab?.executor)
  const activeRole = choosing === 'planner' ? planner : executor
  const otherRole = choosing === 'planner' ? executor : planner
  const activeProvider = groups.find((g) => g.id === providerId) ?? groups[0]

  /** 右栏要显示的行：双模型 = 全部候选；单模型 = 当前供应商的模型 */
  const rows: Pickable[] = collab
    ? options
    : (activeProvider?.models ?? []).map((id) => ({
        key: `${activeProvider?.id}:${id}`,
        kind: 'openai' as const,
        providerId: activeProvider?.id ?? '',
        providerName: activeProvider?.name ?? '',
        label: id,
        model: id,
        disabled: false,
        reason: '',
      }))

  function pickRole(role: Role, option: Pickable): void {
    if (option.disabled || option.key === otherRole?.key) return
    onChange({
      planner: role === 'planner' ? toRole(option) : roleValue(collab?.planner),
      executor: role === 'executor' ? toRole(option) : roleValue(collab?.executor),
    })
  }

  /** 底部那条：单 → 双（挑一对默认值并开总开关）；双 → 单（清掉 A/B） */
  async function switchMode(): Promise<void> {
    if (collab) {
      onClear?.()
      return
    }
    const pair = defaultPair(options, options)
    if (!pair) {
      showToast('info', '还不能用双模型', readiness.hint)
      return
    }
    const status = await bridge?.collabStatus?.()
    if (status?.state?.enabled === false) {
      const turned = await bridge?.collabSet?.({ enabled: true })
      if (!turned?.ok) {
        showToast('error', '没能开启双模型', turned?.error ?? '请在设置 → 扩展里打开双模型协作')
        return
      }
    }
    onChange({ planner: toRole(pair.planner), executor: toRole(pair.executor) })
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="end"
      className="min-w-0 p-0"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={collab ? '多模型协作（已开启）' : '选择模型'}
          className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <Users size={13} className="shrink-0" />
          <span className="max-w-48 truncate font-medium text-fg-primary">
            {collab
              ? `${planner?.label ?? '模型 A'} / ${executor?.label ?? '模型 B'}`
              : model || '选择模型'}
          </span>
          {!collab ? <span className="text-fg-tertiary">{REASONING_LABEL[reasoning]}</span> : null}
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      )}
    >
      <div className="flex w-[34rem] max-w-[calc(100vw-2rem)]">
        <SourceColumn
          collab={collab}
          planner={planner}
          executor={executor}
          choosing={choosing}
          onChoose={setChoosing}
          groups={groups}
          activeId={activeProvider?.id ?? ''}
          model={model}
          onProvider={setProviderId}
          modeHint={
            collab ? '切换为单模型' : readiness.ok ? '切换为双模型' : '双模型还差一个可用模型'
          }
          onSwitchMode={() => void switchMode()}
        />
        <ModelColumn
          /* 换角色 / 换模式都换个 key：搜索框和滚动位置跟着重置 */
          key={collab ? `collab-${choosing}` : 'single'}
          collab={collab}
          title={
            collab
              ? `选择模型 ${choosing === 'planner' ? 'A' : 'B'}（另一角色已选项不可用）`
              : (activeProvider?.name ?? '模型列表')
          }
          rows={rows}
          activeKey={activeRole?.key}
          otherKey={otherRole?.key}
          model={model}
          onPick={(option) => {
            if (collab) pickRole(choosing, option)
            else {
              onModel(option.model ?? '')
              setOpen(false)
            }
          }}
          reasoning={reasoning}
          onReasoning={onReasoning}
        />
      </div>
    </Popover>
  )
}
