import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   下一步 卡片（AG-033，真渲染）

   文档要求「只能作为快捷入口」——所以这里逐条验：
     · 点「运行测试 / 提交修改 / 继续检查」→ **只是发一句话**（走普通发送链路，
       权限该问还是问），不是直接执行
     · 点「查看 Diff」→ 只切右栏标签，不发消息
     · 点完 / 关掉之后卡片消失；切到别的对话不显示
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({ sent: [] as string[] }))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return { ...actual, useRealBackend: false }
})

import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'
import { NextSteps } from '../NextSteps'

let container: HTMLDivElement
let root: Root

function draw(): void {
  act(() => root.render(<NextSteps />))
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  h.sent = []
  useAppStore.getState().resetAll()
  useUIStore.setState({ nextSteps: null, activeRightTab: 'state' })
  /* 拦下发送：断言「入口只是发消息」，不真的跑一轮 */
  useThreadStore.setState({
    sendMessage: (override?: string) => {
      h.sent.push(String(override ?? ''))
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useThreadStore.setState({ sendMessage: useThreadStore.getInitialState?.().sendMessage })
})

describe('AG-033 / 下一步卡片', () => {
  it('有下一步时列出四项（改了文件）', () => {
    const threadId = useAppStore.getState().activeThreadId
    useUIStore.setState({ nextSteps: { threadId, files: 2 } })
    draw()
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels.some((t) => t?.startsWith('运行测试'))).toBe(true)
    expect(labels.some((t) => t?.startsWith('查看 Diff'))).toBe(true)
    expect(labels.some((t) => t?.startsWith('提交修改'))).toBe(true)
    expect(labels.some((t) => t?.startsWith('继续检查'))).toBe(true)
  })

  it('没改文件 → 只有「继续检查」', () => {
    const threadId = useAppStore.getState().activeThreadId
    useUIStore.setState({ nextSteps: { threadId, files: 0 } })
    draw()
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels.some((t) => t?.startsWith('继续检查'))).toBe(true)
    expect(labels.some((t) => t?.startsWith('运行测试'))).toBe(false)
  })

  it('★ 点「运行测试」= 发一句话（不是直接跑命令）', () => {
    const threadId = useAppStore.getState().activeThreadId
    useUIStore.setState({ nextSteps: { threadId, files: 1 } })
    draw()
    act(() => button('运行测试')?.click())
    expect(h.sent.length).toBe(1)
    expect(h.sent[0]).toContain('测试')
    /* 点完就收掉 */
    expect(useUIStore.getState().nextSteps).toBeNull()
  })

  it('★ 点「查看 Diff」= 只切右栏，不发消息', () => {
    const threadId = useAppStore.getState().activeThreadId
    useUIStore.setState({ nextSteps: { threadId, files: 1 } })
    draw()
    act(() => button('查看 Diff')?.click())
    expect(h.sent.length).toBe(0)
    expect(useUIStore.getState().activeRightTab).toBe('diff')
    expect(useUIStore.getState().nextSteps).toBeNull()
  })

  it('★ 点「提交修改」发的是「先给我看，我确认后再提交」', () => {
    const threadId = useAppStore.getState().activeThreadId
    useUIStore.setState({ nextSteps: { threadId, files: 1 } })
    draw()
    act(() => button('提交修改')?.click())
    expect(h.sent[0]).toContain('我确认之后再提交')
  })

  it('别的对话的任务结束了 → 这条对话不显示', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    /* createThread 会把新对话设为当前 —— 先切回原来那条，才是「别的对话」 */
    useAppStore.getState().setActiveThread(active)
    useUIStore.setState({ nextSteps: { threadId: other, files: 3 } })
    draw()
    expect(container.querySelector('[aria-label="下一步"]')).toBeNull()
  })

  it('「不用了」能关掉', () => {
    const threadId = useAppStore.getState().activeThreadId
    useUIStore.setState({ nextSteps: { threadId, files: 1 } })
    draw()
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="不用了"]')?.click())
    expect(useUIStore.getState().nextSteps).toBeNull()
  })
})
