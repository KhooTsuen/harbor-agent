import { useState } from 'react'
import type { TaskRecord } from '@/types/safety'
import { taskUpdate } from '@/lib/safetyApi'
import { useTaskStore } from '@/stores/useTaskStore'
import { useUIStore } from '@/stores/useUIStore'
import { Button } from '@/components/ui/Button'

/* ══════════════════════════════════════════════════════════════
   调整预算（AG-040）

   文档：达到预算后给 **[继续] [停止] [调整预算]** —— 这是第三个按钮落地的地方。

   五项（轮数 / 工具调用 / 运行时长 / 重试 / 本任务 token）：
     · 留空 = 用设置里的默认（占位符里就写着默认值，不用猜）
     · 0 = 不限
     · 运行时长在界面上按**分钟**填，存的是秒（内核按秒算）

   存进的是**这个任务自己的覆盖**（`task.budget`），不动全局设置 ——
   「这次活多给它两轮」不该顺手改掉以后所有任务的默认。
   ══════════════════════════════════════════════════════════════ */

interface Field {
  key: 'maxSteps' | 'maxToolCalls' | 'maxRuntime' | 'maxRetries' | 'maxTokens'
  label: string
  unit: string
  /** 界面上要不要换算（运行时长按分钟填、按秒存） */
  minutes?: boolean
}

const FIELDS: Field[] = [
  { key: 'maxSteps', label: '轮数', unit: '轮' },
  { key: 'maxToolCalls', label: '工具调用', unit: '次' },
  { key: 'maxRuntime', label: '运行时长', unit: '分钟', minutes: true },
  /* 名字保持短：它是 aria-label（自动化测试与读屏都按这个认），
     「0 = 不重试」那句例外写在下面的说明里 */
  { key: 'maxRetries', label: '自动重试', unit: '次' },
  { key: 'maxTokens', label: '本任务 token', unit: '' },
]

export function BudgetEditor({ task, onDone }: { task: TaskRecord; onDone: () => void }) {
  const refresh = useTaskStore((s) => s.refresh)
  const showToast = useUIStore((s) => s.showToast)
  const [busy, setBusy] = useState(false)

  /* 预填：任务自己的覆盖优先，没有就显示主进程算好的实际值（占位符） */
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const field of FIELDS) {
      const own = task.budget?.[field.key]
      out[field.key] = own === undefined ? '' : String(field.minutes ? Math.round(own / 60) : own)
    }
    return out
  })

  async function save(): Promise<void> {
    const budget: Record<string, number> = {}
    for (const field of FIELDS) {
      const raw = draft[field.key]?.trim() ?? ''
      if (raw === '') continue /* 留空 = 用默认 */
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) {
        showToast('warning', `${field.label}要填 0 或正整数（0 = 不限）`)
        return
      }
      budget[field.key] = field.minutes ? Math.floor(value * 60) : Math.floor(value)
    }

    setBusy(true)
    try {
      await taskUpdate(task.id, { budget })
      await refresh()
      showToast('success', '预算已更新', '下一次「继续」按新预算跑')
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 rounded-sm border border-line-hairline bg-bg-base/40 p-2">
      <p className="mb-1.5 text-2xs text-fg-tertiary">
        留空 = 用默认（占位符里的就是，而默认全是不限）；
        <span className="text-fg-secondary">0 = 不限</span>
        ，只有「自动重试」例外 —— 它是「同一个只读工具失败后自动再试几次」， 那一项 0 = 不重试。
      </p>
      <div className="flex flex-wrap gap-2">
        {FIELDS.map((field) => (
          <label key={field.key} className="flex items-center gap-1 text-2xs text-fg-secondary">
            {field.label}
            <input
              type="number"
              min={0}
              value={draft[field.key] ?? ''}
              placeholder={String(
                field.minutes
                  ? Math.round((task.budgetResolved?.[field.key] ?? 0) / 60)
                  : (task.budgetResolved?.[field.key] ?? 0),
              )}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))
              }
              aria-label={field.label}
              className="w-20 rounded-sm border border-line-hairline bg-bg-base px-1.5 py-0.5 text-right font-mono text-2xs text-fg-primary"
            />
            <span className="text-fg-tertiary">{field.unit}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="secondary" size="sm" loading={busy} onClick={() => void save()}>
          保存
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
        <span className="text-2xs text-fg-tertiary">改完按「继续」它就接着做</span>
      </div>
    </div>
  )
}
