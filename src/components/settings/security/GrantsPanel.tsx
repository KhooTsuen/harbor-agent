import { ShieldCheck, Trash2, X } from 'lucide-react'
import type { CapabilityGrant } from '@/types/backend'
import { capabilityRevoke, capabilityRevokeAll } from '@/lib/safetyApi'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'

/* ══════════════════════════════════════════════════════════════
   已放开的路径

   每一条都是用户点过「允许」才存在的。能一条条撤，也能全撤 ——
   「给出去的权限要能收回来」是这个面板存在的全部理由。
   ══════════════════════════════════════════════════════════════ */

export function GrantsPanel({
  grants,
  onChange,
}: {
  grants: CapabilityGrant[]
  onChange: () => void
}) {
  const showToast = useUIStore((s) => s.showToast)

  if (grants.length === 0) {
    return <p className="py-2 text-dense text-fg-tertiary">还没有放过任何工作目录之外的路径。</p>
  }

  const MODE_LABEL = { permanent: '永久', session: '本会话', once: '一次性' } as const

  return (
    <div className="flex flex-col gap-1 py-1">
      {grants.map((grant) => (
        <div
          key={grant.path}
          className="flex items-center gap-2 rounded-sm border border-line-hairline bg-bg-raised/40 px-2 py-1.5"
        >
          <ShieldCheck size={13} className="shrink-0 text-fg-tertiary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-2xs text-fg-primary" title={grant.path}>
              {grant.path}
            </span>
            <span className="text-2xs text-fg-tertiary">
              {MODE_LABEL[grant.mode]}
              {grant.reason ? ` · ${grant.reason}` : ''}
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={<X size={12} />}
            onClick={() =>
              void capabilityRevoke(grant.path).then(() => {
                showToast('success', '已撤销', grant.path)
                onChange()
              })
            }
          >
            撤销
          </Button>
        </div>
      ))}
      <div className="pt-1">
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={12} />}
          onClick={() => void capabilityRevokeAll().then(onChange)}
        >
          全部撤销
        </Button>
      </div>
    </div>
  )
}
