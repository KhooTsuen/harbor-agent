import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   设置 → 个人资料（侧栏左下角那个圆的接口）

   原来那个圆是写死的装饰（一个「我」字、点了没反应）。这里测界面这一半：
   名字能改、没有头像时显示首字、有头像时显示图、能移除。
   内核那一半在 `scripts/selftest/groups/48-profile.mjs`。
   ══════════════════════════════════════════════════════════════ */

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: false, bridge: undefined }
})

import { ProfileTab } from '../tabs/ProfileTab'
import { initialOf, useProfileStore } from '@/stores/useProfileStore'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useProfileStore.setState({ name: '', avatar: '', loaded: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function draw(): void {
  act(() => {
    root.render(<ProfileTab />)
  })
}

const nameInput = () => document.querySelector('[aria-label="你的名字"]') as HTMLInputElement | null

describe('个人资料', () => {
  it('★ 没有名字也没有头像时，那个圆里是「我」', () => {
    draw()
    expect(container.textContent).toContain('我')
    expect(nameInput()).toBeTruthy()
  })

  it('★ 有名字没头像时，显示名字首字（中文取第一个字）', () => {
    act(() => useProfileStore.setState({ name: 'dev-user' }))
    draw()
    expect(container.textContent).toContain('B')
    act(() => useProfileStore.setState({ name: '张三' }))
    draw()
    expect(container.textContent).toContain('张')
  })

  it('★ 有头像时显示的是图片', () => {
    act(() => useProfileStore.setState({ avatar: 'data:image/png;base64,AAA' }))
    draw()
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toContain('data:image/png')
  })

  it('★ 改名字会写进 store（侧栏那个圆跟着变）', () => {
    draw()
    const input = nameInput()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '小助手')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useProfileStore.getState().name).toBe('小助手')
  })

  it('有头像时才给「移除」按钮', () => {
    draw()
    expect(container.textContent).not.toContain('移除')
    act(() => useProfileStore.setState({ avatar: 'data:image/png;base64,AAA' }))
    draw()
    expect(container.textContent).toContain('移除')
  })

  it('首字的取法：空 → 「我」，英文取大写，超长名字只看第一个字', () => {
    expect(initialOf('')).toBe('我')
    expect(initialOf('   ')).toBe('我')
    expect(initialOf('binlin')).toBe('B')
    expect(initialOf('张三丰')).toBe('张')
  })
})
