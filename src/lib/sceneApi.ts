import type { SceneStatus } from '@/types/models'

/* ══════════════════════════════════════════════════════════════
   场景能力的桥包装

   六个场景：起标题 / 优化提示词 / 翻译 / 建议回复 / OCR / 画图。
   都是「一次调用一次结果」，不涉及流式。

   没有桥（浏览器预览）时返回失败而不是抛异常 —— 调用方照常处理就行。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

/** 服务端没配就统一给这句，省得每个调用点各写一遍 */
const NO_BRIDGE = '浏览器预览没有真实模型，请使用桌面版'

export interface MessageDigest {
  role: string
  content: string
}

export async function sceneSnapshot(): Promise<{
  scenes: SceneStatus[]
  providers: Array<{ providerId: string; providerName: string; enabled: boolean; models: string[] }>
} | null> {
  if (!bridge) return null
  try {
    return await bridge.sceneSnapshot()
  } catch {
    return null
  }
}

/** 根据对话内容起一个短标题 */
export async function sceneTitle(
  messages: readonly MessageDigest[],
): Promise<{ ok: boolean; title?: string; error?: string }> {
  if (!bridge) return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.sceneTitle([...messages])
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 把一句话改写成更清晰的指令 */
export async function sceneOptimize(
  text: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!bridge) return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.sceneOptimize(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 翻译（中文→英文，其他→中文） */
export async function sceneTranslate(
  text: string,
): Promise<{ ok: boolean; text?: string; target?: string; error?: string }> {
  if (!bridge) return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.sceneTranslate(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 生成几条可以点的后续问题 */
export async function sceneSuggest(
  messages: readonly MessageDigest[],
): Promise<{ ok: boolean; suggestions?: string[]; error?: string }> {
  if (!bridge) return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.sceneSuggest([...messages])
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 图片转文字 */
export async function sceneOcr(
  imageDataUrl: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!bridge) return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.sceneOcr(imageDataUrl)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 按描述生成图片，返回可直接放 <img src> 的地址（data URL 或 http URL） */
export async function sceneImage(
  prompt: string,
  size?: string,
): Promise<{ ok: boolean; image?: string; model?: string; error?: string }> {
  if (!bridge) return { ok: false, error: NO_BRIDGE }
  try {
    return await bridge.sceneImage(prompt, size)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
