import type { BalanceResult, WorkbenchBridge } from '@/types/backend'

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

/* ══════════════════════════════════════════════════════════════
   账户余额（DeepSeek 专有）

   ★ **只由用户点击触发** —— 内核不缓存、不轮询，这里也绝不放进 useEffect。
     每次调用 = 一次真实请求（会花一点点流量，也可能被限速）。

   注意**不在这里记「上次查询时间」**：那是界面的瞬时提示（只存内存、不落盘），
   由卡片自己持有 —— 放这里会变成模块级状态，跨会话残留、还不好清。
   ══════════════════════════════════════════════════════════════ */
export async function providerBalance(providerId?: string): Promise<BalanceResult> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持查询余额，请使用桌面版' }
  try {
    return await bridge.providerBalance(providerId)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
