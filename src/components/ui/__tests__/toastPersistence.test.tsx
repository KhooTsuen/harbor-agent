import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/useUIStore'
import { ToastViewport } from '../Toast'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  useUIStore.setState({ toasts: [], toastHistory: [] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<ToastViewport />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('重要通知与暂停计时', () => {
  it('需处理的错误不随时间消失，手动关闭后仍在记录里', () => {
    act(() => {
      useUIStore.getState().showToast('error', '模型连接失败', '请检查连接')
    })
    act(() => vi.advanceTimersByTime(15_000))
    expect(useUIStore.getState().toasts).toHaveLength(1)
    expect(host.textContent).toContain('重要通知记录')
    act(() => {
      useUIStore.getState().hideToast(useUIStore.getState().toasts[0].id)
    })
    expect(useUIStore.getState().toasts).toHaveLength(0)
    expect(useUIStore.getState().toastHistory).toHaveLength(1)
  })

  it('鼠标停在普通提示上时暂停倒计时', () => {
    act(() => {
      useUIStore.getState().showToast('info', '已复制')
    })
    const card = host.querySelector('[role="status"]')
    expect(card).not.toBeNull()
    act(() => card?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(5000))
    expect(useUIStore.getState().toasts).toHaveLength(1)
    act(() => card?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    act(() => vi.advanceTimersByTime(4300))
    expect(useUIStore.getState().toasts).toHaveLength(0)
  })
})
