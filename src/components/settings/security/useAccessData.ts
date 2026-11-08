import { useCallback, useEffect, useState } from 'react'
import type { AuditEntry, CapabilityGrant, CredentialsStatus } from '@/types/backend'
import { auditList, auditStats, capabilityList, credentialsStatus } from '@/lib/safetyApi'

/* ══════════════════════════════════════════════════════════════
   「权限与安全」页的数据 —— **一处拉取，四个分组共用**

   ── 为什么要提到这里 ──────────────────────────────────────────
   拆成四个分组之后，`grants` 被两组用到（当前有效授权、审批记录），
   审计的 entries/stats 又被另一组用到。如果每组各拉一次：
     · 切回同一组会重拉（用户看到闪一下「读取中」）
     · 同一份授权在两组里可能显示成不同状态（两个时刻的快照）
   所以统一提到页面层，分组只负责画。

   ── 桌面版与浏览器预览 ────────────────────────────────────────
   预览环境没有主进程，四个接口都会回空。`ready` 用来区分
   「还没读完」与「读完了但确实没有」，不让空态冒充加载中。
   ══════════════════════════════════════════════════════════════ */

export interface AccessData {
  grants: CapabilityGrant[]
  entries: AuditEntry[]
  stats: { total: number; failed: number; denied: number }
  creds: CredentialsStatus | null
  loading: boolean
  /** 桌面桥是否存在 —— 没有的话四个面板都只能显示说明，不能画成空表 */
  ready: boolean
  refresh: () => void
  onlyProblems: boolean
  setOnlyProblems: (value: boolean) => void
}

export function useAccessData(): AccessData {
  const [grants, setGrants] = useState<CapabilityGrant[]>([])
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [stats, setStats] = useState({ total: 0, failed: 0, denied: 0 })
  const [creds, setCreds] = useState<CredentialsStatus | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)

  const refresh = useCallback(() => {
    let alive = true
    setLoading(true)
    void (async () => {
      const [g, a, s, c] = await Promise.all([
        capabilityList(),
        auditList({ limit: 60, onlyProblems }),
        auditStats(7),
        credentialsStatus(),
      ])
      if (!alive) return
      setGrants(g)
      setEntries(a.entries)
      setStats(s)
      setCreds(c)
      /* 任何一项拿得到东西就说明桌面桥在 —— 四项全空才当成预览环境 */
      setReady(Boolean(c) || g.length > 0 || a.entries.length > 0)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [onlyProblems])

  useEffect(() => refresh(), [refresh])

  return { grants, entries, stats, creds, loading, ready, refresh, onlyProblems, setOnlyProblems }
}
