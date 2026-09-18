import type {
  AppConfig,
  ChatSendPayload,
  SessionDetail,
  SessionSummary,
  ConversationSearchHit,
  StoredMessage,
  WorkbenchBridge,
} from '@/types/backend'
import type { Thread } from '@/types'
import { bridge, isElectron, useRealBackend } from './bridge'

/* 桥和环境判断住在 ./bridge.ts（拆出去是为了打破与 chatControl 的环）；
   中断/暂停住在 ./chatControl.ts。两边都从这儿 re-export，调用方不用改 import。 */
export { bridge, isElectron, useRealBackend }
export * from './chatControl'

/** 版本号：优先取环境变量，没有就用 package.json 里的 0.1.0 */
/* 版本号由 vite.config.ts 从 package.json 注入。兜底写「未知」而不是某个
 * 具体版本 —— 写 0.1.0 的话，注入失效时会静默显示一个看着合理但错的版本（踩过）。 */
export const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '未知'

function require(): WorkbenchBridge {
  if (!bridge) throw new Error('当前不在 Electron 环境里')
  return bridge
}

/* ── 配置 ─────────────────────────────────────────────────── */

export async function loadConfig(): Promise<AppConfig | null> {
  if (!bridge) return null
  try {
    return await bridge.getConfig()
  } catch {
    return null
  }
}

export async function pushConfig(patch: Record<string, unknown>): Promise<AppConfig | null> {
  if (!bridge || Object.keys(patch).length === 0) return null
  try {
    const result = await bridge.patchConfig(patch)
    return result.ok ? result.config : null
  } catch {
    return null
  }
}

/** 界面设置（主题/玻璃/字号…）回写给主进程的便捷包装 */
export async function pushGeneral(
  general: Partial<AppConfig['general']>,
): Promise<AppConfig | null> {
  return pushConfig({ general })
}

export async function resetConfig(): Promise<AppConfig | null> {
  if (!bridge) return null
  try {
    const result = await bridge.resetConfig()
    return result.ok ? result.config : null
  } catch {
    return null
  }
}

/* ── 工作目录 ─────────────────────────────────────────────── */

/* 工作目录相关（从 backend 拆出去过，免得这个文件过 300 行）*/
export { chooseFolder, getWorkdir, pickWorkdir } from './workdirApi'

export { listProviderModels, pingProvider } from './providerApi'

/* ── 对话 ─────────────────────────────────────────────────── */

/* 订阅类（subscribeChatEvents / subscribePluginChanges）在 lib/subscriptions.ts */
export { subscribeChatEvents, subscribePluginChanges } from './subscriptions'

export async function sendChat(
  payload: ChatSendPayload,
): Promise<{ ok: boolean; requestId?: string; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持真实模型，请使用桌面版' }
  try {
    return await bridge.sendChat(payload)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function selfTest() {
  return require().selfTest()
}

/* ── 会话（持久化）───────────────────────────────────────── */

export async function searchSessions(query: string, limit = 50): Promise<ConversationSearchHit[]> {
  if (!bridge) return []
  try {
    return await bridge.searchSessions(query, limit)
  } catch {
    return []
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (!bridge) return []
  try {
    return await bridge.listSessions()
  } catch {
    return []
  }
}

export { copyDiagnostics, saveDiagnostics } from './diagnosticsApi'

export async function listWorkdirs(): Promise<
  Array<{ workdir: string; count: number; lastUsedAt: number }>
> {
  if (!bridge) return []
  try {
    return await bridge.listWorkdirs()
  } catch {
    return []
  }
}

export async function createSession(options?: {
  title?: string
  mode?: string
  model?: string
  /** 这条会话的工作目录；'' = 明确不属于任何文件夹 */
  workdir?: string
  reasoning?: string
  threadSettings?: Record<string, unknown>
}): Promise<{ id: string; title: string } | null> {
  if (!bridge) return null
  try {
    const meta = await bridge.createSession(options)
    return { id: meta.id, title: meta.title }
  } catch {
    return null
  }
}

export async function loadSession(id: string): Promise<SessionDetail | null> {
  if (!bridge) return null
  try {
    return await bridge.loadSession(id)
  } catch {
    return null
  }
}

export async function appendMessage(id: string, message: StoredMessage): Promise<void> {
  if (!bridge) return
  try {
    await bridge.appendMessage(id, message)
  } catch {
    /* 落盘失败不能阻断对话 */
  }
}

export async function updateSessionMeta(
  id: string,
  patch: {
    title?: string
    mode?: string
    model?: string
    workdir?: string
    /** 思考强度档位（low / high / max） */
    reasoning?: string
    threadSettings?: Record<string, unknown>
  },
): Promise<void> {
  if (!bridge) return
  try {
    await bridge.updateSessionMeta(id, patch)
  } catch {
    /* 同上 */
  }
}

export async function removeSession(id: string): Promise<void> {
  if (!bridge) return
  try {
    await bridge.removeSession(id)
  } catch {
    /* 同上 */
  }
}

export async function clearAllSessions(): Promise<number> {
  if (!bridge) return 0
  try {
    const result = await bridge.removeAllSessions()
    return result.count
  } catch {
    return 0
  }
}

export async function sessionToApiMessages(
  id: string,
  limit = 20,
): Promise<Array<{ role: string; content: string }>> {
  if (!bridge) return []
  try {
    return await bridge.sessionToApiMessages(id, limit)
  } catch {
    return []
  }
}

/** 弹保存对话框写文本（导出线程 Markdown 等用） */
export async function saveText(
  defaultName: string,
  content: string,
): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持文件导出，请使用桌面版' }
  try {
    return await bridge.saveText({ defaultName, content })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 弹文件选择框读一个 JSON（导入用） */
export async function pickJsonFile(): Promise<{
  ok: boolean
  content?: string
  path?: string
  canceled?: boolean
  error?: string
}> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持文件导入，请使用桌面版' }
  try {
    return await bridge.pickJson()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 生成对话摘要（压缩用） */
export async function compactChat(payload: {
  model?: string
  messages: Array<{ role: string; content: string }>
}): Promise<{ ok: boolean; summary?: string; error?: string }> {
  if (!bridge) return { ok: false, error: '浏览器预览不支持真实压缩，请使用桌面版' }
  try {
    return await bridge.compactChat(payload)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 把压缩点写进会话文件 */
export async function appendCompact(id: string, summary: string, upTo: number): Promise<void> {
  if (!bridge) return
  try {
    await bridge.appendCompact(id, summary, upTo)
  } catch {
    /* 落盘失败不影响当前对话 */
  }
}

/** 批量导入线程；浏览器预览没有磁盘时原样返回。 */
export async function importSessions(threads: Thread[]): Promise<Thread[]> {
  if (!bridge) return threads
  try {
    const result = await bridge.importSessions(threads)
    return Array.isArray(result) ? (result as Thread[]) : threads
  } catch {
    return threads
  }
}

/** 写操作确认：把用户的允许/拒绝回给主进程 */
export async function confirmChat(confirmId: string, approved: boolean): Promise<void> {
  if (!bridge) return
  try {
    await bridge.confirmChat(confirmId, approved)
  } catch {
    /* 回不去也无所谓，主进程那边有超时 */
  }
}
