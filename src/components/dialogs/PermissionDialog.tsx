import { AlertTriangle } from 'lucide-react'
import { useUIStore } from '@/stores/useUIStore'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useRef } from 'react'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   危险操作确认 / 写操作确认

   两个来源共用这一个弹窗：
     · 界面自己的危险操作（删线程、重置数据）
     · **模型要写文件 / 跑命令**时的权限确认
   后者要求「取消」也要回话，否则主进程会一直挂着等 —— 所以走 onCancel。
   ══════════════════════════════════════════════════════════════ */

export function PermissionDialog() {
  const permission = useUIStore((s) => s.permission)
  const closePermission = useUIStore((s) => s.closePermission)

  /* 记录这次弹窗是不是已经被「确认」处理过了 —— 避免确认后又触发一次 onCancel */
  const confirmedRef = useRef(false)

  const open = permission !== null

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
      description={permission?.kind === 'run-command' ? '这会真的在你机器上执行命令' : undefined}
      width="sm"
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
              permission?.danger === true ? '!bg-danger !text-white hover:!bg-danger/90' : undefined
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
        </div>
      </div>
    </Modal>
  )
}
