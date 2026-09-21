import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskOutcome } from '@/types/notify'

/* ══════════════════════════════════════════════════════════════
   下一步 卡片（AG-033/034，真渲染）

   文档要求「只能作为快捷入口」——所以这里逐条验：
     · 点「运行测试 / 提交修改 / 继续检查」→ **只是发一句话**（走普通发送链路，
       权限该问还是问），不是直接执行
     · 点「查看 Diff」→ 只切右栏，不发消息
     · 点「查看测试结果」→ 就地展开台账里记的那条命令和输出（AG-034）
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

let seq = 0
const outcome = (patch: Partial<TaskOutcome> = {}): TaskOutcome => ({
  taskId: `task_${(seq += 1)}`,
  files: 0,
  tests: 'none',
  testCommand: '',
  testSummary: '',
  ...patch,
})

const show = (patch: Partial<TaskOutcome> = {}, threadId?: string): void => {
  const id = threadId ?? useAppStore.getState().activeThreadId
  act(() => {
    useUIStore.setState({ nextSteps: { threadId: id, outcome: outcome(patch) } })
  })
  draw()
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label))

const labels = () => [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())

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

describe('AG-034 / 卡片按上下文给入口', () => {
  it('改了文件、没跑测试：头一句 + 四个入口', () => {
    show({ files: 2 })
    expect(container.textContent).toContain('修改完成，测试尚未运行。')
    expect(labels().some((t) => t?.startsWith('运行测试'))).toBe(true)
    expect(labels().some((t) => t?.startsWith('查看 Diff'))).toBe(true)
    expect(labels().some((t) => t?.startsWith('提交修改'))).toBe(true)
    expect(labels().some((t) => t?.startsWith('继续优化'))).toBe(true)
  })

  it('★ 测试过了 → 头一句说通过、给「查看测试结果」、不再劝跑测试', () => {
    show({ files: 2, tests: 'passed' })
    expect(container.textContent).toContain('修改完成，测试通过。')
    expect(labels().some((t) => t?.startsWith('查看测试结果'))).toBe(true)
    expect(labels().some((t) => t?.startsWith('运行测试'))).toBe(false)
  })

  it('★ 测试没过 → 头一句说没过、不给「提交修改」', () => {
    show({ files: 2, tests: 'failed' })
    expect(container.textContent).toContain('测试没有通过。')
    expect(labels().some((t) => t?.startsWith('定位失败原因'))).toBe(true)
    expect(labels().some((t) => t?.startsWith('提交修改'))).toBe(false)
  })

  it('没改文件 → 不提 diff / 测试 / 提交', () => {
    show()
    expect(labels().some((t) => t?.startsWith('查看 Diff'))).toBe(false)
    expect(labels().some((t) => t?.startsWith('提交修改'))).toBe(false)
  })
})

describe('AG-034 / 点下去发生什么', () => {
  it('★ 点「运行测试」= 发一句话（不是直接跑命令）', () => {
    show({ files: 1 })
    act(() => button('运行测试')?.click())
    expect(h.sent.length).toBe(1)
    expect(h.sent[0]).toContain('测试')
    expect(useUIStore.getState().nextSteps).toBeNull()
  })

  it('★ 点「查看 Diff」= 只切右栏，不发消息', () => {
    show({ files: 1 })
    act(() => button('查看 Diff')?.click())
    expect(h.sent.length).toBe(0)
    expect(useUIStore.getState().activeRightTab).toBe('diff')
    expect(useUIStore.getState().nextSteps).toBeNull()
  })

  it('★ 点「提交修改」发的是「先给我看，我确认后再提交」', () => {
    show({ files: 1 })
    act(() => button('提交修改')?.click())
    expect(h.sent[0]).toContain('我确认之后再提交')
  })

  it('★ 点「查看测试结果」= 就地展开台账里那条命令和输出，不发消息', () => {
    show({
      files: 1,
      tests: 'failed',
      testCommand: 'npm test -- --run',
      testSummary: 'FAIL src/lib/x.test.ts\n ✕ 算错了\n[退出码 1]',
    })
    expect(container.textContent).not.toContain('算错了')
    act(() => button('查看测试结果')?.click())
    expect(h.sent.length).toBe(0)
    expect(container.textContent).toContain('npm test -- --run')
    expect(container.textContent).toContain('算错了')
    /* 卡片自己还在（只是展开，不是执行掉了） */
    expect(useUIStore.getState().nextSteps).not.toBeNull()
  })

  it('★ 展开后能收起', () => {
    show({ tests: 'passed', testCommand: 'npm test', testSummary: '12 passed' })
    act(() => button('查看测试结果')?.click())
    expect(container.textContent).toContain('12 passed')
    act(() => button('收起')?.click())
    expect(container.textContent).not.toContain('12 passed')
  })

  it('★ 换了一轮任务 → 上轮展开的结果自动收起（真机探针逮到的）', () => {
    /* 真机上连着两轮跑的是**同一条命令** —— 所以身份不能按命令认 */
    show({ tests: 'passed', testCommand: 'python tests.py', testSummary: 'OK：结构完整' })
    act(() => button('查看测试结果')?.click())
    expect(container.textContent).toContain('OK：结构完整')
    /* 第二轮跑完，卡片换成新一轮的结果 */
    show({ tests: 'failed', testCommand: 'python tests.py', testSummary: 'FAIL：少了安装一节' })
    expect(container.textContent).toContain('测试没有通过。')
    expect(container.textContent).not.toContain('OK：结构完整')
    expect(container.textContent).not.toContain('FAIL：少了安装一节')
  })

  it('别的对话的任务结束了 → 这条对话不显示', () => {
    const active = useAppStore.getState().activeThreadId
    const other = useAppStore.getState().createThread()
    /* createThread 会把新对话设为当前 —— 先切回原来那条，才是「别的对话」 */
    useAppStore.getState().setActiveThread(active)
    show({ files: 3 }, other)
    expect(container.querySelector('[aria-label="下一步"]')).toBeNull()
  })

  it('「不用了」能关掉', () => {
    show({ files: 1 })
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="不用了"]')?.click())
    expect(useUIStore.getState().nextSteps).toBeNull()
  })
})
