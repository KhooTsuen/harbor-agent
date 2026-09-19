import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   AG-029 后台任务通知（真跑 hook）

   为什么不用源码守卫：这一个功能的关键全在**时机**上 ——
     · 后台对话结束 → 弹
     · 当前对话结束 → 不弹
     · 用户自己按的停止 → 不弹
     · 点「查看结果」→ 切到那条对话 + 打开任务中心
   这些都是行为，得真跑一遍才算验证过。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({ tasks: [] as TaskRecord[] }))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: true }
})

vi.mock('@/lib/safetyApi', () => ({
  taskList: async () => h.tasks,
  taskRecovery: async () => [],
  changesetList: async () => [],
  taskUpdate: async () => {},
  changesetRollback: async () => ({ ok: true, restored: [], removed: [], failed: [] }),
}))

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

/** 把 store 里的异步回调跑完（hook 里 notify 是 await 出来的） */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function makeTask(sessionId: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: `task-${sessionId}`,
    title: '重构执行引擎',
    goal: '重构执行引擎',
    status: 'completed',
    mode: 'pair',
    sessionId,
    projectId: '',
    workdir: 'E:/demo',
    plan: [],
    steps: [],
    checkpoints: [],
    changedFiles: [{ path: 'src/a.ts', at: 1 }],
    commands: [],
    changeSetId: '',
    errors: [],
    result: '测试通过',
    createdAt: 1,
    updatedAt: 2,
    finishedAt: 2,
    ...patch,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  h.tasks = []
  useAppStore.getState().resetAll()
  useUIStore.setState({ toasts: [] })
  /*
   * jsdom 没有真窗口，`document.hasFocus()` 恒为 false ——
   * 而「窗口在后台就要通知」是真实行为，不 stub 的话“正在看的对话”那条用例
   * 会被当成后台，测不出想测的东西。默认按「窗口在前台」测。
   */
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  draw()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('AG-029 / 后台任务通知', () => {
  it('★ 别的对话跑完了 → 弹一条带「查看结果」的通知', async () => {
    const active = useAppStore.getState().activeThreadId
    /* 造一条「别的对话」并让它从跑到结束 */
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    h.tasks = [makeTask(other)]

    act(() => useAppStore.getState().setThreadPhase(other, 'executing'))
    await flush()
    expect(useUIStore.getState().toasts.length).toBe(0)

    act(() => useAppStore.getState().setThreadPhase(other, 'completed'))
    await flush()

    const toasts = useUIStore.getState().toasts
    expect(toasts.length).toBe(1)
    expect(toasts[0].title).toBe('后台任务完成')
    expect(toasts[0].description).toContain('重构执行引擎')
    expect(toasts[0].description).toContain('已修改 1 个文件')
    expect(toasts[0].action?.label).toBe('查看结果')
  })

  it('★ 用户正看着的那条对话结束 → 不弹（不打扰）', async () => {
    const active = useAppStore.getState().activeThreadId
    h.tasks = [makeTask(active)]

    act(() => useAppStore.getState().setThreadPhase(active, 'executing'))
    await flush()
    act(() => useAppStore.getState().setThreadPhase(active, 'completed'))
    await flush()

    expect(useUIStore.getState().toasts.length).toBe(0)
  })

  it('★ 用户自己按的停止 → 不弹（那是他刚做的事）', async () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    h.tasks = [makeTask(other, { status: 'cancelled' })]

    act(() => useAppStore.getState().setThreadPhase(other, 'executing'))
    await flush()
    act(() => useAppStore.getState().setThreadPhase(other, 'cancelled'))
    await flush()

    expect(useUIStore.getState().toasts.length).toBe(0)
  })

  it('★ 点「查看结果」→ 切到那条对话 + 打开任务中心（并且不抢焦点）', async () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    h.tasks = [makeTask(other)]

    act(() => useAppStore.getState().setThreadPhase(other, 'executing'))
    await flush()
    act(() => useAppStore.getState().setThreadPhase(other, 'completed'))
    await flush()

    /* 走真组件：找到那条通知上的按钮点下去 */
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

  it('★ 窗口在后台时，当前对话结束也要通知（用户根本没看到）', async () => {
    const active = useAppStore.getState().activeThreadId
    h.tasks = [makeTask(active)]
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    act(() => useAppStore.getState().setThreadPhase(active, 'executing'))
    await flush()
    act(() => useAppStore.getState().setThreadPhase(active, 'completed'))
    await flush()

    expect(useUIStore.getState().toasts.length).toBe(1)
  })

  it('★ 启动时那些「早就结束」的对话不该被当成刚完成', async () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    act(() => useAppStore.getState().setThreadPhase(other, 'completed'))

    /* 重新挂一次监听（模拟重启时注册）—— 它第一次拿到的状态里 other 已经是「已完成」*/
    act(() => root.unmount())
    root = createRoot(container)
    draw()

    /* 之后随便发生一次别的状态变化（这里让第三条对话开始跑）——
       监听会遍历所有对话，但那条早就结束的**不该**被当成刚结束。 */
    const third = useAppStore.getState().createThread()
    useAppStore.getState().setActiveThread(active)
    act(() => useAppStore.getState().setThreadPhase(third, 'executing'))
    await flush()

    expect(useUIStore.getState().toasts.length).toBe(0)
  })
})
