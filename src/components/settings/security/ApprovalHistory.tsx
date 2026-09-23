import { useCallback, useEffect, useState } from 'react'
import { Clock3, ShieldCheck, X } from 'lucide-react'
import type { CapabilityGrant } from '@/types/backend'
import { Button } from '@/components/ui/Button'
import { useUIStore } from '@/stores/useUIStore'
import { colorOf } from '@/lib/statusLanguage'
import { clockTime } from '@/lib/utils'
import { listApprovals, revokeApproval } from '@/lib/safetyApi'
import { SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   审批记录（Approval Center 的最小切片）

   回答两个问题：

     ① 刚才那些确认框，我到底批了什么？（台账里的审批流水，只读）
     ② 现在手上还剩哪些**能收回来**的权限？（永久路径授权，可以撤）

   ②才是这一块存在的理由。一次性审批用完就没了，撤不回来也不用撤 ——
   真正需要「给出去还能收回」的只有永久授权，所以只有那几行带「撤销」。
   ══════════════════════════════════════════════════════════════ */

/** 这次批准管到哪儿 —— 和内核 `approval.cjs` 的 SCOPES 对齐 */
export type ApprovalScope = 'once' | 'session' | 'permanent'

/**
 * 审批中心的一行。
 * `source` 说明它是从哪儿来的：任务台账（`task`）还是授权文件（`capability`）；
 * `revocable` 是主进程算好的「这行能不能撤」，界面不自己猜。
 */
export interface ApprovalEntry {
  requestId: string
  kind: string
  name: string
  at: number
  approved: boolean
  timedOut: boolean
  scope: ApprovalScope
  source: 'task' | 'capability'
  revocable: boolean
}

/** 撤销的结果：撤不掉时 `reason` 说明为什么（比如「一次性审批」） */
export interface ApprovalRevokeResult {
  ok: boolean
  reason?: string
}

const SCOPE_LABEL: Record<ApprovalScope, string> = {
  once: '一次性',
  session: '本会话',
  permanent: '永久',
}

const KIND_LABEL: Record<string, string> = {
  write: '写文件',
  mcp: 'MCP 工具',
  risk: '高危命令',
  path: '路径授权',
}

export function ApprovalHistory({
  grants,
  onChange,
}: {
  grants: CapabilityGrant[]
  onChange: () => void
}) {
  const showToast = useUIStore((s) => s.showToast)
  const [items, setItems] = useState<ApprovalEntry[]>([])

  const refresh = useCallback(async () => {
    setItems(await listApprovals())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /*
   * 兜底：聚合通道没接上时（浏览器预览里没有桥）`listApprovals()` 给空数组 ——
   * 那就退回用 SecurityTab 已经拿到的 grants 画。至少「哪些永久授权能撤」这一半是准的。
   */
  const rows: ApprovalEntry[] = items.length > 0 ? items : permanentRows(grants)

  const revoke = (entry: ApprovalEntry): void => {
    void revokeApproval(entry.name).then((result) => {
      if (!result.ok) {
        showToast('warning', '撤不掉', result.reason ?? '这条审批不是永久授权')
        return
      }
      showToast('success', '已撤销', entry.name)
      onChange()
      void refresh()
    })
  }

  return (
    <>
      <SectionTitle hint="最近确认过什么 · 哪些权限还能收回">审批记录</SectionTitle>
      {rows.length === 0 ? (
        <p className="py-2 text-2xs text-fg-tertiary">还没有需要你确认的操作。</p>
      ) : (
        <div className="flex flex-col gap-0.5 py-1">
          {rows.map((entry) => (
            <div
              key={entry.requestId || `${entry.source}:${entry.name}`}
              className="flex items-center gap-2 rounded-sm border border-line-hairline bg-bg-raised/40 px-2 py-1.5"
            >
              <Clock3 size={12} className="shrink-0 text-fg-tertiary" />
              <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
                {clockTime(entry.at)}
              </span>
              <span className="shrink-0 text-2xs text-fg-secondary">
                {KIND_LABEL[entry.kind] ?? entry.kind}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-primary"
                title={entry.name}
              >
                {entry.name || '—'}
              </span>
              <span className="shrink-0 text-2xs" style={{ color: statusColor(entry) }}>
                {statusLabel(entry)}
              </span>
              <span className="w-12 shrink-0 text-right text-2xs text-fg-tertiary">
                {SCOPE_LABEL[entry.scope]}
              </span>
              {entry.revocable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X size={12} />}
                  onClick={() => revoke(entry)}
                >
                  撤销
                </Button>
              ) : (
                /* 占位：撤不掉的（一次性审批）也占住那块宽度，免得每行按钮位置不一样 */
                <ShieldCheck size={13} className="shrink-0 text-fg-tertiary" />
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** 这次批准最后是个什么结果（超时和「用户点了拒绝」要分得开） */
function statusLabel(entry: ApprovalEntry): string {
  if (entry.timedOut) return '超时（按拒绝处理）'
  return entry.approved ? '允许' : '拒绝'
}

function statusColor(entry: ApprovalEntry): string | undefined {
  return entry.approved && !entry.timedOut ? undefined : colorOf('warning')
}

/** grants → 审批中心的行（只在聚合通道拿不到东西时用） */
function permanentRows(grants: CapabilityGrant[]): ApprovalEntry[] {
  return grants
    .filter((grant) => grant.mode === 'permanent')
    .map((grant) => ({
      requestId: '',
      kind: 'path',
      name: grant.path,
      at: grant.grantedAt,
      approved: true,
      timedOut: false,
      scope: 'permanent',
      source: 'capability',
      revocable: true,
    }))
}
