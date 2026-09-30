import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   「撤销检查点之后的改动」入口（AG-052，真渲染）

   这个入口是为了补上一个**只有接口、没有入口**的能力（preload / handler /
   IPC 清单三处都在，`src/**` 零调用点）—— 所以这里钉的是链路，不是长相：
   什么时候出、点一下先干跑预览再问人、预览失败只报错、没确认不动盘、撤完留痕。

   夹具、假的桥、DOM 助手都在 `rollbackHarness.tsx`（拆出去是因为这边顶过 300 行）。
   ══════════════════════════════════════════════════════════════ */

/* `vi.mock` 是 hoisted 的，必须留在测试文件里；工厂函数在夹具那边 */
vi.mock('@/lib/safetyApi', async () => (await import('./rollbackHarness')).safetyApiMock())
vi.mock('@/lib/checkpointRollbackApi', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return (await import('./rollbackHarness')).rollbackApiMock(actual)
})

import { useAppStore } from '@/stores/useAppStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { useUIStore } from '@/stores/useUIStore'
import { CheckpointRollbackBar, pickRollbackTarget } from '../CheckpointRollbackBar'
import {
  CONV,
  flush,
  harness,
  menuItems,
  pickCheckpoint,
  resetHarness,
  task,
  until,
} from './rollbackHarness'

let container: HTMLDivElement
let root: Root

const LABEL = '撤销检查点之后的改动'
const clickTrigger = (): void => {
  act(() => {
    ;[...document.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes(LABEL))
      ?.click()
  })
}

async function draw(): Promise<void> {
  await act(async () => {
    root.render(<CheckpointRollbackBar conversationId={CONV} />)
  })
  await flush()
}

beforeEach(() => {
  resetHarness()
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
    expect(document.body.textContent).toContain(LABEL)
  })

  it('★ 任务还在跑 → 不给（正在改文件的当口回退，撤到哪一份看运气）', async () => {
    harness.tasks = [task({ status: 'running' })]
    await draw()
    expect(document.body.textContent).not.toContain(LABEL)
  })

  it('没有检查点 → 不出', async () => {
    harness.tasks = [task({ checkpoints: [] })]
    await draw()
    expect(document.body.textContent).not.toContain(LABEL)
  })

  it('这条对话没有任务 → 不出', async () => {
    harness.tasks = []
    await draw()
    expect(document.body.textContent).not.toContain(LABEL)
  })
})

describe('两步确认', () => {
  it('★ 点开菜单：列出检查点，最近的在最前', async () => {
    await draw()
    clickTrigger()
    const items = menuItems().map((item) => item.textContent ?? '')
    expect(items).toHaveLength(2)
    expect(items[0]).toContain('第 2 轮结束')
    expect(items[1]).toContain('第 1 轮改动完成')
  })

  it('★ 按钮写全名：不叫「回到检查点」那种大名字（它比能力大）', async () => {
    await draw()
    clickTrigger()
    const all = [...document.querySelectorAll('button')].map((b) => b.textContent ?? '').join('|')
    expect(all).toContain(LABEL)
    for (const bad of ['退回检查点', '回到检查点', '恢复到此检查点']) expect(all).not.toContain(bad)
  })

  it('★ 选一个 → 干跑预览 → 弹确认框（带影响预览）', async () => {
    await draw()
    await pickCheckpoint(1)

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
    expect(harness.applied).toHaveLength(0)
  })

  it('★ 取消 → 什么都没发生', async () => {
    await draw()
    await pickCheckpoint(0)
    await until(() => useUIStore.getState().permission !== null)
    act(() => useUIStore.getState().closePermission())
    expect(harness.applied).toHaveLength(0)
    expect(useTaskStore.getState().lastRollback).toBeNull()
  })

  it('预览算不出来 → 只报错，不弹确认框（不能让用户确认一个算不出来的操作）', async () => {
    harness.preview = { ok: false, error: '这条任务还没有检查点' }
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
      useUIStore.getState().permission?.onConfirm?.()
    })
    await until(() => useTaskStore.getState().lastRollback !== null)
  }

  it('★ 真撤：按选中的检查点调内核', async () => {
    await confirm()
    expect(harness.applied).toEqual([{ taskId: 'task_1', checkpointId: 1000 }])
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
