import { clearAllSessions, useRealBackend } from './backend'
import { backupCreate, clearMemory, getMemory, setMemory } from './extrasApi'
import { memoryList } from './memoryApi'
import { auditClear, taskRemoveMany } from './safetyApi'

/* ══════════════════════════════════════════════════════════════
   统一删除：分档清数据（每档都要能说清「删什么、能不能拿回来」）

   规矩只有两条，都在这一层落地，界面照做就行：
     ① **删之前强制自动备份**，备份失败就不许删（backupBeforeWipe）
     ② 用的全是**已有通道**：session:removeAll / task:removeMany /
        memory:clear / audit:clear。没有为这个面板新开通道。

   ⚠️ 备份盖不住的东西要照实说（见 BACKUP_MISSES）：
     内核 backup.cjs 的清单只有 config.json / memory.md / sessions / skills。
     任务台账、审计日志、结构化记忆（memory.json）都不在里面 ——
     这三档删了，只有「导出全部」那一份 JSON 能救。
   ══════════════════════════════════════════════════════════════ */

export type WipeId = 'sessions' | 'tasks' | 'memory' | 'audit'

export interface WipeOutcome {
  ok: boolean
  removed: number
  /** 想删但删不掉的条数（正在跑的任务） */
  skipped: number
  error?: string
}

/** 自动备份**含**这些（内核 backup.cjs 的 ITEMS，照抄） */
export const BACKUP_COVERS = ['config.json', 'memory.md', 'sessions', 'skills']
/** 自动备份**不含**这些 —— 面板必须写出来，否则用户以为删了还能恢复 */
export const BACKUP_MISSES = ['任务台账', '审计日志', '结构化记忆（memory.json）']

/**
 * 内核 task.cjs 的 LIVE_STATUSES —— 这两个状态删不掉（内核跳过并在 skipped 里报回来）。
 * 自检组 69 会拿内核的 STATUSES 校验这份清单有没有漏状态。
 */
export const TASK_LIVE_STATUSES: readonly string[] = ['running', 'waiting_user']
/** 除上面两个之外，其余都能删 */
export const TASK_DELETABLE_STATUSES: readonly string[] = [
  'paused',
  'completed',
  'failed',
  'cancelled',
]

function bridgeMissing(): WipeOutcome {
  return { ok: false, removed: 0, skipped: 0, error: '浏览器预览没有主进程，删不了东西' }
}

/** 会话：session:removeAll（一次全删，内核自己会连同索引一起清） */
async function wipeSessions(): Promise<WipeOutcome> {
  if (!useRealBackend) return bridgeMissing()
  const removed = await clearAllSessions()
  return { ok: true, removed, skipped: 0 }
}

/** 任务台账：task:removeMany 按状态批量删，正在跑的内核会挡下来 */
async function wipeTasks(): Promise<WipeOutcome> {
  if (!useRealBackend) return bridgeMissing()
  const result = await taskRemoveMany({ statuses: [...TASK_DELETABLE_STATUSES] })
  return { ok: true, removed: result.removed, skipped: result.skipped }
}

/**
 * 记忆：结构化记忆（memory.json，含已废弃的）+ 旧版整篇（memory.md）。
 * 两个都清才算「清干净」—— 只清 store 会剩下一份整篇记忆还在往提示里塞。
 */
async function wipeMemory(): Promise<WipeOutcome> {
  if (!useRealBackend) return bridgeMissing()
  const [items, text] = await Promise.all([memoryList({ includeSuperseded: true }), getMemory()])
  const hadText = text.text.trim().length > 0
  const cleared = await clearMemory()
  if (!cleared.ok) return { ok: false, removed: 0, skipped: 0, error: '清空记忆失败' }
  if (hadText) await setMemory('')
  return { ok: true, removed: items.length + (hadText ? 1 : 0), skipped: 0 }
}

/** 审计日志：audit:clear 删的是按天的 jsonl 文件 */
async function wipeAudit(): Promise<WipeOutcome> {
  if (!useRealBackend) return bridgeMissing()
  const result = await auditClear()
  return { ok: result.ok, removed: result.removed, skipped: 0, error: result.ok ? undefined : '清空审计失败' }
}

export interface WipeTier {
  id: WipeId
  label: string
  /** 删的是什么 */
  what: string
  /** 删完能不能恢复 —— 一句话，不含糊 */
  recover: string
  run: () => Promise<WipeOutcome>
}

export const WIPE_TIERS: readonly WipeTier[] = [
  {
    id: 'sessions',
    label: '删除全部对话',
    what: '删掉 data/sessions 里全部会话（含消息、压缩点、分支）；任务台账不跟着走，要用下面那档',
    recover: '备份里有会话，能从「备份与恢复」整份恢复回来；单独一条捡不回来',
    run: wipeSessions,
  },
  {
    id: 'tasks',
    label: '删除任务台账',
    what: '删掉任务运行记录（计划、步骤、改了哪些文件、命令）',
    recover: '不自动备份 —— 删了就真没了',
    run: wipeTasks,
  },
  {
    id: 'memory',
    label: '清空记忆',
    what: '清掉结构化记忆与旧版整篇记忆',
    recover: '不自动备份 —— 删了就真没了',
    run: wipeMemory,
  },
  {
    id: 'audit',
    label: '清空审计日志',
    what: '删掉按天的审计 jsonl（谁在什么时候拿什么权限做了什么）',
    recover: '不自动备份 —— 删了就真没了',
    run: wipeAudit,
  },
]

/**
 * 删之前强制自动备份。
 * 备份失败**不返回 ok** —— 调用方必须中止删除，不许「失败了也照删」。
 */
export async function backupBeforeWipe(): Promise<{ ok: boolean; name?: string; error?: string }> {
  const result = await backupCreate()
  if (result.ok) return { ok: true, name: result.name }
  return { ok: false, error: result.error ?? '备份没成功' }
}

/** 依次跑完这几档，返回每档一行人话（「删除全部」用） */
export async function wipeMany(ids: readonly WipeId[]): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = []
  let ok = true
  for (const id of ids) {
    const tier = WIPE_TIERS.find((item) => item.id === id)
    if (!tier) continue
    const result = await tier.run()
    if (!result.ok) {
      ok = false
      lines.push(`${tier.label}：失败 —— ${result.error ?? '未知原因'}`)
      continue
    }
    const skipped = result.skipped > 0 ? `（${result.skipped} 条在跑，跳过）` : ''
    lines.push(`${tier.label}：${result.removed} 条${skipped}`)
  }
  return { ok, lines }
}
