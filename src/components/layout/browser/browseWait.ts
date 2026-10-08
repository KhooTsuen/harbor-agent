/* ══════════════════════════════════════════════════════════════
   等 webview 就绪的那几段等待（共享一条**总预算**）

   为什么要有总预算（2026-09-28 真机日志，不是理论）：
   主进程 `handlers/browser.cjs` 等渲染层回话的上限是 45 秒，而这里原来是
   三段**各自独立**的等待：等元素 12s + 等 dom-ready 15s + 等加载 20s
   （再加给 SPA 的 1.2s）—— 相加 ≈ 48 秒 > 45 秒。
   于是只要页面慢一点：主进程一定先超时，报的还是
   「界面没有在 45 秒内回应（浏览器标签可能被关了）」——
   而真相是界面**正在**处理，只是还没读完（用户点一下各段等待立刻满足，
   于是「我点一下它就能读了」）。

   规矩：所有等待共享一条预算，且渲染层**必须**在预算内回话 ——
   宁可自己说清「等太久了」，也不要让主进程用一句猜出来的原因替它发言。

   另外两条也是真机上逮到的（B2–B4 后，这两条已随脚本一起搬到**主进程**
   —— 见 `electron/core/browse-read.cjs` 的空正文重试、`browse-ops.cjs` 的
   `evaluateWithRetry`；渲染层这边不再往页面里跑脚本）：
   · `GUEST_VIEW_MANAGER_CALL: Script failed to execute` —— webview 的 guest
     还没就绪（或被摘挂过）时 `executeJavaScript` 会抛；要等 dom-ready 重试。
   · 有些 SPA 加载完才开始填内容，第一次读是空。空不等于「没有正文」，
     要再等一小会儿重试几次。
   ══════════════════════════════════════════════════════════════ */

/** webview 里能用到的那些方法（`<webview>` 是 Electron 私有的自定义元素） */
export interface WebviewElement extends HTMLElement {
  getURL?: () => string
  executeJavaScript?: (code: string) => Promise<unknown>
  loadURL?: (url: string) => Promise<void>
  /** 这个 webview 在**主进程**侧的 webContents id（browse_ax 读无障碍树要用） */
  getWebContentsId?: () => number
}

/**
 * 渲染层的总预算。
 *
 * ★ **必须显著小于**主进程那 45 秒（`handlers/browser.cjs` 的 REQUEST_TIMEOUT_MS）——
 *   自检组 09 会把两个数字都读出来，钉住这条不等式。
 */
export const BROWSE_BUDGET_MS = 30_000

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 一条从开始到结束的时间预算；每一步的等待都从它里面切 */
export class Budget {
  private readonly until: number

  constructor(totalMs: number = BROWSE_BUDGET_MS) {
    this.until = Date.now() + totalMs
  }

  /** 还剩多少毫秒（不会为负） */
  left(): number {
    return Math.max(0, this.until - Date.now())
  }

  /** 这一步最多能等多久（同时受总预算约束） */
  slice(cap: number): number {
    return Math.max(0, Math.min(cap, this.left()))
  }

  get expired(): boolean {
    return this.left() <= 0
  }
}

/** 等元素真的出现（切标签后 React 渲染有一帧延迟） */
export async function waitForElement<T>(
  get: () => T | null,
  budget: Budget,
  cap = 12_000,
): Promise<T | null> {
  const deadline = Date.now() + budget.slice(cap)
  while (Date.now() < deadline) {
    const value = get()
    if (value) return value
    await sleep(80)
  }
  return get() ?? null
}

/**
 * 等 webview 可用。
 *
 * ⚠️ 踩过：webview 刚插进 DOM 时**还不能调方法**，会报
 * 「The WebView must be attached to the DOM and the dom-ready event
 *  emitted before this method can be called」。所以必须先等 `dom-ready`。
 *
 * 已经在 DOM 上的（复用老标签）直接返回，不用白等。
 */
export function waitForDomReady(view: WebviewElement, budget: Budget): Promise<void> {
  try {
    if (view.getURL?.()) return Promise.resolve()
  } catch {
    /* 还没挂上，走下面的等待 */
  }

  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      view.removeEventListener('dom-ready', done)
      resolve()
    }
    const timer = setTimeout(done, budget.slice(15_000))
    view.addEventListener('dom-ready', done)
  })
}

/** 等这次导航结束（`did-fail-load` 也算结束 —— 失败要早点说，别等到超时） */
export function waitForLoad(view: WebviewElement, budget: Budget): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      view.removeEventListener('did-finish-load', done)
      view.removeEventListener('did-fail-load', done)
      resolve()
    }
    const timer = setTimeout(done, budget.slice(20_000))
    view.addEventListener('did-finish-load', done)
    view.addEventListener('did-fail-load', done)
  })
}

/**
 * ★ 原来这里还有一个 `waitForNavMove`（等「后退/前进真的动了没有」）——
 *   B4 之后，换历史改由**主进程**经 CDP 做（`electron/core/browse-history.cjs`
 *   里的轮询版 `waitForMove`），渲染层不再监听导航事件，这个函数已删。
 */
