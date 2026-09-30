import { Undo2, X } from 'lucide-react'
import { describeRollback, shortPath } from '@/lib/checkpointRollbackApi'
import { cn, relativeTime } from '@/lib/utils'
import { colorOf } from '@/lib/statusLanguage'
import { useTaskStore } from '@/stores/useTaskStore'

/* ══════════════════════════════════════════════════════════════
   审查面板顶部的「刚才这次回退」（AG-052）

   需求原话：**「撤销后在审查面板能看到这次回退的记录」**。
   只弹一个 toast 是不够的 —— 用户要能对着看「到底动了哪些文件」。

   ⚠️ 这一条**只活在本次会话**（`useTaskStore.lastRollback`）：磁盘上的真相是
      改动事务的 `rolledBackAt` 和任务台账，这里不另存一份历史 ——
      存了就变成第二份真相，两边对不上时没人知道信谁。「收起」直接清掉。

   ⚠️ 名字照旧写全（「撤销…之后的改动」），不写「回到检查点」——
      撤不动的文件下面会**点名列出来**，不假装撤干净了。
   ══════════════════════════════════════════════════════════════ */

function names(paths: readonly { path: string }[], limit = 4): string {
  const list = paths.slice(0, limit).map((item) => shortPath(item.path))
  return paths.length > limit ? `${list.join('、')} 等 ${paths.length} 个` : list.join('、')
}

export function RollbackRecord() {
  const record = useTaskStore((s) => s.lastRollback)
  const noteRollback = useTaskStore((s) => s.noteRollback)
  if (!record) return null

  const { result } = record
  const failed = result.failed.length > 0

  return (
    <div
      className={cn(
        'mx-2 mt-2 rounded-sm border px-2 py-1.5 text-2xs',
        failed ? 'border-warning/40 bg-warning/5' : 'border-line-subtle bg-bg-raised/30',
      )}
      role="status"
    >
      <div className="flex items-center gap-1.5">
        <Undo2 size={11} className="shrink-0" style={{ color: colorOf('completed') }} />
        <span className="min-w-0 flex-1 truncate text-fg-secondary">
          撤销了「{record.checkpointLabel}」之后的改动
        </span>
        <span className="shrink-0 text-fg-tertiary">{relativeTime(record.at)}前</span>
        <button
          type="button"
          aria-label="收起这条记录"
          title="收起"
          onClick={() => noteRollback(null)}
          className="shrink-0 rounded-sm p-0.5 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <X size={11} />
        </button>
      </div>

      <p className="mt-1 text-fg-tertiary">{describeRollback(result, '')}</p>

      {/* 撤不动的：说明白为什么留着，不然用户会以为漏了 */}
      {result.skipped.length > 0 ? (
        <p className="mt-0.5 text-fg-tertiary">
          · 原样留着 {result.skipped.length} 个（检查点之前就改过）：{names(result.skipped)}
        </p>
      ) : null}

      {failed ? (
        <p className="mt-0.5" style={{ color: colorOf('warning') }}>
          · 没撤成 {result.failed.length} 个：{names(result.failed)}
          {result.failed[0]?.reason ? `（第一个的原因：${result.failed[0].reason}）` : ''}
        </p>
      ) : null}
    </div>
  )
}
