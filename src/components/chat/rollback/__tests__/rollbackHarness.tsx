import { act } from 'react'
import type { TaskRecord } from '@/types/safety'
import type { RollbackResult } from '@/lib/checkpointRollbackApi'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   「撤销检查点之后的改动」测试夹具（AG-052）

   从 `checkpointRollbackBar.test.tsx` 拆出来的：那边加上重试逻辑之后 303 行，
   顶破硬约束 #2。拆的原则是**按职责**——夹具、假的桥、DOM 助手是「怎么搭台子」，
   测试文件里留下的只有「验什么」。测试文件里仍要写 `vi.mock(...)`（那是 hoisted，
   必须留在测试文件里），但工厂函数与状态都在这里。

   ⚠️ 状态是**模块级**的：每个用例前必须 `resetHarness()`，否则上一条用例的
      `applied` / `toasts` 会漏到下一条（这里踩过一次：断言莫名其妙拿到 undefined）。
   ══════════════════════════════════════════════════════════════ */

export const CONV = 'sess_demo'

export const harness = {
  tasks: [] as unknown[],
  preview: { ok: true } as Record<string, unknown>,
  applied: [] as Array<Record<string, unknown>>,
}

export function resetHarness(): void {
  harness.tasks = [task()]
  harness.preview = previewOk as unknown as Record<string, unknown>
  harness.applied = []
}

/** 假的任务台账（默认：停了 + 两个检查点） */
export function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task_1',
    title: '改点东西',
    status: 'completed',
    sessionId: CONV,
    checkpoints: [
      { at: 1000, label: '第 1 轮改动完成', note: '' },
      { at: 2000, label: '第 2 轮结束', note: '' },
    ],
    ...patch,
  } as TaskRecord
}

/** 干跑预览的典型回执：一个恢复、一个删除、一个撤不动 */
export const previewOk: RollbackResult = {
  ok: true,
  dryRun: true,
  restored: ['E:/demo/keep.txt'],
  removed: ['E:/demo/new.txt'],
  failed: [],
  skipped: [{ path: 'E:/demo/old.txt', reason: '这个文件的改动在检查点之前' }],
  changesets: ['cs_1'],
  checkpoint: { at: 1000, label: '第 1 轮改动完成', index: 0 },
}

/* ── 假的桥（工厂函数，`vi.mock` 在测试文件里调它们）────────── */

export function safetyApiMock(): Record<string, unknown> {
  return {
    taskList: async () => harness.tasks,
    /* refresh 一次拉四样，缺一个就是未处理的 Promise 拒绝（会污染整个文件的结果） */
    taskRecovery: async () => [],
    changesetList: async () => [],
    changesetDiff: async () => null,
  }
}

export function rollbackApiMock(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actual,
    rollbackBridgeReady: () => true,
    rollbackPreview: async () => harness.preview as unknown as RollbackResult,
    rollbackApply: async (taskId: string, checkpointId: number | string) => {
      harness.applied.push({ taskId, checkpointId })
      return harness.preview as unknown as RollbackResult
    },
  }
}

/* ── DOM 助手 ─────────────────────────────────────────────── */

/**
 * 等异步链路跑完（取任务 → 干跑 → 真撤全是 async）。
 * 只 await 几个微任务在单独跑时够用，**整套跑**（机器忙）就会漏 ——
 * 所以这里让出一个宏任务（React 的调度也走任务队列）。
 */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** 反复让一步直到条件成立（等状态，不等时间 —— 固定 tick 会飘） */
export async function until(cond: () => boolean, turns = 20): Promise<void> {
  for (let i = 0; i < turns && !cond(); i += 1) await flush()
}

export const menuItems = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
]

export const buttonByText = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text))

/**
 * 点开菜单 → 选第 index 个检查点 → 等预览算完。
 *
 * ★ 两个关键点（都踩过）：
 *   ① **点开与点选放同一个 act 里、中间不 await** —— 菜单只存在于它展开的那几帧，
 *      Popover 里 floating-ui 的 `hide()` 中间件会在之后的帧里因为「锚点被当裁掉」
 *      自己收起；中间让出一个宏任务，就变成「点了个已经不存在的元素」。
 *   ② 判「已就位」要包含**错误 toast**：预览算不出来那条路径本来就不弹确认框，
 *      只报错 —— 不带它就会把正确行为当成「点没中」而重试到超时。
 */
export async function pickCheckpoint(index: number): Promise<void> {
  const settled = () =>
    useUIStore.getState().permission !== null ||
    harness.applied.length > 0 ||
    useUIStore.getState().toasts.length > 0

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let clicked = false
    /* act 的**同步**形式：点开的那一下 React 就把菜单渲染出来了，别让出任务 */
    act(() => {
      buttonByText('撤销检查点之后的改动')?.click()
      const item = menuItems()[index]
      if (item) {
        item.click()
        clicked = true
      }
    })
    if (!clicked) continue
    await until(settled, 10)
    if (settled()) return
  }
  throw new Error(`点了 5 次都没能选中第 ${index} 个检查点`)
}
