import type { MemoryItem } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   结构化记忆的桥包装

   和别的 API 一样：失败不抛异常，返回空值。
   浏览器预览没有桥，界面那边会显示「需要桌面版」。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

export function memorySupported(): boolean {
  return Boolean(bridge?.memoryList)
}

export async function memoryList(options?: {
  status?: string
  scope?: string
  type?: string
  includeSuperseded?: boolean
}): Promise<MemoryItem[]> {
  if (!bridge?.memoryList) return []
  try {
    const result = await bridge.memoryList(options)
    return result.items ?? []
  } catch {
    return []
  }
}

export async function memorySearch(query: string): Promise<MemoryItem[]> {
  if (!bridge?.memorySearch) return []
  try {
    const result = await bridge.memorySearch(query)
    return result.items ?? []
  } catch {
    return []
  }
}

export async function memoryAdd(
  input: Partial<MemoryItem>,
): Promise<{ ok: boolean; item?: MemoryItem; error?: string; deduped?: boolean }> {
  if (!bridge?.memoryAdd) return { ok: false, error: '需要桌面版' }
  try {
    return await bridge.memoryAdd(input)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function memoryUpdate(id: string, patch: Partial<MemoryItem>): Promise<boolean> {
  if (!bridge?.memoryUpdate) return false
  try {
    const result = await bridge.memoryUpdate({ id, patch })
    return result.ok
  } catch {
    return false
  }
}

export async function memoryDisable(id: string): Promise<void> {
  try {
    await bridge?.memoryDisable?.(id)
  } catch {
    /* 忽略 */
  }
}

export async function memoryEnable(id: string): Promise<void> {
  try {
    await bridge?.memoryEnable?.(id)
  } catch {
    /* 忽略 */
  }
}

export async function memoryRemove(id: string): Promise<void> {
  try {
    await bridge?.memoryRemove?.(id)
  } catch {
    /* 忽略 */
  }
}
