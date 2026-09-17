import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from '@/constants'

describe('快捷键默认值', () => {
  it('id 和默认组合键都不重复', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id)
    const keys = SHORTCUTS.map((shortcut) => shortcut.defaultKeys)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('底部面板和右侧面板使用不同组合键', () => {
    const bottom = SHORTCUTS.find((shortcut) => shortcut.id === 'toggle-bottom')
    const right = SHORTCUTS.find((shortcut) => shortcut.id === 'toggle-right')
    expect(bottom?.defaultKeys).toBe('mod+j')
    expect(right?.defaultKeys).toBe('mod+shift+j')
  })
})
