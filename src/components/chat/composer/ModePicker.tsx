import { useState } from 'react'
import { ChevronDown, Hand } from 'lucide-react'
import type { ThreadMode } from '@/types'
import { MODES } from '@/constants'
import { MenuItem, MenuLabel, Popover } from '@/components/ui/Popover'

/* ══════════════════════════════════════════════════════════════
   协作模式选择器

   Plan / Goal 有官方文档支撑（/plan 与 /goal）；Pair / Execute 是需求
   文档里的划分。切换改当前线程的 mode，进而影响 system prompt。
   ══════════════════════════════════════════════════════════════ */

/* ── 模式选择 ───────────────────────────────────────────────── */

export function ModePicker({
  mode,
  onChange,
}: {
  mode: ThreadMode
  onChange: (m: ThreadMode) => void
}) {
  const [open, setOpen] = useState(false)
  const current = MODES.find((m) => m.id === mode) ?? MODES[1]

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-fg-secondary transition-colors hover:bg-bg-hover hover:text-fg-primary"
        >
          <Hand size={13} className="shrink-0" />
          {current.label}
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      )}
    >
      <MenuLabel>协作模式</MenuLabel>
      {MODES.map((m) => (
        <MenuItem
          key={m.id}
          selected={m.id === mode}
          onSelect={() => {
            onChange(m.id)
            setOpen(false)
          }}
          hint={m.reasoning === 'high' ? '高推理' : '中推理'}
        >
          <span className="flex flex-col">
            <span>{m.label}</span>
            <span className="text-2xs text-fg-tertiary">{m.hint}</span>
          </span>
        </MenuItem>
      ))}
    </Popover>
  )
}
