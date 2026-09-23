import type {
  CapabilityDim,
  ModelCapabilityInfo,
  ProviderCapabilityMatrix,
} from '@/types/backend'

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
): ModelCapabilityInfo | undefined {
  return matrix?.models[model.trim()]
}
