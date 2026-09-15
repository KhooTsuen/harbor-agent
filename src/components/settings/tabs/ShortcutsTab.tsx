import { useEffect, useState } from 'react'
import { SHORTCUTS } from '@/constants'
import { cn, eventToCombo, formatKeys } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { SectionTitle } from '../parts'

/* ══════════════════════════════════════════════════════════════
   快捷键

   原来这段 JSX 直接写在 SettingsModal 里。抽出来是为了能并进
   「通用」标签 —— 快捷键单独占一格太奢侈了，它不是天天改的东西。

   录制逻辑（按 Esc 取消、冲突拒绝）跟着一起搬过来了。
   ══════════════════════════════════════════════════════════════ */

export function ShortcutsTab() {
  const showToast = useUIStore((s) => s.showToast)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [recording, setRecording] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(null)
        return
      }
      const combo = eventToCombo(event)
      if (!combo) return

      const conflict = Object.entries(settings.shortcutKeys).find(
        ([id, value]) => id !== recording && value === combo,
      )
      if (conflict) {
        showToast(
          'warning',
          '快捷键冲突',
          `已经绑定给「${SHORTCUTS.find((s) => s.id === conflict[0])?.label ?? conflict[0]}」`,
        )
        return
      }
      updateSettings({ shortcutKeys: { ...settings.shortcutKeys, [recording]: combo } })
      setRecording(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, settings.shortcutKeys, showToast, updateSettings])

  const shortcutFor = (id: string, fallback: string): string =>
    settings.shortcutKeys[id] ?? fallback

  return (
    <>
      <SectionTitle>快捷键</SectionTitle>
      <p className="py-2 text-xs leading-relaxed text-fg-secondary">
        点击任意键位即可录制新的组合键；按 Esc 取消。冲突键位会被拒绝。
      </p>
      {Array.from(new Set(SHORTCUTS.map((s) => s.group))).map((group) => (
        <div key={group} className="py-2">
          <p className="mb-1.5 text-2xs text-fg-tertiary">{group}</p>
          <ul className="flex flex-col gap-0.5">
            {SHORTCUTS.filter((s) => s.group === group).map((shortcut) => (
              <li
                key={shortcut.id}
                className="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm text-fg-secondary hover:bg-bg-hover"
              >
                <span>{shortcut.label}</span>
                <button
                  type="button"
                  onClick={() => setRecording(shortcut.id)}
                  className={cn(
                    'rounded-sm border px-2 py-0.5 font-mono text-2xs transition-colors',
                    recording === shortcut.id
                      ? 'border-line-focus bg-bg-hover text-fg-primary'
                      : 'border-line-subtle bg-bg-raised text-fg-primary hover:border-line-focus',
                  )}
                >
                  {recording === shortcut.id
                    ? '请按键…'
                    : formatKeys(
                        shortcutFor(shortcut.id, shortcut.defaultKeys),
                        navigator.platform.toLowerCase().includes('mac'),
                      )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}
