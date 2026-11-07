import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第二阶段 · 13 页都能真的渲染出来（不是只有标题）

   ── 为什么这组和 `settingsRelocation.test.ts` 分开 ─────────────
   那一组读源码，管「某页该有的有、该没的没有」；这一组真渲染，
   管「点进去不会白屏 / 不会因为少个 mock 就崩」。

   两件事都得有：源码里写着 `defaultMode`，不代表渲染时 store 读得到它。

   ── 浏览器预览形态 ────────────────────────────────────────────
   mock 掉 backend 桥（`useRealBackend: false`），这正是浏览器预览的
   形态 —— 桌面版才有的块会自己显示「需要桌面版」，不会崩。
   ══════════════════════════════════════════════════════════════ */

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: false, bridge: undefined }
})

import { settingsPageOf } from '../settingsPages'
import { SETTINGS_NAV } from '../settingsNav'
import { SettingsPage } from '../SettingsPage'

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

/** 渲染某一页（带页框，和真实工作区同一层结构） */
async function draw(id: (typeof SETTINGS_NAV)[number]['id']): Promise<string> {
  const tab = SETTINGS_NAV.find((item) => item.id === id)!
  await act(async () => {
    root.render(<SettingsPage tab={tab}>{settingsPageOf(id)}</SettingsPage>)
  })
  return container.textContent ?? ''
}

describe('第二阶段 · 13 页真实渲染', () => {
  for (const tab of SETTINGS_NAV) {
    it(`★ 「${tab.label}」能渲染出内容，不白屏`, async () => {
      const text = await draw(tab.id)
      /* 页标题一定在 */
      expect(text).toContain(tab.label)
      /* 页 id 落到了 DOM 上（跳页/测试都靠它） */
      expect(container.querySelector(`[data-settings-page="${tab.id}"]`)).toBeTruthy()
      /*
       * 不能是「只有标题没有内容」：正文长度要明显超过标题 + 说明。
       * 用长度阈值而不是搜具体词 —— 具体词会随文案改动频繁失效，
       * 而「有没有实质内容」这个判据是稳定的。
       */
      const bodyText = text.replace(tab.label, '').replace(tab.blurb, '').trim()
      expect(bodyText.length, `「${tab.label}」正文太短，可能只有壳`).toBeGreaterThan(40)
    })
  }
})

describe('第二阶段 · 7 个重做页的关键控件真的能渲染', () => {
  it('★★ 个人资料：名字输入框 + 侧栏预览', async () => {
    const text = await draw('profile')
    expect(container.querySelector('[aria-label="你的名字"]')).toBeTruthy()
    expect(text).toContain('侧栏里长这样')
  })

  it('★★ 通用与快捷键：回车发送开关在，默认模式不在', async () => {
    const text = await draw('general')
    expect(text).toContain('回车发送')
    expect(text).toContain('快捷键')
    /* 迁移后这里不该再有默认模式 */
    expect(text).not.toContain('默认模式')
  })

  it('★★ 外观与通知：配色 + 字体预览 + 通知跳转', async () => {
    const text = await draw('appearance')
    expect(text).toContain('配色')
    expect(text).toContain('预览')
    expect(text).toContain('去右栏逐类设置')
  })

  it('★★ 对话与任务：默认模式搬到这里了', async () => {
    const text = await draw('conversation')
    expect(text).toContain('默认模式')
    expect(text).toContain('自动起标题')
  })

  it('★★ 记忆：写入策略 + 列表区都在', async () => {
    const text = await draw('memory')
    expect(text).toContain('写入策略')
    expect(text).toContain('每轮注入几条')
  })

  it('★★ 经验与规则：三种状态的说明在（不是只剩列表）', async () => {
    const text = await draw('experience')
    expect(text).toContain('它是怎么起作用的')
    expect(text).toContain('候选')
    expect(text).toContain('生效中')
  })

  it('★★ 关于 Harbor：版本号 + 许可清单', async () => {
    const text = await draw('about')
    expect(text).toContain('开源许可')
    expect(text).toContain('Electron')
  })

  it('★ 工具与扩展：网页链接搬到这类了', async () => {
    const text = await draw('extension')
    expect(text).toContain('网页里的链接')
  })
})
