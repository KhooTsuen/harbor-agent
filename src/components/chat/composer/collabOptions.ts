import type { ProviderConfig } from '@/types/models'

/* ══════════════════════════════════════════════════════════════
   单模型 / 双模型选择器的**判据层**（纯函数，不碰 React）

   从 CollabPicker.tsx 拆出来，两个理由：
     · 那边加完双模型预览已经过了 300 行红线；
     · 候选项怎么来、已选项怎么匹配、什么时候不可用 —— 这些是**规则**，
       值得脱离渲染单独钉住（测试直接调，不用起 DOM）。
   ══════════════════════════════════════════════════════════════ */

/** 两个角色：A = 指导（规划/验收），B = 工作（执行） */
export type Role = 'planner' | 'executor'

export type RoleValue = { kind: 'codex-cli' | 'openai'; model?: string; providerId?: string }
export type CollabValue = { planner?: RoleValue; executor?: RoleValue } | null

export interface Pickable {
  key: string
  kind: 'codex-cli' | 'openai'
  providerId: string
  providerName: string
  label: string
  /** openai 的模型名；codex-cli 恒为空（走 CLI 登录态，没有模型列表） */
  model?: string
  disabled: boolean
  reason: string
}

/**
 * 一个后端/模型能不能当这个角色。
 *
 * 三道判据，任何一道不过都**不能**悄悄放过（界面显示不可选 + 说原因）：
 *   ① 这个 kind 能不能胜任该角色（collab-config.cjs 声明的能力集合）；
 *   ② 主进程 capacity matrix 说它现在可用吗（装没装、登没登录）；
 *   ③ 供应商自己有没有被用户启用。
 */
export function buildOptions(
  providers: readonly ProviderConfig[],
  roleKinds: readonly string[],
  matrix: Record<string, boolean>,
): Pickable[] {
  const options: Pickable[] = []
  for (const provider of providers) {
    const kind: Pickable['kind'] = provider.kind === 'codex-cli' ? 'codex-cli' : 'openai'
    const wrongRole = !roleKinds.includes(kind)
    const notReady = matrix[kind] === false
    const base = {
      kind,
      providerId: provider.id,
      providerName: provider.name,
      disabled: wrongRole || notReady || !provider.enabled,
      reason: wrongRole
        ? `${provider.name} 不能胜任这个角色`
        : notReady
          ? `${provider.name} 现在不可用（检查安装或登录）`
          : !provider.enabled
            ? '该供应商未启用'
            : '',
    }
    if (kind === 'codex-cli') {
      options.push({ ...base, key: `${provider.id}:codex`, label: provider.name || 'Codex CLI' })
      continue
    }
    for (const model of provider.models ?? []) {
      options.push({
        ...base,
        key: `${provider.id}:${model}`,
        label: `${provider.name} · ${model}`,
        model,
      })
    }
  }
  return options
}

/** 已保存的选择（可能残缺/来自旧数据）→ 可用的角色值 */
export function roleValue(value: RoleValue | undefined): RoleValue {
  return value?.kind === 'openai' || value?.kind === 'codex-cli' ? value : { kind: 'openai' }
}

/**
 * 已保存的选择 → 候选项。
 * 找不到（供应商/模型被删了）就退回第一项 —— 界面不能空着，但也**不假装**
 * 用户选的还在（下一轮 pickRole 会把它覆盖成真实存在的那个）。
 */
export function matchRole(
  options: readonly Pickable[],
  value: RoleValue | undefined,
): Pickable | undefined {
  return (
    options.find(
      (item) =>
        item.kind === value?.kind &&
        (!value?.model || item.model === value.model) &&
        (!value?.providerId || item.providerId === value.providerId),
    ) ?? options[0]
  )
}

/** 两个角色的候选里，够不够凑出「两个不同的可用项」—— 双模型的最低前提 */
export function collabReady(
  plannerOpts: readonly Pickable[],
  executorOpts: readonly Pickable[],
): {
  ok: boolean
  available: number
  hint: string
} {
  const ready = [...plannerOpts, ...executorOpts].filter((item) => !item.disabled)
  const distinct = new Set(ready.map((item) => item.key)).size
  if (distinct >= 2) return { ok: true, available: distinct, hint: '' }
  return {
    ok: false,
    available: distinct,
    hint:
      distinct === 0
        ? '双模型需要两个可用模型；当前没有可用项，先去设置里配好模型'
        : '双模型需要两个「不同的」可用模型；当前只有 1 个',
  }
}

/** 第一个/第二个可用项（切到双模型时给 A、B 各挑一个默认值） */
export function defaultPair(
  plannerOpts: readonly Pickable[],
  executorOpts: readonly Pickable[],
): { planner: Pickable; executor: Pickable } | null {
  const first = plannerOpts.find((item) => !item.disabled)
  if (!first) return null
  const second = executorOpts.find((item) => !item.disabled && item.key !== first.key)
  return second ? { planner: first, executor: second } : null
}
