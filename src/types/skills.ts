import type { SkillInfo } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   技能：主进程 `skills.list()` 多带回来的字段

   为什么单独一个文件：`types/models-extra.ts` 与 `types/backend.ts` 都已经
   300 行（硬约束 #2），而**两个地方都要用这份形状**（技能设置页、本次会话的
   「按哪个技能做」）。在这里定义一次，别各写一份 —— 两份一定会漂。

   两个字段都是可选的，所以 `SkillInfo[]` 直接赋值给 `SkillRow[]` 是合法的，不用断言。
   ══════════════════════════════════════════════════════════════ */

export interface SkillPermissionItem {
  kind: string
  value: string
  label: string
}

export interface SkillPermissions {
  items: SkillPermissionItem[]
  byKind: Record<string, string>
  text: string
}

export type SkillRow = SkillInfo & {
  permissions?: SkillPermissions | null
  permissionError?: string | null
}
