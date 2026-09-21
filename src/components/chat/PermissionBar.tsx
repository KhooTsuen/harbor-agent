import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'
import { DiffViewer, sumDiff } from './DiffViewer'
import { colorOf } from '@/lib/statusLanguage'

/** 任务权限确认：属于 Composer 的布局流，不遮盖消息区或输入框。 */
export function PermissionBar() {
  const permission = useUIStore((s) => s.permission)
  const closePermission = useUIStore((s) => s.closePermission)
  const [expanded, setExpanded] = useState(false)

  /*
   * ★ 只负责**内核发起的**确认（跑命令 / 写文件 / MCP —— 渲染层统一标成 run-command）。
   *   应用自己的危险操作（删对话 / 清任务 / 清数据）走 PermissionDialog 那个模态框；
   *   两边都不加 kind 判断的话，同一个确认会**同时**出现两套 UI。
   */
  if (!permission || permission.kind !== 'run-command') return null

  const request = permission
  const diff = request.diff ?? []
  const impact = request.impact ?? []
  const stats = sumDiff(diff)

  function reject(): void {
    request.onCancel?.()
    closePermission()
  }

  function approve(): void {
    request.onConfirm()
    closePermission()
  }

  return (
    <section
      className="mb-2 max-h-[min(30vh,240px)] overflow-auto rounded-md border border-line-focus bg-bg-raised shadow-low"
      aria-label="等待确认"
      role="dialog"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full"
          style={{
            background: request.danger ? 'rgb(229 83 75 / 0.12)' : 'rgb(255 255 255 / 0.08)',
            color: request.danger ? colorOf('failed') : colorOf('warning'),
          }}
        >
          <AlertTriangle size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-xs font-medium text-fg-primary">{request.title}</h3>
              <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-2xs leading-relaxed text-fg-secondary">
                {request.description}
              </p>
            </div>
            <span className="shrink-0 text-2xs text-fg-tertiary">等待确认</span>
          </div>

          {impact.length > 0 ? (
            <div className="mt-2 rounded-sm border border-line-subtle bg-bg-base/40 px-2 py-1.5">
              <p className="text-2xs font-medium text-fg-secondary">影响预览</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-fg-tertiary">
                {impact.slice(0, 3).map((item) => (
                  <li key={item} className="truncate">
                    · {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {diff.length > 0 ? (
            <div className="mt-2 rounded-sm border border-line-subtle bg-bg-base/40">
              <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-2xs">
                <span className="text-fg-secondary">会改 {diff.length} 个文件</span>
                <span className="font-mono" style={{ color: 'var(--diff-add)' }}>
                  +{stats.additions}
                </span>
                <span className="font-mono" style={{ color: 'var(--diff-remove)' }}>
                  −{stats.deletions}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  aria-expanded={expanded}
                  className="flex items-center gap-1 rounded-sm px-1 text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary"
                >
                  {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  {expanded ? '收起' : '查看 Diff'}
                </button>
              </div>
              {request.diffNote ? (
                <p className="border-t border-line-subtle px-2 py-1 text-2xs text-fg-tertiary">
                  {request.diffNote}
                </p>
              ) : null}
              {expanded ? (
                <div className="max-h-56 overflow-auto border-t border-line-subtle p-2">
                  <DiffViewer files={diff} />
                </div>
              ) : null}
            </div>
          ) : request.diffNote ? (
            <p className="mt-2 truncate text-2xs text-fg-tertiary">{request.diffNote}</p>
          ) : null}

          <div className="mt-2 flex items-center justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={reject}>
              取消
            </Button>
            <Button variant={request.danger ? 'danger' : 'primary'} size="sm" onClick={approve}>
              {request.confirmText || '允许本次'}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
