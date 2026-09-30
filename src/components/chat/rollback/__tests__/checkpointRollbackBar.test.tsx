import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '@/types/safety'
import type { RollbackResult } from '@/lib/checkpointRollbackApi'

/* ══════════════════════════════════════════════════════════════
   「撤销检查点之后的改动」入口（AG-052，真渲染）

   这个入口是为了补上一个**只有接口、没有入口**的能力（preload / handler /
   IPC 清单三处都在，`src/**` 零调用点）。所以这里钉的是那条链路，不是长相：

     ① 什么时候出：任务停了、且有检查点 —— 跑着的时候不给（撤到哪一份看运气）
     ② 点一下 → 先**干跑预览**，再弹确认框；确认框里要有影响预览（撤哪些 / 删哪些 / 哪些撤不动）
     ③ 预览失败 → 不弹确认框，只报错（不能让用户确认一个算不出来的操作）
     ④ 只有点了确认才真撤；取消 → 一个字节都没动
     ⑤ 撤完留痕：任务快照里记一笔（审查面板顶上那条记录读它）+ toast 带「看审查面板」
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  tasks: [] as unknown[],
  preview: { ok: true } as Record<string, unknown>,
  applied: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/safetyApi', () => ({
  taskList: async () => h.tasks,
  /* refresh 一次拉四样，缺一个就是未处理的 Promise 拒绝（会污染整个文件的结果） */
  taskRecovery: async () => [],
  changesetList: async () => [],
  changesetDiff: async () => null,
}))

vi.mock('@/lib/checkpointRollbackApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/checkpointRollbackApi')>()
  return {
    ...actual,
    rollbackBridgeReady: () => true,
    rollbackPreview: async () => h.preview as unknown as RollbackResult,
    rollbackApply: async (taskId: string, checkpointId: number | string) => {
      h.applied.push({ taskId, checkpointId })
      return h.preview as unknown as RollbackResult
    },
  }
})

import { useAppStore } from '@/stores/useAppStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { useUIStore } from '@/stores/useUIStore'
import { CheckpointRollbackBar, pickRollbackTarget } from '../CheckpointRollbackBar'

let container: HTMLDivElement
let root: Root

const CONV = 'sess_demo'

const task = (patch: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    id: 'task_1',
    title: '改点东西',
    status: 'completed',
    sessionId: CONV,
    checkpoints: [
      { at: 1000, label: '第 1 轮改动完成', note: '' },
      { at: 2000, label: '第 2 轮结束', note: '' },
    ],
    ...patch,
  }) as TaskRecord

const previewOk: RollbackResult = {
  ok: true,
  dryRun: true,
  restored: ['E:/demo/keep.txt'],
  removed: ['E:/demo/new.txt'],
  failed: [],
  skipped: [{ path: 'E:/demo/old.txt', reason: '这个文件的改动在检查点之前' }],
  changesets: ['cs_1'],
  checkpoint: { at: 1000, label: '第 1 轮改动完成', index: 0 },
}

/**
 * 等异步链路跑完（取任务 → 干跑 → 真撤全是 async）。
 * 只 await 几个微任务在单独跑这个文件时够用，**整套跑**（机器忙）就会漏 ——
 * 所以这里让出一个宏任务（React 的调度也走任务队列）。
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * 反复让一步直到条件成立。
 * 固定等几个 tick 在本机单跑时够、整套跑就会飘（这条踩过两次：一次是
 * 「留痕」、一次是「toast」莫名其妙拿到 undefined）—— 等状态而不是等时间。
 */
async function until(cond: () => boolean, turns = 20): Promise<void> {
  for (let i = 0; i < turns && !cond(); i += 1) await flush()
}

const menuItems = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
]

/** 点开菜单 → 选第 index 个检查点 → 等预览算完 */
async function pickCheckpoint(index: number): Promise<void> {
  await act(async () => {
    buttonByText('撤销检查点之后的改动')?.click()
  })
  await until(() => menuItems().length > index)
  await act(async () => {
    menuItems()[index]?.click()
  })
  await flush()
}

async function draw(): Promise<void> {
  await act(async () => {
    root.render(<CheckpointRollbackBar conversationId={CONV} />)
  })
  await flush()
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text)) as
    HTMLButtonElement | undefined

beforeEach(() => {
  h.tasks = [task()]
  h.preview = previewOk as unknown as Record<string, unknown>
  h.applied = []
  document.body.innerHTML = ''
  useUIStore.setState({ permission: null, toasts: [], activeRightTab: 'state' })
  useTaskStore.setState({ lastRollback: null })
  useAppStore.getState().resetAll()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('挑哪条任务', () => {
  it('★ 取最近有检查点的那条（回退按钮说的是它）', () => {
    const older = task({ id: 'task_old', checkpoints: [{ at: 10, label: '早', note: '' }] })
    const newer = task({ id: 'task_new', checkpoints: [{ at: 99, label: '晚', note: '' }] })
    expect(pickRollbackTarget([older, newer])?.id).toBe('task_new')
    expect(pickRollbackTarget([newer, older])?.id).toBe('task_new')
  })

  it('没有检查点的任务不算数', () => {
    expect(pickRollbackTarget([task({ checkpoints: [] })])).toBeNull()
  })
})

describe('什么时候出这个入口', () => {
  it('任务停了、有检查点 → 出按钮', async () => {
    await draw()
    expect(buttonByText('撤销检查点之后的改动')).toBeTruthy()
  })

  it('★ 按钮写全名：不叫「回到检查点」那种大名字（它比能力大）', async () => {
    await draw()
    await act(async () => {
      buttonByText('撤销检查点之后的改动')?.click()
    })
    await until(() => menuItems().length > 0)
    const all = [...document.querySelectorAll('button')].map((b) => b.textContent ?? '').join('|')
    expect(all).toContain('撤销检查点之后的改动')
    for (const bad of ['退回检查点', '回到检查点', '恢复到此检查点']) expect(all).not.toContain(bad)
  })

  it('★ 任务还在跑 → 不给（正在改文件的当口回退，撤到哪一份看运气）', async () => {
    h.tasks = [task({ status: 'running' })]
    await draw()
    expect(buttonByText('撤销检查点之后的改动')).toBeUndefined()
  })

  it('没有检查点 → 不出', async () => {
    h.tasks = [task({ checkpoints: [] })]
    await draw()
    expect(buttonByText('撤销检查点之后的改动')).toBeUndefined()
  })

  it('这条对话没有任务 → 不出', async () => {
    h.tasks = []
    await draw()
    expect(buttonByText('撤销检查点之后的改动')).toBeUndefined()
  })
})

describe('两步确认', () => {
  it('★ 点开菜单：列出检查点，最近的在最前', async () => {
    await draw()
    await act(async () => {
      buttonByText('撤销检查点之后的改动')?.click()
    })
    await until(() => menuItems().length > 0)
    const items = menuItems().map((item) => item.textContent ?? '')
    expect(items).toHaveLength(2)
    expect(items[0]).toContain('第 2 轮结束')
    expect(items[1]).toContain('第 1 轮改动完成')
  })

  it('★ 选一个 → 干跑预览 → 弹确认框（带影响预览）', async () => {
    await draw()
    await pickCheckpoint(1)
    await until(() => useUIStore.getState().permission !== null)

    const request = useUIStore.getState().permission
    expect(request).not.toBeNull()
    expect(request?.kind).toBe('rollback-checkpoint')
    expect(request?.danger).toBe(true)
    /* 标题点明撤到哪一刻，正文说清「只撤首次被改的」 */
    expect(String(request?.title)).toContain('第 1 轮改动完成')
    expect(String(request?.description)).toContain('检查点之前')
    const impact = (request?.impact ?? []).join('\n')
    expect(impact).toContain('恢复 1 个')
    expect(impact).toContain('删掉 1 个')
    expect(impact).toContain('留着 1 个')
    /* 还没确认：一个字都不许动盘 */
    expect(h.applied).toHaveLength(0)
  })

  it('★ 取消 → 什么都没发生', async () => {
    await draw()
    await pickCheckpoint(0)
    await until(() => useUIStore.getState().permission !== null)
    act(() => useUIStore.getState().closePermission())
    expect(h.applied).toHaveLength(0)
    expect(useTaskStore.getState().lastRollback).toBeNull()
  })

  it('预览算不出来 → 只报错，不弹确认框（不能让用户确认一个算不出来的操作）', async () => {
    h.preview = { ok: false, error: '这条任务还没有检查点' }
    await draw()
    await pickCheckpoint(0)
    await until(() => useUIStore.getState().toasts.length > 0)
    expect(useUIStore.getState().permission).toBeNull()
    expect(useUIStore.getState().toasts.at(-1)?.title).toBe('撤不了')
  })
})

describe('确认之后', () => {
  async function confirm(): Promise<void> {
    await draw()
    await pickCheckpoint(1)
    await until(() => useUIStore.getState().permission !== null)
    await act(async () => {
      useUIStore.getState().permission?.onConfirm()
    })
    await until(() => useTaskStore.getState().lastRollback !== null)
  }

  it('★ 真撤：按选中的检查点调内核', async () => {
    await confirm()
    expect(h.applied).toEqual([{ taskId: 'task_1', checkpointId: 1000 }])
  })

  it('★ 留痕：任务快照里记一笔（审查面板顶上那条记录读它）', async () => {
    await confirm()
    const record = useTaskStore.getState().lastRollback
    expect(record?.taskId).toBe('task_1')
    expect(record?.checkpointLabel).toBe('第 1 轮改动完成')
    expect(record?.result.restored).toEqual(['E:/demo/keep.txt'])
  })

  it('★ toast 说清撤了什么，并给一个「看审查面板」的入口', async () => {
    await confirm()
    await until(() => useUIStore.getState().toasts.length > 0)
    const toast = useUIStore.getState().toasts.at(-1)
    expect(String(toast?.title)).toContain('第 1 轮改动完成')
    expect(String(toast?.description)).toContain('恢复 1 个')
    expect(toast?.action?.label).toBe('看审查面板')
    act(() => toast?.action?.onClick())
    expect(useUIStore.getState().activeRightTab).toBe('diff')
  })

  it('撤不动的文件在结果里说出来（不假装撤干净了）', async () => {
    await confirm()
    expect(useTaskStore.getState().lastRollback?.result.skipped).toHaveLength(1)
  })
})
