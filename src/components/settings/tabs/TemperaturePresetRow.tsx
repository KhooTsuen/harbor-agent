import { useEffect, useState } from 'react'
import { fetchTaskPresets, type TaskPreset } from '@/lib/taskPresetsApi'
import { Row } from '../parts'

/* ══════════════════════════════════════════════════════════════
   温度：按任务类型挑一个预设

   ★ 为什么这一行只有温度，没有轮数
     「这条对话是什么风格」（温度）和「这次活最多跑多少」（预算）是两件事：
       · 温度跟着对话走 —— 选了就一直管用
       · 预算跟着**任务**走 —— 每发一句话就是一个新目标，内核按那句话判断类型，
         任务卡片上还能改（AG-040）
     把它俩塞进同一个下拉，用户会以为选了「写代码」就把轮数也钉死了。

   ★ 显示**理由**，不是只显示数字
     「0.2」本身没有说服力；「代码要确定性 —— 同一个需求两次跑出两套写法是负担」
     才让人愿意用它。

   ★ 数字全部来自内核（`core/task-presets.cjs`），这里不写第二份。
   ══════════════════════════════════════════════════════════════ */

export function TemperaturePresetRow({
  temperature,
  globalTemperature,
  onPick,
}: {
  /** 这条对话自己的温度；空 = 没设过，用全局的 */
  temperature?: number
  /** 全局默认温度（设置 → 模型），用来告诉用户「自动」用的是多少 */
  globalTemperature: number
  onPick: (value: number | undefined) => void
}) {
  const [presets, setPresets] = useState<TaskPreset[]>([])

  useEffect(() => {
    let alive = true
    void fetchTaskPresets().then((list) => {
      if (alive) setPresets(list)
    })
    return () => {
      alive = false
    }
  }, [])

  const known = presets.some((item) => item.temperature === temperature)
  /* 选了，但那个值现在对不上任何一种预设（内核调过数值 / 老数据）—— 如实说一句 */
  const custom = typeof temperature === 'number' && presets.length > 0 && !known
  const current = presets.find((item) => item.temperature === temperature)

  return (
    <Row
      label="温度"
      hint={
        current
          ? `${current.label} —— ${current.why}`
          : '风格：写作/创作要发散，代码/查资料要收敛。只影响这条对话。'
      }
    >
      <div className="flex flex-col gap-1">
        <select
          value={typeof temperature === 'number' ? String(temperature) : ''}
          onChange={(e) => onPick(e.target.value === '' ? undefined : Number(e.target.value))}
          className="rounded-sm border border-line-subtle bg-bg-raised px-2 py-1 text-xs text-fg-primary"
        >
          <option value="">自动（用全局的 {globalTemperature}）</option>
          {presets.map((item) => (
            <option key={item.type} value={String(item.temperature)}>
              {item.label} —— {item.temperature}
            </option>
          ))}
        </select>

        {custom ? (
          <p className="text-dense leading-relaxed text-fg-tertiary">
            这条对话现在是 {temperature}，不是上面任何一档（可能是之前设的、或预设调过数值）。
          </p>
        ) : null}

        <p className="text-dense leading-relaxed text-fg-tertiary">
          轮数上限 / 工具调用次数不在这里 —— 它们按每个任务的目标自动给（任务卡片上能改）。
        </p>
      </div>
    </Row>
  )
}
