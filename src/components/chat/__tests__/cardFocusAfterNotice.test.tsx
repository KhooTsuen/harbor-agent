import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AboveInputCards } from '../AboveInputCards'
import { useUIStore } from '@/stores/useUIStore'
import type { PermissionRequest } from '@/types'

/* ══════════════════════════════════════════════════════════════
   P1-3：点了「需要你确认」的系统通知之后，视线要落到卡片上

   主进程发通知时窗口不在前台（用户在别的窗口干活）。他点通知 → 主进程叫回窗口
   + 渲染层切回那条对话 → 这里负责最后一步：**把卡片亮出来**
   （聚焦第一个可点项 + 滚进视野）。

   两条都要钉：
     · 被请求时 → 焦点真的落在卡上的按钮（不是留在输入框里）
     · 没被请求时 → **一点都不许碰焦点**（正常打开对话时抢焦点是很烦人的事）
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

const CARD: PermissionRequest = {
  kind: 'clarify',
  confirmId: 'clr_1',
  title: '动手前先对齐一下',
  description: '',
  confirmText: '就这么干',
  danger: false,
  clarify: [
    {
      question: '白板用哪种坐标系？',
      options: [
        { label: '屏幕像素', effect: '改窗口尺寸要重算' },
        { label: '文档坐标', effect: '缩放平移不用改数据' },
      ],
      allowFreeform: false,
      defaultValue: '屏幕像素',
      defaultFrom: 'model',
    },
  ],
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  /*
   * jsdom 不实现 scrollIntoView（真浏览器里才有）——
   * 不 stub 的话 effect 里那一下会抛错，而那是环境缺的，不是代码错的。
   */
  Element.prototype.scrollIntoView = () => {}
  /* 先摆一个「用户之前在输入框里」的状态，才看得出焦点有没有被搬走 */
  const input = document.createElement('input')
  document.body.appendChild(input)
  input.focus()
  useUIStore.setState({ permission: null, clarify: CARD, cardFocusNonce: 0 })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.querySelectorAll('input').forEach((el) => el.remove())
})

function draw(): void {
  act(() => root.render(<AboveInputCards />))
}

describe('点通知之后把卡片亮出来', () => {
  it('★ 被请求 → 焦点落进卡片（不再是留在输入框里）', () => {
    draw()
    act(() => useUIStore.getState().requestCardFocus())
    const focused = document.activeElement as HTMLElement | null
    const card = container.querySelector('section[aria-label]')
    expect(focused?.tagName).toBe('BUTTON')
    expect(card?.contains(focused)).toBe(true)
    /*
     * 断「在卡片里」而不是断某个具体按钮：分步之后卡上第一个可点项是
     * **问题标题**（点它能展开/收起那一问），选项按钮排在它后面 ——
     * 钉死「第一个是屏幕像素」会在下次调布局时白红一次。
     */
    expect(focused?.textContent ?? '').toContain('白板用哪种坐标系？')
  })

  it('★ 没被请求 → 一点都不碰焦点（别在正常打开时抢）', () => {
    draw()
    const input = document.querySelector('input')
    input?.focus()
    expect(document.activeElement).toBe(input)
  })

  it('卡片已经被收起来时点通知：什么都不做，也不抛错', () => {
    useUIStore.setState({ clarify: null })
    draw()
    expect(() => act(() => useUIStore.getState().requestCardFocus())).not.toThrow()
  })
})
