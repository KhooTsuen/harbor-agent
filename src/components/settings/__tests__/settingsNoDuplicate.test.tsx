import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   设置页不许「同一项出现两次」

   ── 为什么要这一组（2026-11-08 用户真机确认）───────────────────
   「通用与快捷键」页的快捷键列表**真的出现了两次**，不是截图拼接。
   原因：`settingsPageOf('general')` 渲染 `GeneralPanel`，而它同时挂了
   `GeneralTab`（内部已有一份 `ShortcutsTab`）和 `ShortcutsTab`（第二份）。

   ── 判据为什么数 DOM 而不是读源码 ──────────────────────────────
   读源码只能看出「有几个 import」，看不出「最终渲染了几行」——
   包装组件转发、条件分支、同一组件在多处被 import，这几种情况下
   源码看起来都正常。所以第一段真渲染、真数行数。

   ── 顺带守住「整组重复」──────────────────────────────────────
   同样的病可能长在别的页上。用「分组标题不许同名出现两次」当探针：
   `settings-section-heading` 是唯一的节标题产出处（parts.tsx），
   某一节整块被渲染两遍，它的标题必然出现两次。
   ══════════════════════════════════════════════════════════════ */

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: false, bridge: undefined }
})

import { settingsPageOf } from '../settingsPages'
import { SETTINGS_GROUPS, SETTINGS_NAV } from '../settingsNav'
import { SettingsPage } from '../SettingsPage'
import { SHORTCUTS } from '@/constants'

const ROOT = process.cwd()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function draw(id: (typeof SETTINGS_NAV)[number]['id']): Promise<string> {
  const tab = SETTINGS_NAV.find((item) => item.id === id)!
  await act(async () => {
    root.render(<SettingsPage tab={tab}>{settingsPageOf(id)}</SettingsPage>)
  })
  return container.textContent ?? ''
}

/** 快捷键行：ShortcutsTab 里每个键位是一个 `li.acrylic-card`（Row 是 div，不会混进来） */
const shortcutRows = () => container.querySelectorAll('li.acrylic-card').length

describe('设置页 · 快捷键只显示一次', () => {
  it('★★★ 快捷键行数 = SHORTCUTS 的条数（重复挂载时是两倍）', async () => {
    await draw('general')
    expect(shortcutRows()).toBe(SHORTCUTS.length)
  })

  it('★ 每一条快捷键都还在（不是靠删掉一条来凑数）', async () => {
    const text = await draw('general')
    for (const one of SHORTCUTS) expect(text, `缺「${one.label}」`).toContain(one.label)
  })

  it('★ 每条快捷键在页面上只出现一次', async () => {
    await draw('general')
    const heads = [...container.querySelectorAll('li.acrylic-card')].map(
      (li) => li.textContent ?? '',
    )
    for (const one of SHORTCUTS) {
      const hits = heads.filter((line) => line.includes(one.label))
      expect(hits.length, `「${one.label}」出现 ${hits.length} 次`).toBe(1)
    }
  })

  it('★★★ 源码里只有一处挂载 <ShortcutsTab>（否则换个包装层又会重复）', () => {
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full)
          continue
        }
        if (!name.endsWith('.tsx')) continue
        const src = readFileSync(full, 'utf8')
        if (/<ShortcutsTab\s*\/>/.test(src)) hits.push(full.replace(ROOT, ''))
      }
    }
    walk(join(ROOT, 'src'))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('GeneralTab.tsx')
  })
})

describe('设置页 · 整组设置不许重复', () => {
  for (const tab of SETTINGS_NAV) {
    it(`★ 「${tab.label}」里没有同名分组出现两次`, async () => {
      await draw(tab.id)
      const names = [...container.querySelectorAll('.settings-section-heading')].map((el) =>
        (el.textContent ?? '').trim(),
      )
      const seen = new Set<string>()
      const dup = names.filter((name) => {
        if (!name) return false
        if (seen.has(name)) return true
        seen.add(name)
        return false
      })
      expect(dup, `重复的分组：${dup.join('、')}`).toEqual([])
    })
  }

  it('★ 反复切换页面不会累积（切走再回来，行数还是那么多）', async () => {
    await draw('general')
    const first = shortcutRows()
    await draw('about')
    await draw('general')
    expect(shortcutRows()).toBe(first)
  })
})

describe('设置页 · 导航数量与分组', () => {
  it('★★ 13 页都在导航里', () => {
    expect(SETTINGS_NAV).toHaveLength(13)
  })

  it('★★ 5 个分组', () => {
    expect(SETTINGS_GROUPS).toHaveLength(5)
  })

  it('★ 页 id 不重复', () => {
    expect(new Set(SETTINGS_NAV.map((one) => one.id)).size).toBe(SETTINGS_NAV.length)
  })
})
