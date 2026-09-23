/* ══════════════════════════════════════════════════════════════
   模型能力的类型

   和 electron/core/provider-capabilities.cjs 的 `DIMENSIONS` **一一对应** ——
   加维度要四处一起改：内核 DIMENSIONS、内核 LABELS、provider-presets.cjs、这里。

   ⚠️ 值是**声明**（内置预设 / 用户手填），**不是探测结果**。要真知道某个模型
   支不支持图片，得发一条带图的真实请求，那需要联网 —— 内核自检不联网，所以没做。
   ══════════════════════════════════════════════════════════════ */

/** 能力维度名（业界通用叫法，不自己造词） */
export type CapabilityDim =
  | 'chat'
  | 'streaming'
  | 'tool_call'
  | 'vision'
  | 'structured_output'
  | 'reasoning'
  | 'context_window'
  | 'max_output'
  | 'attachments'
  | 'search'

/**
 * 单个模型的能力。
 *
 * **`null` 是「未知」，不是「不支持」** —— 界面上必须把这两者画得不一样，
 * 否则等于我们替用户猜了一个答案，而这个项目最讨厌「声明了但没强制」的含糊。
 */
export interface ModelCapabilities {
  chat: boolean | null
  streaming: boolean | null
  tool_call: boolean | null
  vision: boolean | null
  structured_output: boolean | null
  reasoning: boolean | null
  /** token 数；null = 未知 */
  context_window: number | null
  /** token 数；null = 未知 */
  max_output: number | null
  attachments: boolean | null
  search: boolean | null
}

export interface ModelCapabilityInfo {
  caps: ModelCapabilities
  /** 每个维度这一票是谁投的：用户手填 / 内置预设 / 未知 */
  source: Partial<Record<CapabilityDim, 'override' | 'preset' | 'unknown'>>
  /** 命中哪条内置预设；null = 没有这个模型的预设 */
  preset: string | null
  /** 那条预设的依据（写给人看的） */
  presetNote: string
}

/** 主进程算好的能力矩阵，跟着 config:get 一起下发（只读） */
export interface ProviderCapabilityMatrix {
  dims: CapabilityDim[]
  labels: Record<CapabilityDim, string>
  /** 哪几个维度是数字（token 数）而不是布尔 */
  numeric: CapabilityDim[]
  models: Record<string, ModelCapabilityInfo>
  /** 「这是声明与预设，不是探测」那句话，主进程给的原文，界面直接显示别自己写 */
  note: string
}
