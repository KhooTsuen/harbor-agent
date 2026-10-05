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

   另外两条也是真机上逮到的：
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
 * 等「后退 / 前进**真的动了**没有」。
 *
 * ★ 为什么不先问 `canGoBack()`（2026-10-06 真机 bug ①）：
 *   页面自报 hl=2（确实有上一页，页面里 `history.back()` 一次就退回列表、
 *   连筛选词都恢复了），而 webview 的 `canGoBack()` 返回 **false** ——
 *   于是 `browse_nav` 回了一句「到头了：没有上一页可以后退」。
 *   而它根本没到头（bug ②：那句话把「有上一页」也误判成到头）。
 *   同一份判据还牵着界面上那两个按钮的灰显，所以这一条不能拿来当结论。
 *
 * 现在的口径：**动手之后核实** ——
 *   · 先记下地址，由调用方去调 goBack / goForward
 *   · 等 `did-navigate` / `did-navigate-in-page` / `did-finish-load`，
 *     或者轮询地址真的变了（有些站点的页内导航不发事件）
 *   · 过了这段时间还没动静 → 返回 false，由调用方决定要不要兜底 / 报「到头了」
 *
 * 这样「到头了」才是一句**验证过的**结论，而不是一次猜测。
 *
 * @param before 动手之前的地址（拿它比出“变没变”）
 * @returns 真的换了页面 / 地址就 true
 */
export function waitForNavMove(
  view: WebviewElement,
  before: string,
  budget: Budget,
  cap = 2500,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    const names = ['did-navigate', 'did-navigate-in-page', 'did-finish-load']

    const done = (moved: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (poll) clearInterval(poll)
      for (const name of names) view.removeEventListener(name, onEvent)
      resolve(moved)
    }

    const onEvent = (): void => done(true)
    for (const name of names) view.addEventListener(name, onEvent)

    const current = (): string => {
      try {
        return view.getURL?.() ?? ''
      } catch {
        return ''
      }
    }
    poll = setInterval(() => {
      const now = current()
      if (now && now !== before) done(true)
    }, 100)

    timer = setTimeout(() => done(false), budget.slice(cap))
  })
}

/** 在 webview 里跑一段脚本的结果 */ export type ScriptOutcome<T> =
  { ok: true; value: T | undefined } | { ok: false; error: string }

/**
 * 在 webview 里跑一段脚本 —— **失败会重试**。
 *
 * 真机上见过 `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL':
 * Error: Script failed to execute`：多半是 guest 刚被摘挂/还没附加好。
 * 这类失败等一下再试通常就成了，不该直接把「读不了」甩给模型。
 */
export async function runScript<T>(
  view: WebviewElement,
  code: string,
  budget: Budget,
  tries = 3,
): Promise<ScriptOutcome<T>> {
  let last = ''
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    if (budget.expired) break
    try {
      if (!view.executeJavaScript) return { ok: false, error: '这个环境不支持在网页里执行脚本' }
      const value = (await view.executeJavaScript(code)) as T | undefined
      return { ok: true, value }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
      /* 还没就绪：等一下 + 再等一次 dom-ready，然后再试 */
      await waitForDomReady(view, budget)
      await sleep(250)
    }
  }
  return { ok: false, error: last || '在网页里执行脚本失败' }
}

/** 读出来的一页正文 */
export interface PageText {
  text: string
  html: string
  title: string
  url: string
}

/**
 * 读当前页面的正文：**空不算结果**。
 *
 * 有些站点（SPA）`did-finish-load` 之后才开始填内容，第一次读是空 ——
 * 直接把它当「这个页面没有可读的正文」报回去，模型就只能自己想办法了。
 * 所以空的话再等一小会儿看几次。
 */
export async function readPage(
  view: WebviewElement,
  readScript: string,
  budget: Budget,
  tries = 3,
): Promise<ScriptOutcome<Record<string, unknown>>> {
  let last: ScriptOutcome<Record<string, unknown>> = { ok: true, value: undefined }
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    last = await runScript<Record<string, unknown>>(view, readScript, budget, 2)
    if (!last.ok) return last
    const text = String(last.value?.text ?? '')
    const html = String(last.value?.html ?? '')
    /* 有正文就交付；只剩没几次机会了也别再等（宁可早点回话） */
    if (text.length > 0 || html.length > 0 || attempt === tries || budget.left() < 1500) break
    await sleep(900)
  }
  return last
}
