import type { ChangeSetSummary, WorkbenchBridge } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   改动事务的桥包装（列表 / 整批撤销）

   从 `safetyApi.ts` 拆出来的：那边 300 行上限，而撤销这条多了「覆盖冲突」这层，
   再塞进去只能删别人的注释。

   内核：`electron/core/changeset-conflict.cjs`（判据、为什么 open 事务不比 mtime
   全写在它的文件头）。这里只做「调桥 + 把返回形状收成界面能直接用的那份」。

   浏览器预览没有桥 → 返回空结果，不抛异常。
   ══════════════════════════════════════════════════════════════ */

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

/** 撤销前的冲突项（内核算的，界面照 `reason` 渲染，不拿 `kind` 当判据） */
export interface RollbackConflict {
  path: string
  /**
   * 冲突类型：`later_changeset` 之后被别的事务改过 / `modified_after` 事务结束后被改过 /
   * `deleted_after` 之后被删了 / `recreated` 新建的文件被删了又重建。
   * 按字符串接、不写成联合类型 —— 以后内核多一种也不必改这边。
   */
  kind: string
  reason: string
  detail: string
}

export interface RollbackResult {
  ok: boolean
  restored: string[]
  removed: string[]
  failed: Array<{ path: string; reason: string }>
  /** 有覆盖冲突：**盘上一个字节都没动**，等用户确认要不要强撤 */
  blocked: boolean
  conflicts: RollbackConflict[]
  error?: string
}

/** 返回骨架只在这一处定义（失败 / 无桥 / 正常都照它） */
function skeleton(): RollbackResult {
  return { ok: false, restored: [], removed: [], failed: [], blocked: false, conflicts: [] }
}

export async function changesetList(options?: { limit?: number }): Promise<ChangeSetSummary[]> {
  if (!bridge?.changesetList) return []
  try {
    const result = await bridge.changesetList(options)
    return result.changesets ?? []
  } catch {
    return []
  }
}

/**
 * 撤销一次改动。
 *
 * `options.force` = 用户已经在确认卡上看过冲突清单、仍然要覆盖（行为与改动前一致）。
 * 不传 → 有冲突就返回 `blocked: true`，什么都不写。
 */
export async function changesetRollback(
  id: string,
  options?: { force?: boolean },
): Promise<RollbackResult> {
  if (!bridge?.changesetRollback) return skeleton()
  try {
    const result = await bridge.changesetRollback({ id, force: options?.force === true })
    return {
      ok: result.ok === true,
      restored: result.restored ?? [],
      removed: result.removed ?? [],
      failed: result.failed ?? [],
      blocked: result.blocked === true,
      conflicts: result.conflicts ?? [],
      error: result.error,
    }
  } catch {
    return skeleton()
  }
}
