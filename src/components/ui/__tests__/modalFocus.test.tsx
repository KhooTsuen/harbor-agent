import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Modal } from '../Modal'

/* ══════════════════════════════════════════════════════════════
   P2 #19：弹窗键盘操作

   钉四件事：
     · 打开时焦点进弹窗
     · Tab 在弹窗内循环，不落到背景
     · Escape 只关栈顶那一层（嵌套弹窗）
     · 危险确认的初始焦点落在标了 data-initial-focus 的按钮上（= 取消）
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('P2 #19 弹窗键盘操作', () => {
  it('打开后焦点进入弹窗内部', async () => {
    await act(async () => {
      root.render(
        <Modal open onClose={() => {}} title="测试弹窗">
          <button type="button">里面第一个</button>
        </Modal>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    const inner = document.querySelector('[role="dialog"] button')
    expect(document.activeElement).toBe(inner)
  })

  it('标了 data-initial-focus 的按钮优先拿到焦点（危险确认 = 取消）', async () => {
    await act(async () => {
      root.render(
        <Modal
          open
          onClose={() => {}}
          title="删除这条对话？"
          footer={
            <>
              <button type="button" data-initial-focus="">
                取消
              </button>
              <button type="button">删除</button>
            </>
          }
        >
          <button type="button">查看 Diff</button>
        </Modal>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    expect(document.activeElement?.textContent).toBe('取消')
  })

  it('Tab 到最后一个可聚焦元素时回到第一个（不跑出弹窗）', async () => {
    await act(async () => {
      root.render(
        <Modal
          open
          onClose={() => {}}
          title="测试"
          footer={
            <>
              <button type="button" id="m-cancel">
                取消
              </button>
              <button type="button" id="m-ok">
                确定
              </button>
            </>
          }
        >
          <p>正文</p>
        </Modal>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    const ok = document.getElementById('m-ok') as HTMLButtonElement
    ok.focus()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    /* 从最后一个往前绕 → 回到弹窗内第一个可聚焦项 */
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(ok)
  })

  it('Escape 只让最上面那层响应（嵌套时不会一次关两层）', async () => {
    const closed: string[] = []
    await act(async () => {
      root.render(
        <>
          <Modal open onClose={() => closed.push('outer')} title="外层">
            <p>外层正文</p>
          </Modal>
          <Modal open onClose={() => closed.push('inner')} title="内层">
            <p>内层正文</p>
          </Modal>
        </>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closed).toEqual(['inner'])
  })

  it('关闭后焦点还给原元素', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开'
    document.body.append(trigger)
    trigger.focus()

    await act(async () => {
      root.render(
        <Modal open onClose={() => {}} title="测试">
          <button type="button">里面</button>
        </Modal>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    expect(document.activeElement).not.toBe(trigger)

    await act(async () => {
      root.render(
        <Modal open={false} onClose={() => {}} title="测试">
          <button type="button">里面</button>
        </Modal>,
      )
    })
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
