import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskEndPayload } from '@/types/notify'

/* ══════════════════════════════════════════════════════════════
   AG-029 后台任务通知（渲染层，真跑 hook + 真 toast 组件）

   分工：主进程判断「一轮跑完没有 + 要不要弹系统通知 + 文案」，
   渲染层只决定「要不要弹应用内提示」。所以这一组测的是：
     · 后台对话结束 → 弹（带「查看结果」）
     · 当前对话结束 → 不弹
     · 窗口在后台 → 当前对话也弹
     · 点「查看结果」→ 切到那条对话 + 打开任务中心
     · 点系统通知 → 同上（主进程已经把窗口叫回来了）
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  taskEnd: [] as Array<(payload: TaskEndPayload) => void>,
  clicks: [] as Array<(payload: { id: string }) => void>,
}))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: true }
})

vi.mock('@/lib/subscriptions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/subscriptions')>()
  return {
    ...actual,
    subscribeTaskEnd: (callback: (payload: TaskEndPayload) => void) => {
      h.taskEnd.push(callback)
      return () => {}
    },
    subscribeNotificationClick: (callback: (payload: { id: string }) => void) => {
      h.clicks.push(callback)
      return () => {}
    },
  }
})

import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useTaskNotifications } from '@/hooks/useTaskNotifications'
import { ToastViewport } from '@/components/ui/Toast'

let container: HTMLDivElement
let root: Root

function Probe() {
  useTaskNotifications()
  return null
}

/** 挂上 hook 和真的 toast 视口 —— 点「查看结果」要走真组件才算端到端 */
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

const payload = (sessionId: string, patch: Partial<TaskEndPayload> = {}): TaskEndPayload => ({
  sessionId,
  kind: 'success',
  title: '后台任务完成',
  description: '「重构执行引擎」\n已修改 4 个文件\n测试通过',
  ...patch,
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  h.taskEnd = []
  h.clicks = []
  useAppStore.getState().resetAll()
  useUIStore.setState({ toasts: [] })
  /* jsdom 没有真窗口，hasFocus 恒为 false；默认按「窗口在前台」测 */
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  draw()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('AG-029 / 后台任务通知（渲染层）', () => {
  it('★ 别的对话跑完了 → 弹一条带「查看结果」的提示', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)

    act(() => h.taskEnd[0](payload(other)))

    const toasts = useUIStore.getState().toasts
    expect(toasts.length).toBe(1)
    expect(toasts[0].title).toBe('后台任务完成')
    /* 文案是主进程给的，渲染层不改写 */
    expect(toasts[0].description).toContain('重构执行引擎')
    expect(toasts[0].description).toContain('已修改 4 个文件')
    expect(toasts[0].action?.label).toBe('查看结果')
  })

  it('★ 用户正看着的那条对话结束 → 不弹（不打扰）', () => {
    const active = useAppStore.getState().activeThreadId
    act(() => h.taskEnd[0](payload(active)))
    expect(useUIStore.getState().toasts.length).toBe(0)
  })

  it('★ 窗口在后台时，当前对话结束也要提示（用户根本没看到）', () => {
    const active = useAppStore.getState().activeThreadId
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => h.taskEnd[0](payload(active)))
    expect(useUIStore.getState().toasts.length).toBe(1)
  })

  it('★ 点「查看结果」→ 切到那条对话 + 打开任务中心（并且不抢焦点）', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    act(() => h.taskEnd[0](payload(other)))

    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '查看结果',
    )
    expect(button).toBeTruthy()
    act(() => button?.click())

    expect(useAppStore.getState().activeThreadId).toBe(other)
    expect(useUIStore.getState().activeRightTab).toBe('tasks')
    /* 点完这条提示就收掉，不留一条点过了还在那儿的通知 */
    expect(useUIStore.getState().toasts.length).toBe(0)
  })

  it('★ 点系统通知 → 和点「查看结果」走同一条路', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    expect(h.clicks.length).toBe(1)

    act(() => h.clicks[0]({ id: other }))

    expect(useAppStore.getState().activeThreadId).toBe(other)
    expect(useUIStore.getState().activeRightTab).toBe('tasks')
  })

  it('失败的通知用 error 样式（kind 由主进程给）', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    /* createThread 会把新对话设为当前 —— 先切回去，让它成为「后台那条」 */
    useAppStore.getState().setActiveThread(active)
    act(() => h.taskEnd[0](payload(other, { kind: 'error', title: '后台任务失败' })))
    expect(useUIStore.getState().toasts[0].kind).toBe('error')
    expect(useUIStore.getState().toasts[0].title).toBe('后台任务失败')
  })
})
