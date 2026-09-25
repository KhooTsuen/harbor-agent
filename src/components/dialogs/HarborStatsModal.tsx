import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { useUIStore } from '@/stores/useUIStore'
import { taskList } from '@/lib/safetyApi'
import { aggregateHarborStats } from '@/lib/harborStats'
import type { TaskRecord } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   /harbor —— 隐藏命令打开的本地统计（设计文档 §13.4）

   「所有数据来自本地任务账本，无法计算的项目不显示」。
   不读额外的工作区文件、不发网络请求 —— 只把 task:list 拿到的
   台账聚合一遍（aggregateHarborStats，纯函数，有单测）。
   ══════════════════════════════════════════════════════════════ */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line-hairline py-1.5 last:border-none">
      <span className="text-dense text-fg-secondary">{label}</span>
      <span className="font-mono text-dense text-fg-primary">{value}</span>
    </div>
  )
}

export function HarborStatsModal() {
  const open = useUIStore((s) => s.harborStatsOpen)
  const close = useUIStore((s) => s.closeHarborStats)
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setTasks(null)
    void taskList({ limit: 200 }).then((list) => {
      if (!cancelled) setTasks(list ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const stats = tasks ? aggregateHarborStats(tasks) : null

  return (
    <Modal
      open={open}
      onClose={close}
      title="Harbor 状态"
      description="全部来自这台机器上的任务台账；不联网、不上传"
      width="sm"
    >
      {stats === null ? (
        <p className="py-3 text-dense text-fg-tertiary">正在读台账…</p>
      ) : (
        <div className="flex flex-col">
          {stats.completed > 0 ? <Row label="完成任务" value={String(stats.completed)} /> : null}
          {stats.cancelled > 0 ? <Row label="中止任务" value={String(stats.cancelled)} /> : null}
          {stats.resumed > 0 ? <Row label="恢复过" value={`${stats.resumed} 次`} /> : null}
          {stats.testRuns > 0 ? <Row label="运行测试" value={String(stats.testRuns)} /> : null}
          {stats.topTool ? <Row label="最常用工具" value={stats.topTool} /> : null}
          {stats.completed === 0 &&
          stats.cancelled === 0 &&
          stats.resumed === 0 &&
          stats.testRuns === 0 &&
          !stats.topTool ? (
            <p className="py-3 text-dense text-fg-tertiary">
              台账还是空的 —— 跑几个任务之后这里会有数字。
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  )
}
