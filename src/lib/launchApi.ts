import type { TestStatusInfo } from '@/types/safety'
import type { TaskRecoveryItem } from '@/types/safety'
import type { WorkspaceSummary } from '@/types/workspace'

/* ══════════════════════════════════════════════════════════════
   开屏数据源（只读）

   三种调用都有同一个纪律：**失败返回 null/空，让开屏降级显示**，
   不抛异常、不重试风暴、不在热路径上轮询 ——
   开屏是「看一眼就走」的东西，不该挡输入（设计文档 §17/§18）。
   浏览器预览（没有桥）与 Electron 走同一套代码，这里收口。
   ══════════════════════════════════════════════════════════════ */

function api(): Window['workbench'] {
  return typeof window !== 'undefined' ? window.workbench : undefined
}

/** 工作区总览：名字 / 技术栈 / 测试入口 / Git 摘要 */
export async function scanWorkspace(dir: string): Promise<WorkspaceSummary | null> {
  const bridge = api()
  if (!bridge?.workspaceScan) return null
  try {
    return await bridge.workspaceScan(dir)
  } catch {
    return null
  }
}

/** 最近一次测试的结论（判据在内核，跟「航道畅通」彩蛋同源） */
export async function latestTestStatus(workdir: string): Promise<TestStatusInfo | null> {
  const bridge = api()
  if (!bridge?.taskTestStatus) return null
  try {
    return await bridge.taskTestStatus({ workdir })
  } catch {
    return null
  }
}

/** 没完成的活（暂停 / 等确认）—— 开屏的「最近工作」用，按更新时间新→旧 */
export async function unfinishedTasks(workdir: string): Promise<TaskRecoveryItem[]> {
  const bridge = api()
  if (!bridge?.taskRecovery) return []
  try {
    const result = await bridge.taskRecovery({ workdir })
    const items = result?.items ?? []
    return items
      .filter((item) => item.status === 'paused' || item.status === 'waiting_user')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  } catch {
    return []
  }
}
