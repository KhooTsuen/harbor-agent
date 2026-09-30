import { useEffect, useMemo, useState } from 'react'
import { Undo2 } from 'lucide-react'
import type { TaskRecord } from '@/types/safety'
import { taskList } from '@/lib/safetyApi'
import {
  describeRollback,
  rollbackApply,
  rollbackBridgeReady,
  rollbackImpact,
  rollbackPreview,
} from '@/lib/checkpointRollbackApi'
import { relativeTime } from '@/lib/utils'
import { useAgentActive } from '@/hooks/useAgentActive'
import { useTaskStore } from '@/stores/useTaskStore'
import { useUIStore } from '@/stores/useUIStore'
import { MenuItem, Popover } from '@/components/ui/Popover'

/* ══════════════════════════════════════════════════════════════
   「撤销检查点之后的改动」入口（AG-052）

   以前这条能力**一个界面入口都没有**：`changeset:rollbackTo` 在 preload / handler /
   IPC 清单三处都齐了，`src/**` 里零调用点（整批撤的「撤销」有入口）。用户点不到。

   位置：对话结束后下方、消息流末尾（就挂在最后一条消息后面）。
   形态：动作行 —— 和 VS Code 里「回答结束后的那排小按钮」一个意思。

   ★ 名字是**故意啰嗦**的：这条能力只能撤「这个检查点之后**才第一次**被改的文件」。
     叫它「回到检查点」会让人以为能回到那一刻的样子，而多轮反复改同一个文件时
     那个文件撤不动（内核头注释边界①）。所以界面上写全：
     「撤销检查点之后的改动」，并且确认框里把撤不动的文件**点名列出来**。

   三步，一步都不省：
     ① 点按钮 → 选撤到哪个检查点（列表来自任务台账的 `checkpoints[]`）；
     ② **干跑预览**（`rollbackPreview`，一个字都不写盘）→ 确认框里说清
        「会恢复哪些 / 会删哪些 / 哪些撤不动」；
     ③ 确认 → 真撤 → toast + 审查面板留一条回退记录。
   ══════════════════════════════════════════════════════════════ */

/** 菜单里最多列几个检查点（台账最多留 50 个，列全了菜单比屏幕还长） */
const MAX_MENU = 8

/**
 * 跑着的时候不给撤 —— 正在改文件的当口回退，撤到的是哪一份得看运气。
 * 只有这几种「已经停了」的状态才出这个入口。
 */
const SETTLED: readonly TaskRecord['status'][] = ['completed', 'failed', 'cancelled', 'paused']

/** 这条对话里最近有检查点的那条任务（回退按钮说的就是它） */
function newestCheckpoint(task: TaskRecord): number {
  const list = task.checkpoints ?? []
  return list.at(-1)?.at ?? 0
}

export function pickRollbackTarget(list: readonly TaskRecord[]): TaskRecord | null {
  const usable = list.filter((task) => (task.checkpoints?.length ?? 0) > 0)
  if (usable.length === 0) return null
  return usable.reduce((best, task) =>
    newestCheckpoint(task) > newestCheckpoint(best) ? task : best,
  )
}

export function CheckpointRollbackBar({ conversationId = '' }: { conversationId?: string }) {
  const active = useAgentActive(conversationId || undefined)
  const askPermission = useUIStore((s) => s.askPermission)
  const showToast = useUIStore((s) => s.showToast)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const setRightPanelVisible = useUIStore((s) => s.setRightPanelVisible)
  const noteRollback = useTaskStore((s) => s.noteRollback)

  const [task, setTask] = useState<TaskRecord | null>(null)
  const [open, setOpen] = useState(false)
  /* 正在算预览 / 正在撤 —— 按钮上转圈，防连点（这是破坏性操作） */
  const [busy, setBusy] = useState('')

  /*
   * 任务数据直接问内核要（`taskList` 带 sessionId）—— 不走任务快照的缓存：
   * 那份快照是按「任务中心当前看哪个范围」拉的，范围一换这里就可能查不到，
   * 而「撤不撤得动」不该受用户在看哪个项目的任务影响。
   * `active` 是依赖：一轮跑完（active 由 true 翻 false）正是检查点变多的时候。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      if (!conversationId || !rollbackBridgeReady()) {
        setTask(null)
        return
      }
      const list = await taskList({ limit: 20, sessionId: conversationId })
      if (alive) setTask(pickRollbackTarget(list))
    })()
    return () => {
      alive = false
    }
  }, [conversationId, active])

  const checkpoints = useMemo(() => (task?.checkpoints ?? []).slice(-MAX_MENU).reverse(), [task])

  if (!task || active || !SETTLED.includes(task.status) || checkpoints.length === 0) return null
  /* 收窄后的别名：函数声明会被提升，TS 不会把上面的非空判断带进函数体里 */
  const current = task

  /** 点到某个检查点：先干跑算清单，再问人 */
  async function pick(checkpointId: number, label: string): Promise<void> {
    setOpen(false)
    setBusy(String(checkpointId))
    const preview = await rollbackPreview(current.id, checkpointId)
    setBusy('')
    if (!preview.ok) {
      showToast('error', '撤不了', preview.error ?? '看日志里怎么说')
      return
    }
    askPermission({
      kind: 'rollback-checkpoint',
      title: `撤销「${label}」之后的改动？`,
      description:
        '只会撤「这个检查点之后才第一次被改的文件」；检查点之前的改动一律不动。' +
        (preview.skipped.length > 0
          ? `\n有 ${preview.skipped.length} 个文件是在检查点之前就改过的 —— 它们撤不动，会原样留着（下面列出来了）。`
          : '\n这个检查点之后的改动都在下面这张清单里。'),
      confirmText: '撤销这些改动',
      danger: true,
      impact: rollbackImpact(preview),
      onConfirm: () => {
        void apply(checkpointId, label)
      },
    })
  }

  /** 真撤：只有走到这儿才动盘 */
  async function apply(checkpointId: number, label: string): Promise<void> {
    setBusy(String(checkpointId))
    const result = await rollbackApply(current.id, checkpointId)
    setBusy('')
    if (!result.ok) {
      showToast('error', '撤销失败', result.error ?? '看日志里怎么说')
      return
    }
    /* 记一笔：审查面板顶上要显示「这次回退动了什么」（不只是弹一下就没了） */
    noteRollback({ taskId: current.id, checkpointLabel: label, at: Date.now(), result })
    showToast(
      result.failed.length > 0 ? 'warning' : 'success',
      `已撤销「${label}」之后的改动`,
      describeRollback(result, ''),
      {
        label: '看审查面板',
        onClick: () => {
          setActiveRightTab('diff')
          setRightPanelVisible(true)
        },
      },
    )
    /* 审查面板的 diff 得跟着变成撤完之后的样子。
       刷失败不影响已经撤完的结果 —— 别把刷新失败变成未处理的 Promise 拒绝 */
    void useTaskStore
      .getState()
      .refresh()
      .catch(() => {})
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="top"
        align="start"
        trigger={({ toggle }) => (
          <button
            type="button"
            onClick={toggle}
            disabled={busy !== ''}
            title="撤销「这个检查点之后才第一次被改的文件」。检查点之前的改动一律不动。"
            className="flex items-center gap-1.5 rounded-pill border border-line-hairline bg-bg-raised/50 px-2.5 py-1 text-2xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary disabled:opacity-60"
          >
            <Undo2 size={11} className={busy ? 'animate-pulse' : undefined} />
            撤销检查点之后的改动
          </button>
        )}
      >
        <p className="px-2 py-1 text-2xs text-fg-tertiary">撤到哪一刻？</p>
        {checkpoints.map((checkpoint) => (
          <MenuItem
            key={checkpoint.at}
            hint={`${relativeTime(checkpoint.at)}前`}
            onSelect={() => void pick(checkpoint.at, checkpoint.label)}
          >
            {checkpoint.label}
          </MenuItem>
        ))}
      </Popover>
      <span className="text-2xs text-fg-tertiary">
        最近一步：{checkpoints[0]?.label} · {relativeTime(checkpoints[0]?.at ?? 0)}前
      </span>
    </div>
  )
}
