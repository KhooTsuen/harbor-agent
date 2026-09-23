import type { ProjectRecord } from '@/lib/schemas'

/* ══════════════════════════════════════════════════════════════
   项目（一等实体）在渲染层的类型

   `ProjectRecord` 是**内核登记表**（`data/projects.json` 的 items 元素）的形状，
   比界面用的 `Project`（见 `@/types`）多一个 `auto`。
   两处形状必须一致，所以这里不另写一份，直接从 zod schema 转发 ——
   校验与类型同一个来源，才不会漂（漂了的表现是：字段读出来永远是空/默认值）。

   `Project` = 界面用的（多 `path`、少 `auto`），映射见
   `stores/app/workspaceGroups.ts` 的 `projectFromRecord`。
   ══════════════════════════════════════════════════════════════ */

export type { ProjectRecord } from '@/lib/schemas'

/** 一次读回的项目登记表（桥没接上时调用方拿到 null，走降级） */
export interface ProjectsSnapshot {
  items: ProjectRecord[]
  /** 这台机器上最后选中的项目 id（内核 `projects.json` 的 activeId） */
  activeId: string
}

/** 落盘入参：带 `id` = 改，不带 = 新建（内核 `projects:save` 的约定） */
export interface ProjectSaveInput {
  id?: string
  name?: string
  description?: string
  root?: string
  branch?: string
  icon?: string
  color?: string
  pinned?: boolean
  archived?: boolean
}

/** 内核写入类接口的统一回执 */
export interface ProjectSaveResult {
  ok: boolean
  item?: ProjectRecord
  error?: string
}

export interface ProjectSimpleResult {
  ok: boolean
  error?: string
}
