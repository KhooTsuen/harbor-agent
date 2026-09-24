/* 审批中心的桥包装：读一口（`approvals:list`）和撤一刀（`approvals:revoke`）。

   从 safetyApi.ts 拆出来的 —— 那边被 prettier 格式化后顶过了 300 行红线
   （AGENT.md 硬约束 #2），审批中心本身就是一块完整的缝。
   类型定义在 ApprovalHistory.tsx —— `src/types/` 也顶在红线上，没往那儿塞。 */
import type { WorkbenchBridge } from '@/types/backend'
import type {
  ApprovalEntry,
  ApprovalRevokeResult,
} from '@/components/settings/security/ApprovalHistory'

const bridge: WorkbenchBridge | undefined =
  typeof window !== 'undefined' ? window.workbench : undefined

type ApprovalBridge = {
  approvalsList?: (options?: {
    taskId?: string
  }) => Promise<{ ok: boolean; items: ApprovalEntry[] }>
  approvalsRevoke?: (target: string) => Promise<ApprovalRevokeResult>
}
const approvalBridge = bridge as unknown as ApprovalBridge | undefined

/** 最近审批（最新在前，带来源标记和「能不能撤」）。拿不到桥时给空数组 */
export async function listApprovals(options?: { taskId?: string }): Promise<ApprovalEntry[]> {
  if (!approvalBridge?.approvalsList) return []
  try {
    return (await approvalBridge.approvalsList(options)).items ?? []
  } catch {
    return []
  }
}

/** 撤销一条审批：一次性审批撤不掉，`reason` 会说清楚为什么 */
export async function revokeApproval(target: string): Promise<ApprovalRevokeResult> {
  if (!approvalBridge?.approvalsRevoke) return { ok: false, reason: '浏览器预览里没有主进程' }
  try {
    return await approvalBridge.approvalsRevoke(target)
  } catch {
    return { ok: false }
  }
}
