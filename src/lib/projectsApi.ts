import type {
  ProjectRecord,
  ProjectSaveInput,
  ProjectSaveResult,
  ProjectSimpleResult,
  ProjectsSnapshot,
} from '@/types/projects'
import { ProjectsPayloadSchema, safeParse } from './schemas'

/* ══════════════════════════════════════════════════════════════
   项目（一等实体）的桥包装

   内核侧已经落盘了（`electron/core/projects.cjs` + `handlers/projects.cjs`），
   但方法不写进 `types/backend.ts` —— 那个文件正好 300 行（硬约束 #2），
   所以这里照 `lib/artifactApi.ts` 的做法就地声明本地类型 + 能力探测。

   约定（和 artifactApi 一致）：**失败不抛异常**，返回空值 / `ok:false`，
   调用方据此降级 —— 桥没接上只是「项目改不了名」，不能让侧栏白屏。
   ══════════════════════════════════════════════════════════════ */

/**
 * preload 上这几个方法的形状。
 *
 * 回执一律先收成 `unknown`：它们是从 `data/projects.json` 读出来的**磁盘数据**，
 * 类型层面再严也挡不住用户手改过那个 json（AGENT.md 硬约束：外部数据先过 zod）。
 * 校验在 `schemas.ts` 的 `ProjectsPayloadSchema`，这里不重复。
 */
type ProjectsBridge = {
  projectsList?: () => Promise<unknown>
  projectsSave?: (input: ProjectSaveInput) => Promise<unknown>
  projectsRemove?: (id: string) => Promise<unknown>
  projectsSetActive?: (id: string) => Promise<unknown>
}

const bridge =
  typeof window !== 'undefined'
    ? (window.workbench as unknown as ProjectsBridge | undefined)
    : undefined

/** 桥接好了吗（调用方据此决定「失败了要不要提示用户」） */
export function projectsBridgeReady(): boolean {
  return typeof bridge?.projectsList === 'function'
}

/** 收窄一条写操作的回执：形状不对就当成失败，别把 undefined 往外传 */
function readResult(raw: unknown): ProjectSaveResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '内核没有返回结果' }
  const value = raw as { ok?: unknown; item?: unknown; error?: unknown }
  return {
    ok: value.ok === true,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(value.item ? { item: readRecord(value.item) } : {}),
  }
}

/** 内核返回的单条登记项 —— 同样得校验（可能是刚写下去的脏数据） */
function readRecord(raw: unknown): ProjectRecord | undefined {
  const parsed = safeParse(ProjectsPayloadSchema, { items: [raw], activeId: '' })
  return parsed?.items[0]
}

/**
 * 读项目登记表。拿不到（没桥 / 校验不过 / 内核报错）返回 null，
 * 调用方据此**退回「从会话的 workdir 现推」的老行为**。
 */
export async function fetchProjects(): Promise<ProjectsSnapshot | null> {
  if (typeof bridge?.projectsList !== 'function') return null
  try {
    const parsed = safeParse(ProjectsPayloadSchema, await bridge.projectsList())
    return parsed ? { items: parsed.items, activeId: parsed.activeId } : null
  } catch {
    return null
  }
}

/** 落盘一条（`input.id` 有值 = 改，没有 = 新建）。新建时调用方要靠 `item.id` */
export async function saveProject(input: ProjectSaveInput): Promise<ProjectSaveResult> {
  if (typeof bridge?.projectsSave !== 'function') {
    return { ok: false, error: '当前环境不支持项目落盘' }
  }
  try {
    return readResult(await bridge.projectsSave(input))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 移除登记项（内核**只删登记，不删会话和任务**） */
export async function removeProject(id: string): Promise<ProjectSimpleResult> {
  if (typeof bridge?.projectsRemove !== 'function') {
    return { ok: false, error: '当前环境不支持项目落盘' }
  }
  try {
    const result = readResult(await bridge.projectsRemove(id))
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 记住当前选中的项目（重启后还停在同一个） */
export async function setProjectActive(id: string): Promise<ProjectSimpleResult> {
  if (typeof bridge?.projectsSetActive !== 'function') {
    return { ok: false, error: '当前环境不支持项目落盘' }
  }
  try {
    const result = readResult(await bridge.projectsSetActive(id))
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
