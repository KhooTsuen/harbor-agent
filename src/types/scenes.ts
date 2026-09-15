/* ══════════════════════════════════════════════════════════════
   场景类型

   从 models.ts 拆出来的：那边是配置/会话/统计的通用形状，
   这里是「默认模型与提示词」专用的。
   ══════════════════════════════════════════════════════════════ */

/** 场景 id（和 electron/core/scene.cjs 的 SCENES 对应） */
export type SceneId =
  'chat' | 'title' | 'prompt' | 'translate' | 'suggest' | 'compact' | 'ocr' | 'image'

/** 一个场景指定的模型；providerId 和 model 都为空 = 用默认 */
export interface SceneConfig {
  providerId: string
  model: string
}

export type SceneMap = Record<SceneId, SceneConfig>

/** 一个场景现在的配置与生效情况（设置页展示用） */
export interface SceneStatus {
  id: SceneId
  providerId: string
  model: string
  effectiveProviderId: string
  effectiveProviderName: string
  effectiveModel: string
  /** true = 没单独配，用的是默认聊天模型 */
  fallback: boolean
}
