import { useMemo } from 'react'
import { Modal } from '@/components/ui/Modal'
import { colorOf } from '@/lib/statusLanguage'
import { alignToolSequences, diffLines, fileTouchesOf, toolSequenceOf } from '@/lib/regenCompare'
import type { StoredMessage } from '@/types/models-extra'

/* ══════════════════════════════════════════════════════════════
   「对比两次生成」—— 审查两次重新生成的差异

   入口在回答的 ‹ n / N › 旁边（两版以上才有）。三块：
     · 最终输出差异（逐行 diff；相同的长段折叠，只看变化的行）
     · 工具调用序列（对齐展示：一样 / 换了 / 只在某一边）
     · 文件改动（从写类工具调用归纳 —— 只认 write_file / edit_file）
   ══════════════════════════════════════════════════════════════ */

export function RegenCompare({
  records,
  index,
  onClose,
}: {
  records: StoredMessage[]
  index: number
  onClose: () => void
}) {
  /* 对比对象：当前显示的 vs 上一版；停在第一版就跟第二版比 */
  const older = records[index > 0 ? index - 1 : 0]
  const newer = records[index > 0 ? index : 1]
  const labelA = index > 0 ? `第 ${index} 版` : '第 1 版'
  const labelB = index > 0 ? `第 ${index + 1} 版` : '第 2 版'

  const diff = useMemo(() => diffLines(older?.content ?? '', newer?.content ?? ''), [older, newer])
  const tools = useMemo(
    () => alignToolSequences(toolSequenceOf(older), toolSequenceOf(newer)),
    [older, newer],
  )
  const filesA = useMemo(() => fileTouchesOf(older), [older])
  const filesB = useMemo(() => fileTouchesOf(newer), [newer])
  if (!older || !newer) return null

  const changed = diff.added + diff.removed

  return (
    <Modal open onClose={onClose} title="对比两次生成" width="xl" height="h-[min(680px,85vh)]">
      <div className="flex flex-col gap-4 text-sm">
        {/* ── ① 最终输出差异 ── */}
        <section>
          <h4 className="mb-1.5 flex items-center gap-2 text-2xs font-medium text-fg-secondary">
            最终输出差异
            <span className="text-fg-tertiary">
              {changed === 0 ? '两版输出完全一致' : `+${diff.added} 行 / −${diff.removed} 行`}
            </span>
            <span className="text-fg-tertiary">
              （{labelA} → {labelB}）
            </span>
          </h4>
          <div className="max-h-64 overflow-auto rounded-base border border-line-hairline bg-bg-raised/30 p-2 font-mono text-2xs leading-relaxed">
            {diff.rows.map((row, i) => (
              <div
                key={i}
                className="whitespace-pre-wrap break-words"
                style={{
                  color:
                    row.kind === 'add'
                      ? colorOf('completed')
                      : row.kind === 'del'
                        ? colorOf('failed')
                        : undefined,
                }}
              >
                <span className="select-none opacity-60">
                  {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '− ' : '  '}
                </span>
                {row.text}
              </div>
            ))}
            {diff.truncated ? (
              <div className="mt-1 text-fg-tertiary">…（差异太长，只显示前一段）</div>
            ) : null}
          </div>
        </section>

        {/* ── ② 工具调用序列 ── */}
        <section>
          <h4 className="mb-1.5 text-2xs font-medium text-fg-secondary">
            工具调用序列（{labelA} {tools.filter((r) => r.a).length} 次 · {labelB}{' '}
            {tools.filter((r) => r.b).length} 次）
          </h4>
          <div className="max-h-40 overflow-auto rounded-base border border-line-hairline bg-bg-raised/30 p-2 text-2xs">
            {tools.length === 0 ? (
              <div className="text-fg-tertiary">两版都没有工具调用</div>
            ) : (
              tools.map((row, i) => (
                <div key={i} className="flex gap-2 py-0.5">
                  <span className="shrink-0 text-fg-tertiary">{i + 1}</span>
                  {row.a ? (
                    <span className="min-w-0 flex-1 truncate" title={row.a.detail}>
                      {row.a.ok ? '✓' : '✗'} {row.a.name}
                    </span>
                  ) : (
                    <span className="flex-1 text-fg-tertiary">—</span>
                  )}
                  {row.b ? (
                    <span
                      className="min-w-0 flex-1 truncate"
                      style={row.kind === 'same' ? undefined : { color: colorOf('retrying') }}
                      title={row.b.detail}
                    >
                      {row.b.ok ? '✓' : '✗'} {row.b.name}
                      {row.kind === 'diff' ? '（换了）' : ''}
                    </span>
                  ) : (
                    <span className="flex-1 text-fg-tertiary">（这版没跑）</span>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        {/* ── ③ 文件改动 ── */}
        <section>
          <h4 className="mb-1.5 text-2xs font-medium text-fg-secondary">
            文件改动（来自写类工具调用）
          </h4>
          <div className="grid grid-cols-2 gap-2 text-2xs">
            {[filesA, filesB].map((files, side) => (
              <div
                key={side}
                className="rounded-base border border-line-hairline bg-bg-raised/30 p-2"
              >
                <div className="mb-1 text-fg-tertiary">{side === 0 ? labelA : labelB}</div>
                {files.length === 0 ? (
                  <div className="text-fg-tertiary">没有记录到文件改动</div>
                ) : (
                  files.map((f, i) => (
                    <div key={i} className="truncate" title={f.file}>
                      {f.count > 1 ? `${f.count}× ` : ''}
                      {f.file}
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-2xs text-fg-tertiary">
            提示：旧改动保留在它自己的改动事务里（右栏「审查」可整批回滚），重新生成不会自动撤销它。
          </p>
        </section>
      </div>
    </Modal>
  )
}
