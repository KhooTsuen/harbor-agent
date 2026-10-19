import type { CapabilityDim, ModelCapabilityInfo, ProviderCapabilityMatrix } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   「这个模型干得了这活吗」—— 提前警告用的纯函数

   抽成纯函数是为了能单测：判断逻辑和「警告条长什么样」是两回事。

   两条口径（很重要）：
     · **只在那件事真的会失败时才警告**。乱报的警告比不报更糟 —— 用户会学会
       无视它，于是真出问题时也看不见。
     · `false`（明确不支持）说「会失败」；`null`（未知）只能说「说不准」。
       两者措辞必须分开，因为这个项目最讨厌「把猜的当成确定的」。
   ══════════════════════════════════════════════════════════════ */

export interface CapabilityGap {
  dim: CapabilityDim
  /** 给人看的维度名（来自内核的 labels，不在前端另起一套） */
  label: string
  /** 'no' = 明确不支持；'unknown' = 没有依据（未知） */
  kind: 'no' | 'unknown'
}

/**
 * 这次任务需要哪些能力。
 *
 * 只算**真的会改变请求内容**的两项：
 *   · 带了图 → 需要 vision（内容会变成多模态数组，纯文本模型直接报错）
 *   · 开着工具 → 需要 tool_call（工具定义会进请求，不支持的模型要么报错、
 *     要么把工具参数当普通文本吐出来）
 * 其余维度（search / attachments 之类）在这轮里不是硬需求，不列。
 */
export function needsFor(input: { hasImages: boolean; toolsOn: boolean }): CapabilityDim[] {
  const needs: CapabilityDim[] = []
  if (input.hasImages) needs.push('vision')
  if (input.toolsOn) needs.push('tool_call')
  return needs
}

/** 按「这次需要的能力」找出缺口；`false` 归 no，`null` 归 unknown，`true` 不算缺口 */
export function capabilityGaps(
  info: ModelCapabilityInfo | undefined,
  labels: Record<CapabilityDim, string> | undefined,
  needs: readonly CapabilityDim[],
): CapabilityGap[] {
  if (!info || !labels) return []

  const gaps: CapabilityGap[] = []
  for (const dim of needs) {
    const value = info.caps[dim]
    if (value === false) gaps.push({ dim, label: labels[dim] ?? dim, kind: 'no' })
    else if (value === null) gaps.push({ dim, label: labels[dim] ?? dim, kind: 'unknown' })
  }
  return gaps
}

export interface CapabilityWarning {
  /** warn = 很可能失败；info = 说不准（只是提醒，不是拦） */
  level: 'warn' | 'info'
  text: string
}

/**
 * 把缺口写成一句话（没有缺口返回 null）。
 *
 * 措辞里带「据预设」，不许出现「已检测/不支持」这种像实测过的说法。
 */
export function explainGaps(input: {
  model: string
  gaps: readonly CapabilityGap[]
}): CapabilityWarning | null {
  if (input.gaps.length === 0) return null

  const hard = input.gaps.filter((gap) => gap.kind === 'no').map((gap) => gap.label)
  const soft = input.gaps.filter((gap) => gap.kind === 'unknown').map((gap) => gap.label)

  if (hard.length > 0) {
    return {
      level: 'warn',
      text: `据内置预设，${input.model} 不支持「${hard.join('、')}」—— 这轮很可能失败`,
    }
  }
  return {
    level: 'info',
    text: `说不准 ${input.model} 支不支持「${soft.join('、')}」（没有它的预设，也没手填）`,
  }
}

/** 从主进程下发的矩阵里取一个模型的条目（可读性包装，界面和测试都用它） */
export function infoOf(
  matrix: ProviderCapabilityMatrix | undefined,
  model: string,
  providerId?: string,
): ModelCapabilityInfo | undefined {
  const name = model.trim()
  return (providerId ? matrix?.providers?.[providerId]?.[name] : undefined) ?? matrix?.models[name]
}

/* ══════════════════════════════════════════════════════════════
   「这张图最后交给谁」—— 与内核**同一套判据**

   ★ 为什么必须收在这里（2026-10-18 修的真不一致）：
     内核 `core/collab-images.cjs` 的 `prepareRoles` 在多模型时会拿
     **另一个选中角色**当视觉辅助；而界面只算了 `scenes.ocr` 这一条，
     于是「A 能看图、B 不能、又没配 OCR」被误报成「无法读取图片」——
     用户按提示去配 OCR，其实根本不需要。

   内核那条链的优先级（`tools/read_image.cjs` 的 `visionTarget`）：
     ① 当前角色自己 openai + vision===true → 原图直接给它
     ② 另一角色 openai + vision===true（且地址/Key 齐）→ 它转成文字
     ③ `scenes.ocr` 配了可用视觉模型 → 它转成文字
     ④ 都没有 → 明确失败

   还有两条**容易漏**的内核细节，这里必须跟着：
     · `codex-cli` 即使被手填覆盖成 `vision:true`，内核也**不会**让它直接收图
       （`prepare` 的 direct 判据要求 `kind === 'openai'`）
     · ②③ 要真发得出请求才算数（`visionTarget` 查 `baseUrl` 与 `hasKey`）
   ══════════════════════════════════════════════════════════════ */

/** 一个角色（A / B / 单模型当前助手）—— 与 `collab-task.cjs` 的 resolveRoles 同形 */
export interface VisionRoleLike {
  label: string
  kind?: string
  model?: string
  providerId?: string
}

/** 供应商里判据用得到的几项（`forRenderer` 都会给） */
export interface VisionProviderLike {
  id?: string
  kind?: string
  enabled?: boolean
  baseUrl?: string
  hasKey?: boolean
  models?: string[]
}

/** 这个角色最后怎么拿到图 */
export interface VisionPlan {
  /** direct = 原图直接给它；helper = 由文字分析代替；none = 读不了 */
  mode: 'direct' | 'helper' | 'none'
  /** 走的是哪条路 —— 文案要分开说，别糊成一句 */
  via: 'self' | 'role' | 'ocr' | ''
}

/**
 * 按角色取供应商（口径对齐 `core/collab-task.cjs` 的 `providerForRole`）：
 * 必须存在、未禁用、kind 与选择一致、模型确实在这家名下。
 */
export function providerOfRole(
  providers: readonly VisionProviderLike[] | undefined,
  role: VisionRoleLike,
): VisionProviderLike | undefined {
  const id = String(role.providerId ?? '')
  if (!id) return undefined
  const hit = (providers ?? []).find((item) => item.id === id)
  if (!hit || hit.enabled === false) return undefined
  if (role.kind && hit.kind && hit.kind !== role.kind) return undefined
  if (role.kind === 'openai' && role.model && !(hit.models ?? []).includes(role.model))
    return undefined
  return hit
}

/** 内核 `visionTarget` 的口径：能真发出请求才算数（有地址、有 Key） */
function canSend(provider: VisionProviderLike | undefined): boolean {
  return Boolean(
    provider &&
    provider.enabled !== false &&
    String(provider.baseUrl ?? '').trim() &&
    provider.hasKey !== false,
  )
}

/** 这个角色自己能不能直接收图（只认 openai —— 见上面文件头那两条内核细节） */
function acceptsDirect(
  matrix: ProviderCapabilityMatrix | undefined,
  role: VisionRoleLike,
): boolean {
  if (role.kind !== 'openai') return false
  return infoOf(matrix, String(role.model ?? ''), role.providerId)?.caps.vision === true
}

/** 某个角色能不能当别人的视觉辅助 */
function usableAsHelper(
  matrix: ProviderCapabilityMatrix | undefined,
  providers: readonly VisionProviderLike[] | undefined,
  role: VisionRoleLike,
): boolean {
  if (role.kind !== 'openai') return false
  if (!canSend(providerOfRole(providers, role))) return false
  return infoOf(matrix, String(role.model ?? ''), role.providerId)?.caps.vision === true
}

/**
 * 算出一个角色的视觉路径。
 *
 * @param input.role   要判的角色
 * @param input.others 其余选中角色（多模型时是另一个；单模型传空数组）
 * @param input.ocr    `config.scenes.ocr`（第三顺位，与内核一致）
 */
export function visionPlanFor(input: {
  role: VisionRoleLike
  others?: readonly VisionRoleLike[]
  matrix: ProviderCapabilityMatrix | undefined
  providers?: readonly VisionProviderLike[]
  ocr?: { providerId?: string; model?: string }
}): VisionPlan {
  const { role, others, matrix, providers, ocr } = input
  if (acceptsDirect(matrix, role)) return { mode: 'direct', via: 'self' }

  for (const other of others ?? []) {
    if (other === role) continue
    if (usableAsHelper(matrix, providers, other)) return { mode: 'helper', via: 'role' }
  }

  const ocrModel = String(ocr?.model ?? '').trim()
  if (ocrModel) {
    const ocrProvider = (providers ?? []).find((item) => item.id === ocr?.providerId)
    if (canSend(ocrProvider) && infoOf(matrix, ocrModel, ocr?.providerId)?.caps.vision === true) {
      return { mode: 'helper', via: 'ocr' }
    }
  }
  return { mode: 'none', via: '' }
}
