import type { ArtifactRecord, ArtifactListResult } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   成果（Artifact）的桥包装

   内核侧已经落盘了（`electron/core/artifact.cjs` + `data/artifacts/`），
   但 preload 的白名单方法**还没加**（`electron/preload.cjs` 按分工留给集成方统一加），
   所以这里必须做**能力探测**：桥上没有这几个方法就返回 null。

   调用方（成果面板）据此降级回前端内存汇总 —— 桥没接好只是「没有版本历史」，
   **不能让面板白屏 / 崩**。这也是为什么返回值是 `T | null` 而不是抛异常。
   ══════════════════════════════════════════════════════════════ */

/** 内核侧待暴露的那几个方法（写在这里而不是 backend.ts：那边已 300 行） */
type ArtifactBridge = {
  artifactList?: (options?: {
    taskId?: string
    sessionId?: string
    limit?: number
  }) => Promise<ArtifactListResult>
  artifactGet?: (
    id: string,
    version?: number,
  ) => Promise<{ ok: boolean; artifact?: ArtifactRecord; content?: string; error?: string }>
  artifactSave?: (draft: {
    name: string
    type?: string
    content?: string
    path?: string
    taskId?: string
    sessionId?: string
    threadId?: string
    sourceMessageId?: string
  }) => Promise<{ ok: boolean; artifact?: ArtifactRecord; deduped?: boolean; error?: string }>
  artifactRemove?: (id: string) => Promise<{ ok: boolean; error?: string }>
}

/*
 * `window.workbench` 的类型里还没有这几个方法（backend.ts 不能改），
 * 所以用一次 `as unknown as` 收窄成本地类型 —— 不用 any，也不用 @ts-ignore。
 */
const bridge =
  typeof window !== 'undefined'
    ? (window.workbench as unknown as ArtifactBridge | undefined)
    : undefined

/** 桥接好了吗（面板可以据此说明「当前是会话内汇总，没有版本历史」） */
export function artifactBridgeReady(): boolean {
  return typeof bridge?.artifactList === 'function'
}

/** 列成果；拿不到（没桥 / 内核报错）返回 null，调用方降级 */
export async function artifactList(
  options: {
    taskId?: string
    sessionId?: string
    limit?: number
  } = {},
): Promise<ArtifactRecord[] | null> {
  if (typeof bridge?.artifactList !== 'function') return null
  try {
    const result = await bridge.artifactList(options)
    return result?.ok ? result.artifacts : null
  } catch {
    return null
  }
}

/** 按版本取正文；省略版本 = 最新版。拿不到返回 null */
export async function artifactGet(
  id: string,
  version?: number,
): Promise<{ artifact: ArtifactRecord; content: string } | null> {
  if (typeof bridge?.artifactGet !== 'function') return null
  try {
    const result = await bridge.artifactGet(id, version)
    return result?.ok && result.artifact
      ? { artifact: result.artifact, content: result.content ?? '' }
      : null
  } catch {
    return null
  }
}

/** 存一个成果（同名多次 = 新版本）。失败把原因带回去给界面说一句 */
export async function artifactSave(draft: {
  name: string
  type?: string
  content?: string
  path?: string
  taskId?: string
  sessionId?: string
  threadId?: string
  sourceMessageId?: string
}): Promise<{ ok: boolean; artifact?: ArtifactRecord; error?: string }> {
  if (typeof bridge?.artifactSave !== 'function')
    return { ok: false, error: '当前环境不支持成果落盘' }
  try {
    return await bridge.artifactSave(draft)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function artifactRemove(id: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof bridge?.artifactRemove !== 'function')
    return { ok: false, error: '当前环境不支持成果落盘' }
  try {
    return await bridge.artifactRemove(id)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
