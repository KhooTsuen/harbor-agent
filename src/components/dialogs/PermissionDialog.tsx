import { useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { useUIStore } from '@/stores/useUIStore'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { DiffViewer, sumDiff } from '@/components/chat/DiffViewer'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   危险操作确认 / 写操作确认

   两个来源共用这一个弹窗：
     · 界面自己的危险操作（删线程、重置数据）
     · **模型要写文件 / 跑命令**时的权限确认
   后者要求「取消」也要回话，否则主进程会一直挂着等 —— 所以走 onCancel。

   ── AG-036 Diff First ──
   「必须让用户明确看到修改内容」：写文件时内核会把**会改成什么**算成 diff
   一起送来。默认**折叠**（只给一行「+4 −3」和「查看 Diff」），点开才展开 ——
   每次都铺一大块会把弹窗冲烂，而点开是零成本的。
   ── 确认呈现 ──
   权限确认使用 anchored 形态：贴在输入区上方、不遮罩、不抢页面点击。点击窗口外不会
   触发拒绝，只有「允许本次」或「取消」会答复主进程。
   ══════════════════════════════════════════════════════════════ */
export function PermissionDialog() {
  const permission = useUIStore((s) => s.permission)
  const closePermission = useUIStore((s) => s.closePermission)
  /* 换了请求要重新折叠 —— 记「展开的是哪一次」而不是一个 boolean */
  const [expandedFor, setExpandedFor] = useState<string | null>(null)

  /* 记录这次弹窗是不是已经被「确认」处理过了 —— 避免确认后又触发一次 onCancel */
  const confirmedRef = useRef(false)
  const open = permission !== null
  const impact = permission?.impact ?? []
  const diff = permission?.diff ?? []
  const stats = sumDiff(diff)
  const key = `${permission?.title ?? ''}|${permission?.description ?? ''}`
  const expanded = expandedFor === key

  if (!permission || permission.kind === 'run-command') return null

  function handleClose(): void {
    if (!confirmedRef.current) permission?.onCancel?.()
    confirmedRef.current = false
    closePermission()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={permission?.title ?? ''}
      width="xl"
      variant="anchored"
      showClose={false}
      disableBackdropClose
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={handleClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              confirmedRef.current = true
              permission?.onConfirm()
              closePermission()
              confirmedRef.current = false
            }}
            className={
              permission?.danger === true
                ? '!bg-danger !text-fg-on-emphasis hover:!bg-danger/90'
                : undefined
            }
          >
            {permission?.confirmText ?? '确定'}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        {permission?.danger === true ? (
          <span
            className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full"
            style={{ background: 'rgb(229 83 75 / 0.12)', color: colorOf('failed') }}
          >
            <AlertTriangle size={16} />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-secondary">
            {permission?.description ?? ''}
          </p>

          {/*
            写文件：这是会改成什么。
            有 diff 才出现这一行 —— 跑命令、访问目录之外的路径都没有 diff，
            它们靠上面的摘要说明。
          */}
          {impact.length > 0 ? (
            <div className="mt-3 rounded-sm border border-line-subtle bg-bg-base/40 px-2 py-1.5">
              <p className="text-2xs font-medium text-fg-secondary">影响预览</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-fg-tertiary">
                {impact.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {diff.length > 0 ? (
            <div className="mt-3 rounded-sm border border-line-subtle bg-bg-base/40">
              <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-2xs">
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
                  onClick={() => setExpandedFor(expanded ? null : key)}
                  aria-expanded={expanded}
                  className="flex items-center gap-1 rounded-sm px-1 text-fg-tertiary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
                >
                  {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  {expanded ? '收起' : '查看 Diff'}
                </button>
              </div>
              {permission?.diffNote ? (
                <p className="border-t border-line-subtle px-2 py-1 text-2xs text-fg-tertiary">
                  {permission.diffNote}
                </p>
              ) : null}
              {expanded ? (
                <div className="max-h-72 overflow-auto border-t border-line-subtle p-2">
                  <DiffViewer files={diff} />
                </div>
              ) : null}
            </div>
          ) : permission?.diffNote ? (
            <p className="mt-3 text-2xs text-fg-tertiary">{permission.diffNote}</p>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
