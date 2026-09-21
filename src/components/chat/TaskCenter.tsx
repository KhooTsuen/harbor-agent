import { useEffect, useMemo, useState } from 'react'
import { CircleDot, RefreshCw, RotateCcw } from 'lucide-react'
import type { ChangeSetSummary, TaskRecord } from '@/types/safety'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/useAppStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { changesetRollback, taskRemoveMany, taskRemoveSafe, taskUpdate } from '@/lib/safetyApi'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { TASK_GROUPS, groupTasks } from './taskCenterModel'
import { TaskRow } from './TaskRow'

/* ══════════════════════════════════════════════════════════════
   后台任务中心（AG-028）

   数据只来自 useTaskStore → 后端 task.cjs，不另造一份任务真相。

   AG-028 收尾：对话顶部那条横幅**整个撤掉了**，它的能力（继续 / 放弃 /
   计划版本 / 时间线 / 环境变化警告 / 撤销最近一次改动）全部并到这里 ——
   任务相关的东西只在一个地方出现。打开应用不会再先看到一条黄条
   （用户反馈「一打开 Agent 有点迷茫」），未完成的任务改由启动提示
   指向这里。
   ══════════════════════════════════════════════════════════════ */

/** 这两个分组不给「清空」—— 任务在跑或等你确认，该做的是停止/回答，不是删记录 */
const LIVE_GROUPS: readonly TaskRecord['status'][] = ['running', 'waiting_user']

export function TaskCenter() {
  const tasks = useTaskStore((s) => s.tasks)
  const unfinished = useTaskStore((s) => s.unfinished)
  const changesets = useTaskStore((s) => s.changesets)
  const loaded = useTaskStore((s) => s.loaded)
  const refresh = useTaskStore((s) => s.refresh)

  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const activeProject = useAppStore((s) =>
    s.projects.find((project) => project.id === s.activeProjectId),
  )
  const projectWorkdir = activeProject?.path ?? ''
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  /* 相位只有当前对话有 —— 别的对话的任务只显示计划与步骤 */
  const phases = useAppStore(
    (s) => s.threads.find((t) => t.id === s.activeThreadId)?.phaseHistory ?? [],
  )
  const showToast = useUIStore((s) => s.showToast)
  const askPermission = useUIStore((s) => s.askPermission)

  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const contextLabel = activeProject?.name || '当前对话'

  useEffect(() => {
    void refresh(projectWorkdir)
  }, [projectWorkdir, refresh])

  /* 只有真的有任务在跑才走秒表；空闲时不留常驻 interval。 */
  const hasRunning = tasks.some((task) => task.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasRunning])

  const groups = useMemo(() => groupTasks(tasks), [tasks])
  /* 只有真的这一类才有东西时才算「活着的分组」（AG-030：不让零值占地方）*/
  const activeGroups = useMemo(
    () => TASK_GROUPS.filter((group) => (groups.get(group.status)?.length ?? 0) > 0),
    [groups],
  )
  const recoveryById = useMemo(
    () => new Map(unfinished.map((item) => [item.id, item])),
    [unfinished],
  )

  async function reload(): Promise<void> {
    setRefreshing(true)
    await refresh(projectWorkdir)
    setRefreshing(false)
  }

  /** 接着做：带上 resumeTaskId，主进程复用原任务，不重复已完成的步骤 */
  async function resume(task: TaskRecord): Promise<void> {
    setBusy(task.id)
    if (task.sessionId) setActiveThread(task.sessionId)
    useThreadStore.getState().resumeTask(task.id)
    showToast('success', '接着做', `继续：${task.title}`)
    setBusy('')
  }

  async function giveUp(task: TaskRecord): Promise<void> {
    setBusy(task.id)
    await taskUpdate(task.id, { status: 'cancelled' })
    await refresh(projectWorkdir)
    setBusy('')
    showToast('info', '已放弃这条任务', task.title)
  }

  /** 删一条任务的记录（在跑的不给删 —— 内核也会拒，这里把原因说出来） */
  async function removeTask(task: TaskRecord): Promise<void> {
    setBusy(task.id)
    const result = await taskRemoveSafe(task.id)
    setBusy('')
    if (result.ok) {
      showToast('success', '记录已删除', task.title)
      await refresh(projectWorkdir)
    } else {
      showToast('warning', '没能删除', result.reason ?? '这条任务现在还删不了')
    }
  }

  /**
   * 清空一组的记录。
   *
   * ★ 正在跑 / 等确认的分组**不给这个按钮** —— 那两类任务要么先停止、要么等它做完。
   *   而且真正的保险在内核：往里传 running 也会被忽略，并回一句「跳过了几条」。
   */
  async function clearGroup(
    status: TaskRecord['status'],
    label: string,
    count: number,
  ): Promise<void> {
    askPermission({
      kind: 'clear-tasks',
      title: `清空「${label}」的 ${count} 条记录？`,
      description: '这些任务记录会一起删掉，不能撤销。正在跑的任务不受影响。',
      confirmText: '清空',
      danger: true,
      onConfirm: () => {
        void (async () => {
          const result = await taskRemoveMany({ statuses: [status] })
          const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 条正在跑的` : ''
          showToast('success', '已清空', `删除 ${result.removed} 条记录${skipped}`)
          await refresh(projectWorkdir)
        })()
      },
    })
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
    await refresh(projectWorkdir)
  }

  if (!loaded) {
    return <p className="p-3 text-xs text-fg-tertiary">正在读取任务记录…</p>
  }

  if (tasks.length === 0 && changesets.length === 0) {
    return (
      <div aria-label="任务中心" className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={<CircleDot size={28} />}
          title="还没有后台任务"
          description="让 Agent 做一件事后，运行状态、当前步骤和结果会集中显示在这里。"
        />
      </div>
    )
  }

  return (
    <div aria-label="任务中心" className="min-h-0 flex-1 overflow-y-auto p-2.5">
      <header className="mb-2 flex items-center gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium text-fg-primary">后台任务</h2>
          <p className="text-2xs text-fg-tertiary">
            共 {tasks.length} 条 · {contextLabel} · 点任务回到对应对话，详情里有计划与时间线
          </p>
        </div>
        <IconButton label="刷新任务" size={28} onClick={() => void reload()}>
          <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
        </IconButton>
      </header>

      {/*
        AG-030：顶部**不再单列一排状态 chips**。
        它们和下面分组标题（「进行中 · 1」）是同一份计数，隔 10px 重复一遍 ——
        典型的「重复状态标签」。分组是有序的（进行中在最前），
        要一眼看「有没有在跑的」，看第一个分组就够了。
      */}
      <div className="flex flex-col gap-3">
        {activeGroups.map((group) => {
          const entries = groups.get(group.status) ?? []
          return (
            <section key={group.status} aria-label={group.label}>
              <div className="mb-1 flex items-center gap-1 px-0.5">
                <h3 className="text-2xs font-medium text-fg-tertiary">
                  {group.label} · {entries.length}
                </h3>
                <span className="flex-1" />
                {/* 在跑 / 等确认的分组没有「清空」—— 那两类得先停止 */}
                {LIVE_GROUPS.includes(group.status) || entries.length === 0 ? null : (
                  <button
                    type="button"
                    onClick={() => void clearGroup(group.status, group.label, entries.length)}
                    className="rounded-sm px-1 text-2xs text-fg-tertiary transition-colors duration-fast hover:text-[var(--error)]"
                  >
                    清空
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {entries.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    recovery={recoveryById.get(task.id)}
                    phases={task.sessionId === activeThreadId ? phases : []}
                    now={now}
                    active={task.sessionId === activeThreadId}
                    busy={busy === task.id}
                    onOpen={() => task.sessionId && setActiveThread(task.sessionId)}
                    onResume={() => void resume(task)}
                    onGiveUp={() => void giveUp(task)}
                    onDelete={() => void removeTask(task)}
                  />
                ))}
              </div>
            </section>
          )
        })}

        {changesets.length > 0 ? (
          <section aria-label="可撤销的改动">
            <h3 className="mb-1 px-0.5 text-2xs font-medium text-fg-tertiary">
              可撤销的改动 · {changesets.length}
            </h3>
            <div className="flex flex-col gap-1.5">
              {changesets.map((changeset) => (
                <div
                  key={changeset.id}
                  className="flex items-center gap-2 rounded-sm border border-line-hairline bg-bg-raised/40 px-2.5 py-1.5"
                >
                  <RotateCcw size={12} className="shrink-0 text-fg-tertiary" />
                  <span className="min-w-0 flex-1 truncate text-2xs text-fg-secondary">
                    {changeset.title || '一次改动'}：{changeset.fileCount} 个文件
                    {changeset.files[0] ? ` · ${changeset.files[0].split(/[\\/]/).pop()}` : ''}
                    {changeset.fileCount > 1 ? ' 等' : ''}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy === changeset.id}
                    onClick={() => void rollback(changeset)}
                  >
                    撤销
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
