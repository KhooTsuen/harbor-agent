import type { AuditEntry } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   审计流水怎么折成「会话 → 任务 → 同类调用」（真机反馈 8）

   用户的原话是「想知道 AI 都干了什么」。而原来的审计是一列**平铺**的记录：
   60 条 read_file 掺着 3 条 run_shell，一眼看不出「那次任务到底动了什么」。

   所以折三层：
     · 会话：同一场对话干的事放一起（换机器、重开会话之后也认得出来）；
     · 任务：一次任务里的一连串工具调用；
     · 同类：同一个工具连着调 12 次 → 一行「read_file × 12」，
       点开才展开成 12 条（否则这一类就把列表刷满了）。

   折法是**纯函数**：只有它算得对，上面的组件才画得对，所以单独测。
   ══════════════════════════════════════════════════════════════ */

/** 同一个工具在同一个任务里的若干次调用 */
export interface AuditRun {
  tool: string
  /** 新的在前 */
  entries: AuditEntry[]
  failed: number
  totalMs: number
}

export interface AuditTaskGroup {
  taskId: string
  runs: AuditRun[]
  count: number
}

export interface AuditSessionGroup {
  sessionId: string
  tasks: AuditTaskGroup[]
  count: number
  failed: number
}

/**
 * 折成三层。
 *
 * 顺序：整体按时间**倒序**（最新的事在最上面）；会话之间按它们最新那条排；
 * 任务与同类组份内也是「新的在前」—— 所以下面按 ts 降序遍历一次就能就位。
 *
 * 空 `sessionId` / `taskId` 不丢：归到「没指定」那一桶（它们确实发生过，
 * 比如不挂任务的对话里调的工具）。
 */
export function groupAudit(entries: readonly AuditEntry[]): AuditSessionGroup[] {
  const sessions = new Map<string, AuditSessionGroup>()
  const sorted = [...entries].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))

  for (const entry of sorted) {
    const sessionId = String(entry.sessionId ?? '')
    let session = sessions.get(sessionId)
    if (!session) {
      session = { sessionId, tasks: [], count: 0, failed: 0 }
      sessions.set(sessionId, session)
    }
    session.count += 1
    if (entry.ok === false) session.failed += 1

    const taskId = String(entry.taskId ?? '')
    let task = session.tasks.find((t) => t.taskId === taskId)
    if (!task) {
      task = { taskId, runs: [], count: 0 }
      session.tasks.push(task)
    }
    task.count += 1

    const tool = String(entry.tool ?? '未知工具')
    let run = task.runs.find((r) => r.tool === tool)
    if (!run) {
      run = { tool, entries: [], failed: 0, totalMs: 0 }
      task.runs.push(run)
    }
    run.entries.push(entry)
    if (entry.ok === false) run.failed += 1
    run.totalMs += Number(entry.ms) || 0
  }

  return [...sessions.values()]
}

/** 一条同类型调用的标题，如 `read_file × 12`（只有一次就不写 ×1） */
export function runLabel(run: AuditRun): string {
  return run.entries.length > 1 ? `${run.tool} × ${run.entries.length}` : run.tool
}
