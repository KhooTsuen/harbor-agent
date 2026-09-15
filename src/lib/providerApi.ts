import type { WorkbenchBridge } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   供应商相关的桥包装

   从 backend.ts 拆出来的 —— 那边已经 300 行打不住了。
   backend.ts 会把这些再转发出去，所以外部 import 路径不用改。
   ══════════════════════════════════════════════════════════════ */

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

/** 测连接：发一条极短的消息，看服务端认不认这个 Key */
export async function pingProvider(
  providerId?: string,
): Promise<{ ok: boolean; model?: string; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持真实连接，请使用桌面版' }
  try {
    return await bridge.pingProvider(providerId)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 拉供应商的模型清单（OpenAI 兼容的 GET /models）。
 *
 * 中转站动辄上百个模型，让人一个个手打进「模型列表」不现实。
 */
export async function listProviderModels(
  providerId?: string,
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持拉取模型，请使用桌面版' }
  try {
    return await bridge.listModels(providerId)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
