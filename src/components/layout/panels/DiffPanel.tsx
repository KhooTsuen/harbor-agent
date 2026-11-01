import { GitCompareArrows } from 'lucide-react'
import type { ChangeSetDiff } from '@/types/safety-types'
import { colorOf } from '@/lib/statusLanguage'
import { relativeTime } from '@/lib/utils'
import { DiffViewer, sumDiff } from '@/components/chat/DiffViewer'
import { EmptyState } from '@/components/ui/EmptyState'
import { useAppStore } from '@/stores/useAppStore'

/* ══════════════════════════════════════════════════════════════
   右栏「审查」面板的内容区

   从 `RightPanel.tsx` 搬出来的：那边是 296/300 行，再加一个字就破线；
   而审查这一块本身就是「最近一批改动」的完整说明，自己站得住。

   ── 为什么不能叫「未提交改动」（2026-10-31 第二阶段）─────────────
   数据不是 git 的 index/worktree 差异，而是 Harbor 改动事务里
   「改动前快照 vs 磁盘现在」算出来的 —— 根本没有「提交」这个动作。
   所以标题只说**这是什么**：这条对话最近的、Harbor 记下来的那一批改动。

   ── 三件必须看得见的事 ────────────────────────────────────────
     ① 归属：哪条对话、什么时候、什么状态（进行中 / 已记录 / 已撤销）
     ② 没算进 diff 的（skipped）：快照读不到、一次改太多 —— **常显**，
        以前只在 files 非空时才显示，于是「文件全被跳过」时界面一片空白
     ③ 读取失败（diffError）：和「真的没有改动」分开说，不合并成空态
   ══════════════════════════════════════════════════════════════ */

const STATUS_LABEL: Record<string, string> = {
  open: '进行中',
  committed: '已记录',
  'rolled-back': '已撤销',
}

export function statusLabelOf(status?: string): string {
  if (!status) return ''
  return STATUS_LABEL[status] ?? status
}

export interface DiffPanelProps {
  changed: ChangeSetDiff | null
  /** 这条对话正在跑（顶栏 / 这里都要说「生成中」） */
  active: boolean
  /** 拉 diff 本身失败时的原因；空串 = 没失败 */
  diffError: string
}

export function DiffPanel({ changed, active, diffError }: DiffPanelProps) {
  const diffs = changed?.files ?? []
  const skipped = changed?.skipped ?? []
  const { additions, deletions } = sumDiff(diffs)
  const threadTitle = useAppStore(
    (s) => s.threads.find((t) => t.id === s.activeThreadId)?.title ?? '',
  )
  const status = statusLabelOf(changed?.status)
  const at = changed?.at ?? 0

  /* 有东西要说（文件 / 跳过 / 失败）才渲染表头 —— 全空时只留一张空态 */
  const hasBody = diffs.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hasBody ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-subtle px-3 py-2 text-2xs">
            <span className="text-fg-secondary">最近一批 Harbor 改动</span>
            {threadTitle ? (
              <span className="min-w-0 truncate text-fg-tertiary" title={threadTitle}>
                对话：{threadTitle}
              </span>
            ) : null}
            {status ? <span className="text-fg-tertiary">状态：{status}</span> : null}
            {at > 0 ? <span className="text-fg-tertiary">{relativeTime(at)}</span> : null}
            <span className="text-fg-tertiary">{diffs.length} 个文件</span>
            {active ? (
              <span className="flex items-center gap-1 text-fg-tertiary">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-warning" />
                生成中…
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-2 font-mono">
              <span style={{ color: 'var(--diff-add)' }}>+{additions}</span>
              <span style={{ color: 'var(--diff-remove)' }}>−{deletions}</span>
            </span>
          </div>
          <p className="shrink-0 border-b border-line-subtle px-3 py-1 text-2xs text-fg-tertiary">
            这里列的是这条对话最近一批被改动的文件（拿改动前快照和磁盘现在比出来的，不是 Git
            的未提交状态）；Agent 的正式产出（artifact）在「成果」标签。
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {skipped.length > 0 ? <SkippedNote items={skipped} /> : null}
            {diffError ? (
              <p className="mb-2 text-2xs" style={{ color: colorOf('failed') }}>
                读取改动失败：{diffError}
              </p>
            ) : null}
            <DiffViewer files={diffs} />
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
          {/*
            没有文件**不等于**没事:跳过项和读取失败要单独说出来，
            否则用户看到的就是一句「没有改动」，而真实情况可能是「全被跳过」。
          */}
          {skipped.length > 0 || diffError ? (
            <div className="w-full max-w-md text-2xs">
              {diffError ? (
                <p className="mb-1" style={{ color: colorOf('failed') }}>
                  读取这条对话的改动失败：{diffError}
                </p>
              ) : null}
              {skipped.length > 0 ? <SkippedNote items={skipped} /> : null}
            </div>
          ) : null}
          <EmptyState
            icon={<GitCompareArrows size={28} />}
            title={skipped.length > 0 || diffError ? '这批改动没有可显示的文件' : '还没有改动'}
            description="让 Agent 改点东西，这里会列出它刚改过的文件。Agent 的正式产出（artifact）在「成果」标签。"
          />
        </div>
      )}
    </div>
  )
}

/** 「没算进 diff 的文件及原因」—— 两处共用同一段话，免得两种说法 */
function SkippedNote({ items }: { items: readonly string[] }) {
  return (
    <p className="mb-2 text-2xs" style={{ color: colorOf('warning') }}>
      ⚠ 有 {items.length} 项没算进这次对比：{items.join('；')}
    </p>
  )
}
