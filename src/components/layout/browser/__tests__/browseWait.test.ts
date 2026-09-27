import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSE_BUDGET_MS,
  Budget,
  readPage,
  runScript,
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
   ══════════════════════════════════════════════════════════════ */

/** 假 webview：只实现我们用到的几个方法（真元素是 Electron 的私有自定义元素） */
function fakeView(scripts: Array<string | Error>): WebviewElement & { calls: number } {
  const el = document.createElement('div') as unknown as WebviewElement & { calls: number }
  el.calls = 0
  let domReady = false
  el.getURL = () => (domReady ? 'https://example.com/' : '')
  el.executeJavaScript = async () => {
    el.calls += 1
    const next = scripts.shift() ?? ''
    if (next instanceof Error) throw next
    domReady = true
    return JSON.parse(next) as unknown
  }
  Object.defineProperty(el, 'addEventListener', {
    value: (type: string, cb: () => void) => {
      /* 只模拟 dom-ready：立刻触发，等于「已经就绪」 */
      if (type === 'dom-ready') setTimeout(cb, 0)
    },
  })
  Object.defineProperty(el, 'removeEventListener', { value: () => {} })
  return el
}

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

describe('browseWait / 在网页里执行脚本', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('★ guest 没就绪（抛错）时会重试，最终成功', async () => {
    const view = fakeView([
      new Error(
        "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: Script failed to execute",
      ),
      '{"text":"正文来了"}',
    ])
    const budget = new Budget(60_000)
    const promise = runScript<{ text: string }>(view, 'read', budget)
    await vi.advanceTimersByTimeAsync(1_000)
    const out = await promise
    expect(out.ok).toBe(true)
    expect(out.ok && out.value?.text).toBe('正文来了')
    expect(view.calls).toBe(2)
  })

  it('一直失败就把原因带回去（不许编一个「没有正文」）', async () => {
    /* 同一个错误给两次：第二次重试也要拿到它，而不是夹具自己造的解析错 */
    const boom = new Error('Script failed to execute')
    const view = fakeView([boom, boom])
    const budget = new Budget(60_000)
    const promise = runScript(view, 'read', budget, 2)
    await vi.advanceTimersByTimeAsync(2_000)
    const out = await promise
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toContain('Script failed to execute')
  })

  it('① 第一次读是空（SPA 还没填内容）→ 会再读一次', async () => {
    const view = fakeView(['{"text":""}', '{"text":"填好了"}'])
    const budget = new Budget(60_000)
    const promise = readPage(view, 'read', budget)
    await vi.advanceTimersByTimeAsync(2_000)
    const out = await promise
    expect(out.ok).toBe(true)
    expect(view.calls).toBe(2)
    expect(out.ok && String(out.value?.text)).toBe('填好了')
  })

  it('预算快用完时不再空等（宁可早点回话）', async () => {
    const view = fakeView(['{"text":""}'])
    const budget = new Budget(1_000)
    vi.advanceTimersByTime(900)
    const out = await readPage(view, 'read', budget)
    expect(out.ok).toBe(true)
    expect(view.calls).toBe(1)
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
