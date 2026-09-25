import { useEffect, useState } from 'react'
import { subscribeTaskEnd } from '@/lib/subscriptions'
import { colorOf } from '@/lib/statusLanguage'
import { useEggStore } from '@/stores/useEggStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/* ══════════════════════════════════════════════════════════════
   状态彩蛋：「航道畅通」（设计文档 §13.5 / §23.9）

   它**不是**语言彩蛋 —— 本质是「带 Harbor 语气的真实状态反馈」，
   所以触发条件必须是客观的：
     · 这一轮真的跑过测试命令（内核 task-outcome 认的才算）；
     · 最后一条测试命令的真实退出码是 0（exitOk === true）；
     · 这一轮整体是成功结束的（kind === 'success'，测试过了又翻车的
       轮次不庆祝）；
     · 每个任务只庆祝一次（内存里去重；次数记进设置）。
   模型说了什么，一概不算。

   展示：底部一条绿色细线 + 「航道畅通」小标；同时信号灯扫一次
   （通过 useEggStore 的 sweepSeq —— 开屏在的话灯塔会亮一遍）。
   ══════════════════════════════════════════════════════════════ */

/** 进程内去重：哪个任务已经庆祝过（重启后允许再来一次，无害） */
let celebratedTaskId = ''

const VISIBLE_MS = 2600

export function HarborEggs() {
  const greenAt = useEggStore((s) => s.greenAt)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    return subscribeTaskEnd((payload) => {
      const outcome = payload.outcome
      if (!outcome || outcome.tests !== 'passed' || payload.kind !== 'success') return
      const id = outcome.taskId || `at-${payload.title}`
      if (id === celebratedTaskId) return
      celebratedTaskId = id
      useEggStore.getState().celebrateGreen()
      const settings = useSettingsStore.getState()
      settings.updateSettings({ greenRuns: settings.settings.greenRuns + 1 })
    })
  }, [])

  useEffect(() => {
    if (greenAt === 0) return
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [greenAt])

  if (!visible) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex flex-col items-center"
      role="status"
      aria-label="航道畅通"
    >
      <span className="mb-1.5 rounded-pill border border-line-hairline bg-bg-surface px-3 py-1 text-2xs text-fg-primary shadow-high">
        航道畅通 · 测试全绿
      </span>
      <div className="h-0.5 w-full animate-pulse" style={{ background: colorOf('completed') }} />
    </div>
  )
}
