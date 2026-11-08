import { RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Row, SectionTitle } from '../parts'
import { AuditPanel } from './AuditPanel'
import { GrantsPanel } from './GrantsPanel'
import { ApprovalHistory } from './ApprovalHistory'
import { useAccessData } from './useAccessData'
import { useUIStore } from '@/stores/useUIStore'
import { auditClear } from '@/lib/safetyApi'

/* ══════════════════════════════════════════════════════════════
   授权与审计 —— 「它现在还能做什么、过去做过什么」

   ── 两个概念必须分开摆（这一组的全部意义）────────────────────
     ① **当前有效授权** —— 现在还开着的口子。可以撤，撤了立刻生效。
        来源是 `capabilityList()`（内核里那份授权表，不是别处的副本）。
     ② **过去的审批记录** —— 已经发生过的事，撤销它不会「回到没发生」。
        来源是审计流水里那些「问过 / 批过」的条目。

   原来这两块分在两处且顺序颠倒（先审批记录、后授权），用户容易把
   「历史里同意过」当成「现在还开着」。现在顺序固定：先能撤的，再历史。
   ══════════════════════════════════════════════════════════════ */

export function AccessAuditGroup(): React.ReactElement {
  const { grants, entries, stats, loading, ready, refresh, onlyProblems, setOnlyProblems } =
    useAccessData()
  const showToast = useUIStore((s) => s.showToast)

  if (!ready && !loading) {
    return (
      <p className="px-3 py-3 text-dense leading-relaxed text-fg-tertiary">
        授权记录与审计日志需要桌面版（浏览器预览没有主进程）。这一页在桌面版里能看到
        「现在还开着哪些口子」和「它实际做了什么」。
      </p>
    )
  }

  return (
    <>
      <SectionTitle hint="现在还开着的口子 · 撤了立刻生效">当前有效授权</SectionTitle>
      {loading && grants.length === 0 ? (
        <p className="px-3 py-2 text-dense text-fg-tertiary">读取中…</p>
      ) : (
        <GrantsPanel grants={grants} onChange={refresh} />
      )}

      {/* 「审批记录」的标题在 ApprovalHistory 里（它自带，并且那段会按需降级）——
          外面再写一个就是同名分组出现两次，第四阶段的真机探针逮到过。 */}
      <ApprovalHistory grants={grants} onChange={refresh} />

      <SectionTitle hint="谁、什么时候、用什么权限、做了什么、成功没有">审计日志</SectionTitle>
      <Row label="记录工具调用" hint="参数里的密钥会自动打码；关掉只是不再记新的，已有的记录不动">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-dense text-fg-primary">
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
            />
            只看失败的
          </label>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={12} />}
            onClick={refresh}
            loading={loading}
          >
            刷新
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={12} />}
            onClick={() =>
              void auditClear().then((r) => {
                showToast('success', '已清空', `删了 ${r.removed} 个文件`)
                refresh()
              })
            }
          >
            清空
          </Button>
        </div>
      </Row>

      <p className="pb-1 text-2xs text-fg-tertiary">
        最近 7 天：{stats.total} 次调用 · 失败 {stats.failed} · 被拒 {stats.denied}
      </p>

      <AuditPanel entries={entries} />
    </>
  )
}
