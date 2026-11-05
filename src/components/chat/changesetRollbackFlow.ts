import type { ChangeSetSummary } from '@/types/safety'
import { changesetRollback } from '@/lib/changesetApi'

/* ══════════════════════════════════════════════════════════════
   任务面板里「撤销这次改动」这整条流程

   从 `TaskCenter.tsx` 拆出来的（那边贴着 300 行上限，而撤销多了「覆盖冲突」这层
   确认卡）。这里只管**界面流程**，判据全在内核 `electron/core/changeset-conflict.cjs`。

   为什么要有冲突卡：撤销会用那时的旧内容覆盖现在的文件。当过期的改动之后
   文件又被改过（用户手动改的 / 后面几轮改的），直接撤就是**静默丢数据**。
   内核在这个时候**一个字节都不写**，返回冲突清单；用户点「仍然撤销」才带 force 真撤。
   ══════════════════════════════════════════════════════════════ */

/** 只留文件名：冲突卡里列的是「哪个文件会丢」，全路径太长、把原因挤没了 */
export function fileName(full: string): string {
  return full.split(/[\\/]/).pop() ?? full
}

export interface RollbackDeps {
  /** 转圈用的 id 写在闸门里（同一时刻只允许一条在撤） */
  setBusy: (id: string) => void
  showToast: (kind: 'success' | 'warning' | 'error', title: string, detail?: string) => void
  /** 弹确认卡（`PermissionRequest` 的形状由 `types/permission.ts` 定） */
  askPermission: (request: {
    kind: 'rollback-changeset'
    title: string
    description: string
    confirmText: string
    danger: boolean
    impact: string[]
    onConfirm: () => void
  }) => void
  /** 撤完刷新任务 / 事务列表 */
  refresh: () => void
}

/**
 * 撤销一次改动：先试「安全撤」，被拦下就弹冲突卡，用户点头才强撤。
 *
 * @returns 有没有真的动盘（被拦下 / 失败都返回 false）—— 调用方用不上也得看得见结论
 */
export async function requestRollback(
  changeset: ChangeSetSummary,
  deps: RollbackDeps,
): Promise<boolean> {
  /* ★ `try/finally` 不是为了好看：桥抛异常时收不到 `setBusy('')`，那个「撤销」按钮
     会一直转圈（用户只能重开面板）。转圈状态必须无条件收回。 */
  let result: Awaited<ReturnType<typeof changesetRollback>>
  deps.setBusy(changeset.id)
  try {
    result = await changesetRollback(changeset.id)
  } finally {
    deps.setBusy('')
  }

  if (!result.ok) {
    deps.showToast('error', '撤销失败', result.error ?? '看日志里怎么说')
    return false
  }

  if (result.blocked) {
    deps.askPermission({
      kind: 'rollback-changeset',
      title: `这次改动之后，${result.conflicts.length} 个文件又被改过`,
      description:
        '直接撤销会用那时的旧内容盖掉现在的文件。下面列的是会丢的东西 —— ' +
        '这些改动如果还要留着，就选「不撤销」，先自己备份。',
      confirmText: '仍然撤销（覆盖）',
      danger: true,
      impact: result.conflicts.map((item) => `${fileName(item.path)} —— ${item.reason}`),
      onConfirm: () => {
        void forceRollback(changeset, deps)
      },
    })
    return false
  }

  reportRolled(result, deps)
  return true
}

/** 用户在冲突卡上点了「仍然撤销」：带 force 再走一次，行为与改动前逐字节一致 */
export async function forceRollback(
  changeset: ChangeSetSummary,
  deps: RollbackDeps,
): Promise<boolean> {
  let result: Awaited<ReturnType<typeof changesetRollback>>
  deps.setBusy(changeset.id)
  try {
    result = await changesetRollback(changeset.id, { force: true })
  } finally {
    deps.setBusy('')
  }
  if (!result.ok) {
    deps.showToast('error', '撤销失败', result.error ?? '看日志里怎么说')
    return false
  }
  reportRolled(result, deps)
  return true
}

function reportRolled(
  result: {
    restored: string[]
    removed: string[]
    failed: Array<{ path: string; reason: string }>
  },
  deps: RollbackDeps,
): void {
  const failed = result.failed.length
  deps.showToast(
    failed > 0 ? 'warning' : 'success',
    '已撤销这次改动',
    `恢复 ${result.restored.length} 个 · 删除 ${result.removed.length} 个` +
      (failed > 0 ? ` · ${failed} 个没恢复成功（可能太大没快照）` : ''),
  )
  deps.refresh()
}
