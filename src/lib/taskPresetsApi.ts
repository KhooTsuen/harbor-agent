/* ══════════════════════════════════════════════════════════════
   任务类型预设（②-2）的桥包装

   类型表**由内核给**（`core/task-presets.cjs` 的 `list()`），前端不自己抄一份 ——
   抄一份的下场是两边数值漂开，而漂开之后没人知道该信哪个。

   这一层只干两件事：拿列表、把选中类型的**温度**写回这条对话的设置。
   预算（轮数 / 工具上限 / 输出上限 / token）**不在这里设，内核也不再按任务类型预填**
   （2026-09-29：预设以前会给每个任务塞「轮数 60、工具 120」，用户看到撞上限却
   不记得自己设过。现在那五项默认全是不限，只在任务卡片「调整预算」里由用户自己填）。

   拿不到桥 / 内核报错：返回空数组或 `false`，**不抛异常**。
   ══════════════════════════════════════════════════════════════ */

export type TaskPreset = {
  type: string
  label: string
  temperature: number
  why: string
}

type TaskPresetsBridge = {
  taskPresets?: () => Promise<{ ok?: boolean; presets?: unknown }>
}

const bridge =
  typeof window !== 'undefined'
    ? (window.workbench as unknown as TaskPresetsBridge | undefined)
    : undefined

/** 桥接好了吗（没接上时那一行显示一句人话，不崩、不白屏） */
export function taskPresetsBridgeReady(): boolean {
  return typeof bridge?.taskPresets === 'function'
}

function toPreset(raw: unknown): TaskPreset | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const type = String(item.type ?? '')
  if (!type) return null
  return {
    type,
    label: String(item.label ?? type),
    /* 数值来自内核，这里只做「认不出来就别用」的收窄 —— 不替它算 */
    temperature: Number(item.temperature),
    why: String(item.why ?? ''),
  }
}

export async function fetchTaskPresets(): Promise<TaskPreset[]> {
  if (typeof bridge?.taskPresets !== 'function') return []
  try {
    const raw = await bridge.taskPresets()
    const list = Array.isArray(raw?.presets) ? raw.presets : []
    return list.map(toPreset).filter((item): item is TaskPreset => item !== null)
  } catch {
    return []
  }
}
