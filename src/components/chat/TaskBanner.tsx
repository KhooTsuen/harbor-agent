import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, History, RotateCcw, X } from 'lucide-react'
import type { ChangeSetSummary, TaskRecord } from '@/types/backend'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'
import { PlanCard } from './PlanCard'
import { changesetList, changesetRollback, taskUpdate } from '@/lib/safetyApi'
import { useTaskStore } from '@/stores/useTaskStore'

/* ══════════════════════════════════════════════════════════════
   任务横幅

   长期 Agent 最容易被忽略的一件事：**上次那个活干完了吗？**
   没有它的话，程序一关，任务就消失了 —— 用户得自己回忆到哪一步了。

   这条横幅回答三个问题：
     · 有没有没干完的任务（能一键接着做）
     · 刚才那轮改了什么（几个文件）
     · 改错了能不能撤（一键回滚整批改动）

   只在「有未完成任务」或「有可撤销的改动」时出现，平时不占地方。
   ══════════════════════════════════════════════════════════════ */

export function TaskBanner() {
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const activeStatus = useAppStore(
    (s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.status,
  )
  const showToast = useUIStore((s) => s.showToast)

  /* 未完成任务改成从 store 读（侧栏黄点也用它） */
  const allTasks = useTaskStore((s) => s.unfinished)
  const refreshTasks = useTaskStore((s) => s.refresh)
  const [changesets, setChangesets] = useState<ChangeSetSummary[]>([])
  const [busy, setBusy] = useState('')
  const [hidden, setHidden] = useState(false)

  const refresh = useCallback(async () => {
    const [, list] = await Promise.all([refreshTasks(), changesetList({ limit: 5 })])
    /* 只看「提交过、还没撤、真改过文件」的那种 */
    setChangesets(list.filter((c) => c.status === 'committed' && c.fileCount > 0))
  }, [refreshTasks])

  useEffect(() => {
    /* 进入会话或这一轮写入新消息后刷新；空闲时不常驻轮询。 */
    void refresh()
  }, [activeThreadId, activeStatus, refresh])

  async function resume(task: TaskRecord): Promise<void> {
    setBusy(task.id)
    if (task.sessionId) setActiveThread(task.sessionId)
    showToast('success', '已切到那条会话', `继续：${task.title}`)
    setBusy('')
    setHidden(true)
  }

  async function giveUp(task: TaskRecord): Promise<void> {
    setBusy(task.id)
    await taskUpdate(task.id, { status: 'cancelled' })
    await refresh()
    setBusy('')
    showToast('info', '已放弃这条任务', task.title)
  }

  async function rollback(changeset: ChangeSetSummary): Promise<void> {
    setBusy(changeset.id)
    const result = await changesetRollback(changeset.id)
    setBusy('')
    if (!result.ok) {
      showToast('error', '撤销失败', '看日志里怎么说')
      return
    }
    const failed = result.failed.length
    showToast(
      failed > 0 ? 'warning' : 'success',
      '已撤销这次改动',
      `恢复 ${result.restored.length} 个 · 删除 ${result.removed.length} 个` +
        (failed > 0 ? ` · ${failed} 个没恢复成功（可能太大没快照）` : ''),
    )
    await refresh()
  }

  /*
   * ★ 只显示**当前这条对话**的未完成任务。
   * 以前显示的是全部 —— 于是不管切到哪条对话都在弹同一个横幅（用户抱怨过）。
   * 别的对话有没有未完成，看侧栏那个黄点就够了。
   */
  const tasks = allTasks.filter((task) => task.sessionId === activeThreadId)

  if (hidden || tasks.length === 0) return null
  if (tasks.length === 0 && changesets.length === 0) return null

  return (
    <div className="mx-4 mt-2 flex flex-col gap-1.5">
      {tasks.length > 0 ? (
        <div
          className="flex items-start gap-2 rounded-base border px-3 py-2"
          style={{ borderColor: 'var(--warning)', background: 'var(--bg-raised)' }}
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} />
          <div className="min-w-0 flex-1">
            <p className="text-dense text-fg-primary">有一条没干完的任务：{tasks[0].title}</p>
            <p className="mt-0.5 text-2xs text-fg-tertiary">
              已执行 {tasks[0].steps.length} 步 · 改了 {tasks[0].changedFiles.length} 个文件
              {tasks.length > 1 ? ` · 另外还有 ${tasks.length - 1} 条` : ''}
            </p>
            {/* AG-004：计划单独看得见（含版本历史），不再只给一个「N 步」的数字 */}
            <PlanCard versions={tasks[0].planVersions ?? []} />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              icon={<History size={12} />}
              loading={busy === tasks[0].id}
              onClick={() => void resume(tasks[0])}
            >
              继续
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void giveUp(tasks[0])}>
              放弃
            </Button>
          </div>
        </div>
      ) : null}

      {changesets.length > 0 ? (
        <div className="flex items-start gap-2 rounded-sm border border-line-hairline bg-bg-raised/40 px-3 py-1.5">
          <RotateCcw size={13} className="mt-0.5 shrink-0 text-fg-tertiary" />
          <p className="min-w-0 flex-1 text-2xs text-fg-secondary">
            最近一次改动：{changesets[0].fileCount} 个文件
            {changesets[0].files[0] ? ` · ${changesets[0].files[0].split(/[\\/]/).pop()}` : ''}
            {changesets[0].fileCount > 1 ? ' 等' : ''}
          </p>
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw size={12} />}
            loading={busy === changesets[0].id}
            onClick={() => void rollback(changesets[0])}
          >
            撤销这些改动
          </Button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setHidden(true)}
        className="flex items-center gap-1 self-end text-2xs text-fg-tertiary transition-colors hover:text-fg-secondary"
      >
        <X size={11} /> 本次先不显示
      </button>
    </div>
  )
}
