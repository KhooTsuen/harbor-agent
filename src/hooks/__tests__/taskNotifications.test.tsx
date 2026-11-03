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
     · 点「需要你确认」的通知 → 切回那条对话 + 亮卡片，**不打开任务中心**
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  taskEnd: [] as Array<(payload: TaskEndPayload) => void>,
  clicks: [] as Array<(payload: { id: string; kind?: string }) => void>,
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
    subscribeNotificationClick: (callback: (payload: { id: string; kind?: string }) => void) => {
      h.clicks.push(callback)
      return () => {}
    },
  }
})

import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useNotifyCenter } from '@/stores/useNotifyCenter'
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
  outcome: {
    taskId: 'task_1',
    files: 4,
    tests: 'passed',
    testCommand: 'npm test',
    testSummary: '12 passed',
  },
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
  useNotifyCenter.setState({ items: [] })
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
  it('★ 别的对话跑完了 → 进「通知」标签（带「查看结果」），不弹右下角', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)

    act(() => h.taskEnd[0](payload(other)))

    /*
     * 2026-11 改口：任务结果不再弹右下角卡片 —— 那时用户多半在看别处，
     * 弹出来只会打断他。改放进「通知」标签（右栏那个入口会亮未读点）。
     * ★ 这条测试的**原意图**没变：跑完了必须让用户看得见、且点得回结果。
     */
    expect(useUIStore.getState().toasts).toHaveLength(0)
    const items = useNotifyCenter.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].category).toBe('task')
    expect(items[0].title).toBe('后台任务完成')
    /* 文案是主进程给的，渲染层不改写 */
    expect(items[0].description).toContain('重构执行引擎')
    expect(items[0].description).toContain('已修改 4 个文件')
    expect(items[0].action?.label).toBe('查看结果')
    /* 未读 —— 右栏那个标签会亮一个点 */
    expect(items[0].unread).toBe(true)
  })

  it('★ 用户正看着的那条对话结束 → 连通知都不进（不打扰）', () => {
    const active = useAppStore.getState().activeThreadId
    act(() => h.taskEnd[0](payload(active)))
    expect(useUIStore.getState().toasts.length).toBe(0)
    expect(useNotifyCenter.getState().items.length).toBe(0)
  })

  it('★ 窗口在后台时，当前对话结束也要提示（用户根本没看到）', () => {
    const active = useAppStore.getState().activeThreadId
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => h.taskEnd[0](payload(active)))
    expect(useNotifyCenter.getState().items.length).toBe(1)
  })

  it('★ 点「查看结果」→ 切到那条对话 + 打开任务中心（并且不抢焦点）', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    act(() => h.taskEnd[0](payload(other)))

    /* 按钮现在长在通知条目上（面板里那个）；点它走的是同一条跳转 */
    const action = useNotifyCenter.getState().items[0].action
    expect(action).toBeTruthy()
    act(() => action?.run())

    expect(useAppStore.getState().activeThreadId).toBe(other)
    expect(useUIStore.getState().activeRightTab).toBe('tasks')
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

  it('★ 点「需要你确认」的通知 → 切回那条对话 + 亮卡片（不打开任务中心）', () => {
    /*
     * P1-3：用户切走之后卡片弹出来，他点通知就是冲着**那张卡**来的 ——
     * 任务中心是「看结果」的地方，把他扔到那儿等于又得自己找一遍。
     */
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    /* 右栏先停在「审查」—— 上一条测试把标签留在任务中心了，不设的话这条断言没意义 */
    useUIStore.setState({ activeRightTab: 'diff', cardFocusNonce: 0 })

    act(() => h.clicks[0]({ id: other, kind: 'confirm' }))

    expect(useAppStore.getState().activeThreadId).toBe(other)
    expect(useUIStore.getState().cardFocusNonce).toBe(1)
    expect(useUIStore.getState().activeRightTab).toBe('diff')
  })

  it('★ AG-033：当前对话完成 → 亮出「下一步」入口', () => {
    const active = useAppStore.getState().activeThreadId
    useUIStore.setState({ nextSteps: null })
    act(() => h.taskEnd[0](payload(active)))
    expect(useUIStore.getState().nextSteps?.threadId).toBe(active)
    expect(useUIStore.getState().nextSteps?.outcome.files).toBe(4)
    expect(useUIStore.getState().nextSteps?.outcome.tests).toBe('passed')
  })

  it('★ AG-033：别的对话完成 → 不在这条对话上亮入口', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    useUIStore.setState({ nextSteps: null })
    act(() => h.taskEnd[0](payload(other)))
    expect(useUIStore.getState().nextSteps).toBeNull()
  })

  it('★ AG-033：失败不亮「下一步」（文档说的是「任务完成后」）', () => {
    const active = useAppStore.getState().activeThreadId
    useUIStore.setState({ nextSteps: null })
    act(() => h.taskEnd[0](payload(active, { kind: 'error', title: '后台任务失败' })))
    expect(useUIStore.getState().nextSteps).toBeNull()
  })

  it('失败的通知用 error 样式（kind 由主进程给）', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    /* createThread 会把新对话设为当前 —— 先切回去，让它成为「后台那条」 */
    useAppStore.getState().setActiveThread(active)
    act(() => h.taskEnd[0](payload(other, { kind: 'error', title: '后台任务失败' })))
    const items = useNotifyCenter.getState().items
    expect(items[0].kind).toBe('error')
    expect(items[0].title).toBe('后台任务失败')
  })
})
