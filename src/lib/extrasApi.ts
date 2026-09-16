import type {
  BackupInfo,
  McpServerStatus,
  MemoryStats,
  SearchConfig,
  StatsSummary,
} from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   记忆 / 搜索 / MCP 的桥包装

   和其他 API 一样：失败不抛异常，统一返回 { ok, error }。
   浏览器预览下返回空值而不是报错 —— 桌面版才具备这些本地能力。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

/* ── 记忆 ─────────────────────────────────────────────────── */

const EMPTY_STATS: MemoryStats = {
  total: 0,
  active: 0,
  disabled: 0,
  superseded: 0,
  byType: {},
  byScope: {},
  maxItems: 800,
}

export async function getMemory(): Promise<{ text: string; stats: MemoryStats }> {
  if (!bridge) return { text: '', stats: EMPTY_STATS }
  try {
    const result = await bridge.getMemory()
    return { text: result.text, stats: result.stats }
  } catch {
    return { text: '', stats: EMPTY_STATS }
  }
}

export async function setMemory(
  text: string,
): Promise<{ ok: boolean; stats?: MemoryStats; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持保存记忆，请使用桌面版' }
  try {
    return await bridge.setMemory(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function clearMemory(): Promise<{ ok: boolean }> {
  if (!bridge) return { ok: false }
  try {
    await bridge.clearMemory()
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/* ── 搜索 ─────────────────────────────────────────────────── */

export async function searchProviders(): Promise<
  Array<{ id: string; label: string; needKey: boolean }>
> {
  if (!bridge) return []
  try {
    return await bridge.searchProviders()
  } catch {
    return []
  }
}

export async function testSearch(
  override?: Partial<SearchConfig>,
): Promise<{ ok: boolean; count?: number; sample?: string; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持测试搜索，请使用桌面版' }
  try {
    return await bridge.testSearch(override)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ── MCP ──────────────────────────────────────────────────── */

export async function mcpStatus(): Promise<McpServerStatus[]> {
  if (!bridge) return []
  try {
    return await bridge.mcpStatus()
  } catch {
    return []
  }
}

export async function mcpRestart(): Promise<McpServerStatus[]> {
  if (!bridge) return []
  try {
    const result = await bridge.mcpRestart()
    return result.servers
  } catch {
    return []
  }
}

/* ── 用量统计 ─────────────────────────────────────────────── */

const EMPTY_SUMMARY: StatsSummary = {
  since: Date.now(),
  total: { prompt: 0, completion: 0, total: 0, calls: 0, cached: 0 },
  days: [],
  models: [],
  file: '',
}

export async function statsSummary(): Promise<StatsSummary> {
  if (!bridge) return EMPTY_SUMMARY
  try {
    return await bridge.statsSummary()
  } catch {
    return EMPTY_SUMMARY
  }
}

export async function statsReset(): Promise<boolean> {
  if (!bridge) return false
  try {
    const result = await bridge.statsReset()
    return result.ok
  } catch {
    return false
  }
}

/* ── 备份 ─────────────────────────────────────────────────── */

export async function backupList(): Promise<BackupInfo[]> {
  if (!bridge) return []
  try {
    return await bridge.backupList()
  } catch {
    return []
  }
}

export async function backupCreate(): Promise<{ ok: boolean; name?: string; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持备份，请使用桌面版' }
  try {
    return await bridge.backupCreate()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function backupRestore(name: string): Promise<{
  ok: boolean
  restored?: string[]
  safetyBackup?: string
  needsRestart?: boolean
  error?: string
}> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持恢复，请使用桌面版' }
  try {
    return await bridge.backupRestore(name)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function backupRemove(name: string): Promise<{ ok: boolean; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持删除备份，请使用桌面版' }
  try {
    return await bridge.backupRemove(name)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function backupOpen(): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持打开目录，请使用桌面版' }
  try {
    return await bridge.backupOpen()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
