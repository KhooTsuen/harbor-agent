import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSE_BUDGET_MS,
  Budget,
  waitForDomReady,
  waitForElement,
  waitForLoad,
  type WebviewElement,
} from '@/components/layout/browser/browseWait'

/* ══════════════════════════════════════════════════════════════
   等 webview 就绪的那几段等待

   两件事要锁住（都来自 2026-09-28 的真机日志）：
     ① 总预算必须**小于**主进程的等待 —— 这里是单元测试那条最简版的钉子，
        真正的跨文件不等式在自检组 09 里（它把两个数字都读出来比）。
     ② webview 的 guest 没就绪时 `executeJavaScript` 会抛
        （`GUEST_VIEW_MANAGER_CALL: Script failed to execute`）——
        要等一下重试，不能直接把「读不了」甩给模型。
        ★ 这条重试在 B2–B4 后搬到了**主进程**（`core/browse-ops.cjs` 的
        `evaluateWithRetry`），渲染层不再往页面里跑脚本，所以这里的
        `runScript` 用例已随函数一起删掉。
   ══════════════════════════════════════════════════════════════ */

describe('browseWait / 预算', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('★ 渲染层预算明显小于主进程那 45 秒', () => {
    /* 主进程 electron/handlers/browser.cjs 的 REQUEST_TIMEOUT_MS = 45_000 */
    expect(BROWSE_BUDGET_MS).toBeLessThan(45_000)
    /* 也别小到「正常页面都读不完」 */
    expect(BROWSE_BUDGET_MS).toBeGreaterThan(15_000)
  })

  it('每一步只能从总预算里切（不会各等各的）', () => {
    const budget = new Budget(10_000)
    expect(budget.slice(15_000)).toBe(10_000)
    vi.advanceTimersByTime(6_000)
    expect(budget.slice(15_000)).toBe(4_000)
    vi.advanceTimersByTime(5_000)
    expect(budget.slice(15_000)).toBe(0)
    expect(budget.expired).toBe(true)
  })

  it('等不到元素就返回 null（调用方据此回一句人话）', async () => {
    const budget = new Budget(1_000)
    const promise = waitForElement(() => null, budget, 500)
    await vi.advanceTimersByTimeAsync(1_200)
    expect(await promise).toBeNull()
  })

  it('元素出现就立刻返回', async () => {
    const budget = new Budget(5_000)
    const el = document.createElement('div')
    expect(await waitForElement(() => el, budget, 500)).toBe(el)
  })
})

describe('browseWait / 等加载', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('did-finish-load 一到就继续', async () => {
    const el = document.createElement('div') as unknown as WebviewElement
    Object.defineProperty(el, 'getURL', { value: () => 'https://example.com/' })
    Object.defineProperty(el, 'addEventListener', {
      value: (type: string, cb: () => void) => {
        if (type === 'did-finish-load') setTimeout(cb, 10)
      },
    })
    Object.defineProperty(el, 'removeEventListener', { value: () => {} })
    const budget = new Budget(5_000)
    const promise = waitForLoad(el, budget)
    await vi.advanceTimersByTimeAsync(50)
    await expect(promise).resolves.toBeUndefined()
  })

  it('已经在 DOM 上的 webview 不等 dom-ready 事件（复用老标签）', async () => {
    const el = document.createElement('div') as unknown as WebviewElement
    Object.defineProperty(el, 'getURL', { value: () => 'https://example.com/' })
    const budget = new Budget(5_000)
    await expect(waitForDomReady(el, budget)).resolves.toBeUndefined()
  })
})
