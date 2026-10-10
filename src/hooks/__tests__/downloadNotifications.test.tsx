import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadEvent, DownloadItem } from '@/lib/downloadsApi'

/* ══════════════════════════════════════════════════════════════
   下载提示（渲染层，真跑 hook + 真 toast 组件）

   背景（2026-10-11 真机）：订阅原来长在 `DownloadsPanel` 里，而面板按标签
   条件渲染 —— 用户在内置浏览器里点下载时面板没挂载，事件没人接，点完毫无反应。
   现在订阅常驻在这里，一次管两件事：

     · 开始 / 完成 / 失败 → 弹一条提示（progress 不弹，会刷屏）
     · 事件同时喂给 store（面板没开数据也最新）

   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({ events: [] as Array<(event: DownloadEvent) => void> }))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: true }
})

vi.mock('@/lib/subscriptions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/subscriptions')>()
  return {
    ...actual,
    subscribeDownloadsEvent: (callback: (event: DownloadEvent) => void) => {
      h.events.push(callback)
      return () => {}
    },
  }
})

import { useDownloadNotifications } from '@/hooks/useDownloadNotifications'
import { useDownloadsStore } from '@/stores/useDownloadsStore'
import { useUIStore } from '@/stores/useUIStore'
import { ToastViewport } from '@/components/ui/Toast'

let container: HTMLDivElement
let root: Root

function Probe() {
  useDownloadNotifications()
  return null
}

/** 挂上 hook 和真的 toast 视口 —— 点「查看」要走真组件才算端到端 */
function draw(): void {
  act(() =>
    root.render(
      <>
        <Probe />
        <ToastViewport />
      </>,
    ),
  )
}

function item(patch: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'dl_1',
    url: 'https://example.com/a.bin',
    file: 'E:\\dl\\a.bin',
    name: 'a.bin',
    total: 100,
    received: 0,
    status: 'queued',
    origin: 'browser',
    error: '',
    createdAt: 0,
    updatedAt: 0,
    finishedAt: 0,
    connections: 0,
    attempts: 0,
    speedBps: 0,
    ...patch,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  h.events = []
  useDownloadsStore.setState({ items: [], running: [], error: '', loaded: false })
  useUIStore.setState({ toasts: [], activeRightTab: 'diff' })
  draw()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('下载提示 / 全局订阅', () => {
  it('★ 开始下载 → 弹「开始下载」并带上文件名', () => {
    act(() => h.events[0]({ type: 'started', id: 'dl_1', name: 'a.bin' }))
    const toasts = useUIStore.getState().toasts
    expect(toasts.length).toBe(1)
    expect(toasts[0].kind).toBe('info')
    expect(toasts[0].title).toBe('开始下载')
    expect(toasts[0].description).toBe('a.bin')
  })

  it('★ 下载完成 → 弹「下载完成」', () => {
    act(() => h.events[0]({ type: 'done', id: 'dl_1', name: 'a.bin', bytes: 100 }))
    const toasts = useUIStore.getState().toasts
    expect(toasts.length).toBe(1)
    expect(toasts[0].kind).toBe('success')
    expect(toasts[0].title).toBe('下载完成')
  })

  it('★ 下载失败 → 弹 error，文案是失败原因（不是文件名）', () => {
    act(() =>
      h.events[0]({ type: 'failed', id: 'dl_1', name: 'a.bin', error: 'HTTP 404 Not Found' }),
    )
    const toasts = useUIStore.getState().toasts
    expect(toasts.length).toBe(1)
    expect(toasts[0].kind).toBe('error')
    expect(toasts[0].title).toBe('下载失败')
    expect(toasts[0].description).toBe('HTTP 404 Not Found')
  })

  it('进度事件不弹（每 200ms 一条，弹它等于刷屏）', () => {
    act(() => h.events[0]({ type: 'progress', id: 'dl_1', received: 50, total: 100 }))
    expect(useUIStore.getState().toasts.length).toBe(0)
  })

  it('★ 事件同时喂给 store —— 面板没开，数据也保持最新', () => {
    useDownloadsStore.setState({ items: [item({ status: 'running' })] })
    act(() => h.events[0]({ type: 'progress', id: 'dl_1', received: 42, total: 100 }))
    const got = useDownloadsStore.getState().items[0]
    expect(got.received).toBe(42)
    expect(got.status).toBe('running')
  })

  it('★ 点提示上的「查看」→ 右栏落到「下载」标签', () => {
    act(() => h.events[0]({ type: 'done', id: 'dl_1', name: 'a.bin' }))
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '查看',
    )
    expect(button).toBeTruthy()
    act(() => button?.click())
    expect(useUIStore.getState().activeRightTab).toBe('downloads')
    /* 点完这条提示就收掉 */
    expect(useUIStore.getState().toasts.length).toBe(0)
  })
})
