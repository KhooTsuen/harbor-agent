import { useState } from 'react'
import { ChevronDown, ChevronRight, FileDiff, Rows2, SplitSquareHorizontal } from 'lucide-react'
import type { DiffFile, DiffLine } from '@/types'
import { cn } from '@/lib/utils'
import { TOKEN_COLOR, tokenize } from '@/lib/highlight'
import { languageFromName } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'

/* ══════════════════════════════════════════════════════════════
   DiffViewer（unified / split 两种视图）

   unified：一行 = 旧行号 + 新行号 + 标记 + 内容
   split ：左列删除（带旧行号），右列新增（带新行号），context 两列都显示

   增删行用低饱和整行底色，不是只给文字上色 —— 这是从截图里看到的做法。
   ══════════════════════════════════════════════════════════════ */

export type DiffView = 'unified' | 'split'

export interface DiffViewerProps {
  files: readonly DiffFile[]
  className?: string
  defaultCollapsed?: boolean
}

function DiffLineContent({ content, language }: { content: string; language: string }) {
  const tokens = tokenize(content, language)
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={{ color: TOKEN_COLOR[t.kind] }}>
          {t.text}
        </span>
      ))}
    </>
  )
}

/** 一个 hunk 里的行：old 侧（删除/context）、new 侧（新增/context） */
interface Row {
  left: DiffLine | null
  right: DiffLine | null
}

function pairLines(lines: readonly DiffLine[]): Row[] {
  const rows: Row[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line) break
    if (line.type === 'remove' && lines[i + 1]?.type === 'add') {
      rows.push({ left: line, right: lines[i + 1] ?? null })
      i += 2
    } else if (line.type === 'remove') {
      rows.push({ left: line, right: null })
      i += 1
    } else if (line.type === 'add') {
      rows.push({ left: null, right: line })
      i += 1
    } else {
      rows.push({ left: line, right: line })
      i += 1
    }
  }
  return rows
}

function lineBg(type: DiffLine['type']): string {
  if (type === 'add') return 'var(--diff-add-bg)'
  if (type === 'remove') return 'var(--diff-remove-bg)'
  return 'transparent'
}

function DiffFileBlock({
  file,
  defaultCollapsed,
  view,
}: {
  file: DiffFile
  defaultCollapsed: boolean
  view: DiffView
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const language = languageFromName(file.path)

  return (
    <section className="overflow-hidden rounded border border-line-subtle bg-bg-base/50">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-bg-hover"
      >
        {collapsed ? (
          <ChevronRight size={14} className="shrink-0 text-fg-tertiary" />
        ) : (
          <ChevronDown size={14} className="shrink-0 text-fg-tertiary" />
        )}
        <FileDiff size={14} className="shrink-0 text-fg-tertiary" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-fg-primary"
          title={file.path}
        >
          {file.path}
        </span>
        <span className="shrink-0 font-mono text-2xs" style={{ color: 'var(--diff-add)' }}>
          +{file.additions}
        </span>
        <span className="shrink-0 font-mono text-2xs" style={{ color: 'var(--diff-remove)' }}>
          −{file.deletions}
        </span>
      </button>

      {!collapsed ? (
        <div className="overflow-x-auto border-t border-line-subtle">
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex}>
              <div className="bg-bg-raised/60 px-2 py-1 font-mono text-2xs text-fg-tertiary">
                {hunk.header}
              </div>
              {view === 'unified' ? (
                <div className="font-mono text-xs leading-[1.65]">
                  {hunk.lines.map((line, lineIndex) => {
                    const isAdd = line.type === 'add'
                    const isRemove = line.type === 'remove'
                    return (
                      <div
                        key={lineIndex}
                        className="flex min-h-[1.65em]"
                        style={{ background: lineBg(line.type) }}
                      >
                        <span className="w-9 shrink-0 select-none pr-2 text-right text-fg-tertiary">
                          {isAdd ? '' : (line.oldLineNumber ?? '')}
                        </span>
                        <span className="w-9 shrink-0 select-none pr-2 text-right text-fg-tertiary">
                          {isRemove ? '' : (line.newLineNumber ?? '')}
                        </span>
                        <span
                          className="w-4 shrink-0 select-none text-center"
                          style={{
                            color: isAdd
                              ? 'var(--diff-add)'
                              : isRemove
                                ? 'var(--diff-remove)'
                                : 'var(--text-tertiary)',
                          }}
                        >
                          {isAdd ? '+' : isRemove ? '−' : ' '}
                        </span>
                        <span className="min-w-0 flex-1 whitespace-pre pr-3">
                          <DiffLineContent content={line.content} language={language} />
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-2 font-mono text-xs leading-[1.65]">
                  {pairLines(hunk.lines).map((row, rowIndex) => (
                    <div key={rowIndex} className="contents">
                      <div
                        className="flex min-h-[1.65em] border-r border-line-subtle"
                        style={{
                          background: row.left ? lineBg(row.left.type) : 'var(--bg-raised/20)',
                        }}
                      >
                        <span className="w-8 shrink-0 select-none pr-2 text-right text-fg-tertiary">
                          {row.left?.oldLineNumber ?? ''}
                        </span>
                        <span
                          className="w-4 shrink-0 select-none text-center"
                          style={{
                            color:
                              row.left?.type === 'remove'
                                ? 'var(--diff-remove)'
                                : 'var(--text-tertiary)',
                          }}
                        >
                          {row.left?.type === 'remove' ? '−' : ' '}
                        </span>
                        <span className="min-w-0 flex-1 whitespace-pre pr-3">
                          {row.left ? (
                            <DiffLineContent content={row.left.content} language={language} />
                          ) : null}
                        </span>
                      </div>
                      <div
                        className="flex min-h-[1.65em]"
                        style={{
                          background: row.right ? lineBg(row.right.type) : 'var(--bg-raised/20)',
                        }}
                      >
                        <span className="w-8 shrink-0 select-none pr-2 text-right text-fg-tertiary">
                          {row.right?.newLineNumber ?? ''}
                        </span>
                        <span
                          className="w-4 shrink-0 select-none text-center"
                          style={{
                            color:
                              row.right?.type === 'add'
                                ? 'var(--diff-add)'
                                : 'var(--text-tertiary)',
                          }}
                        >
                          {row.right?.type === 'add' ? '+' : ' '}
                        </span>
                        <span className="min-w-0 flex-1 whitespace-pre pr-3">
                          {row.right ? (
                            <DiffLineContent content={row.right.content} language={language} />
                          ) : null}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

export function DiffViewer({ files, className, defaultCollapsed = false }: DiffViewerProps) {
  const [view, setView] = useState<DiffView>('unified')
  if (files.length === 0) return null

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-end gap-0.5">
        <Tooltip content="单栏视图">
          <IconButton
            label="单栏视图"
            size={28}
            active={view === 'unified'}
            onClick={() => setView('unified')}
          >
            <Rows2 size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip content="双栏视图">
          <IconButton
            label="双栏视图"
            size={28}
            active={view === 'split'}
            onClick={() => setView('split')}
          >
            <SplitSquareHorizontal size={14} />
          </IconButton>
        </Tooltip>
      </div>
      {files.map((file) => (
        <DiffFileBlock
          key={file.path}
          file={file}
          defaultCollapsed={defaultCollapsed}
          view={view}
        />
      ))}
    </div>
  )
}

/** 所有 diff 的汇总统计，给顶栏用 */
export function sumDiff(files: readonly DiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
}
