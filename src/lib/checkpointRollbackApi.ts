/* ══════════════════════════════════════════════════════════════
   检查点回退（AG-052）—— 桥包装 + 措辞

   内核：`electron/core/changeset-rollback.cjs`（语义、边界全在它的头注释里）。

   ⚠️ **名字**：这条能力能撤的只是「这个检查点之后**才第一次**被改的文件」，
      所以文案一律写「撤销检查点之后的改动」，**不写**「回到检查点」——
      多轮反复改同一个文件时那个文件撤不回那一刻的样子（内核头注释边界①）。

   两段式：
     · `rollbackPreview` —— 干跑，只算「会撤哪些 / 会删哪些 / 哪些撤不动」，
       一个字都不写盘。确认框拿它做影响预览。
     · `rollbackApply` —— 真撤。

   方法**不**写进 `types/backend.ts` / `types/safety.ts`（那两份都贴着 300 行），
   照 `lib/projectRulesApi.ts` 的做法就地声明本地类型 + 能力探测。
   约定同样：**失败不抛异常** —— 桥没接上只是「这一行不显示」。
   ══════════════════════════════════════════════════════════════ */

/** 被点名的一个文件（失败项带 detail / kind，撤不动的只带 reason） */
export interface RollbackFileRef {
  path: string
  reason?: string
  /** 原始技术报错（原因说人话之后，英文原文留在这儿给排查用） */
  detail?: string
  /** errors.cjs 的分类（如 file_missing / permission） */
  kind?: string
}

export interface RollbackResult {
  ok: boolean
  error?: string
  /** true = 这次是干跑（盘上什么都没动） */
  dryRun?: boolean
  restored: string[]
  removed: string[]
  failed: RollbackFileRef[]
  skipped: RollbackFileRef[]
  changesets: string[]
  checkpoint?: { at: number; label: string; index: number }
}

const EMPTY: RollbackResult = {
  ok: false,
  restored: [],
  removed: [],
  failed: [],
  skipped: [],
  changesets: [],
}

type Bridge = {
  changesetRollbackTo?: (payload: {
    taskId: string
    checkpointId: string | number
    dryRun?: boolean
  }) => Promise<unknown>
}

const bridge =
  typeof window !== 'undefined' ? (window.workbench as unknown as Bridge | undefined) : undefined

/** 桥接好了吗（调用方据此区分「桌面版才有」和「真出错了」） */
export function rollbackBridgeReady(): boolean {
  return typeof bridge?.changesetRollbackTo === 'function'
}

/** 回执收成确定的形状：内核失败时也给空数组，这里只兜「桥没接上 / 抛了」 */
function settle(raw: unknown): RollbackResult {
  const value = (raw ?? {}) as Partial<RollbackResult>
  return {
    ok: value.ok === true,
    error: value.error,
    dryRun: value.dryRun === true,
    restored: value.restored ?? [],
    removed: value.removed ?? [],
    failed: value.failed ?? [],
    skipped: value.skipped ?? [],
    changesets: value.changesets ?? [],
    checkpoint: value.checkpoint,
  }
}

async function run(
  taskId: string,
  checkpointId: string | number,
  dryRun: boolean,
): Promise<RollbackResult> {
  if (!bridge?.changesetRollbackTo) return { ...EMPTY, error: '这个版本没有接上回退通道' }
  try {
    return settle(await bridge.changesetRollbackTo({ taskId, checkpointId, dryRun }))
  } catch (error) {
    return { ...EMPTY, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 干跑：只算清单（确认框的影响预览用） */
export function rollbackPreview(
  taskId: string,
  checkpointId: string | number,
): Promise<RollbackResult> {
  return run(taskId, checkpointId, true)
}

/** 真撤（破坏性操作 —— 必须已经过二次确认） */
export function rollbackApply(
  taskId: string,
  checkpointId: string | number,
): Promise<RollbackResult> {
  return run(taskId, checkpointId, false)
}

/** 路径太长：界面上一律只显示末两段（完整路径挂 title） */
export function shortPath(full: string): string {
  const parts = String(full ?? '').split(/[\\/]/)
  return parts.length <= 2 ? parts.join('/') || full : parts.slice(-2).join('/')
}

/** 列几个名字，多的写「等 N 个」 */
function listFiles(paths: readonly string[], limit = 5): string {
  const names = paths.slice(0, limit).map(shortPath)
  return paths.length > limit ? `${names.join('、')} 等 ${paths.length} 个` : names.join('、')
}

/**
 * 确认框里的「影响预览」（`askPermission` 的 `impact`）。
 *
 * 只写**会变成什么样**，不写「操作成功」那种事后话 —— 因为这是动手之前看的。
 */
export function rollbackImpact(preview: RollbackResult): string[] {
  const lines: string[] = []
  if (preview.restored.length > 0) {
    lines.push(
      `恢复 ${preview.restored.length} 个文件到那时候的内容：${listFiles(preview.restored)}`,
    )
  }
  if (preview.removed.length > 0) {
    lines.push(
      `删掉 ${preview.removed.length} 个那时候还不存在的文件：${listFiles(preview.removed)}`,
    )
  }
  if (preview.skipped.length > 0) {
    lines.push(
      `留着 ${preview.skipped.length} 个不动（检查点之前就改过，撤它会把更早的改动一起撤掉）：` +
        listFiles(preview.skipped.map((item) => item.path)),
    )
  }
  if (preview.failed.length > 0) {
    const first = preview.failed[0]
    lines.push(
      `${preview.failed.length} 个撤不回去：${listFiles(preview.failed.map((item) => item.path))}` +
        (first?.reason ? `（第一个的原因：${first.reason}）` : ''),
    )
  }
  if (lines.length === 0) lines.push('这个检查点之后没有可撤的改动 —— 撤了也不会变。')
  return lines
}

/** 撤销结果说成一句话（toast 用） */
export function describeRollback(result: RollbackResult, checkpointLabel = ''): string {
  const head = checkpointLabel ? `回到「${checkpointLabel}」之后的状态：` : ''
  const parts: string[] = []
  if (result.restored.length > 0) parts.push(`恢复 ${result.restored.length} 个`)
  if (result.removed.length > 0) parts.push(`删除 ${result.removed.length} 个`)
  if (parts.length === 0) parts.push('没有文件需要改')
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} 个撤不动、原样留着`)
  if (result.failed.length > 0) parts.push(`${result.failed.length} 个没成功`)
  return head + parts.join(' · ')
}
