import { useEffect, useRef } from 'react'
import { useBrowserStore } from '@/stores/useBrowserStore'

/* ══════════════════════════════════════════════════════════════
   执行 Agent 的浏览请求（真正操作 webview 的那一半）

   `useBrowseBridge`（挂在 RightPanel）负责接请求、开标签，
   这里负责等 webview 挂上 → 导航 → 读正文 → 回话。

   分两半是因为：接请求的地方必须**一直挂着**（不然没人接），
   而操作 webview 必须等 BrowserTab 挂载（切过去才有元素）。
   ══════════════════════════════════════════════════════════════ */

interface WebviewElement extends HTMLElement {
  getURL?: () => string
  executeJavaScript?: (code: string) => Promise<unknown>
  loadURL?: (url: string) => Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 等元素真的出现（切标签后 React 渲染有一帧延迟） */
async function waitForElement<T>(get: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = get()
    if (value) return value
    await sleep(80)
  }
  return null
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
function waitForDomReady(view: WebviewElement, timeoutMs: number): Promise<void> {
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
    const timer = setTimeout(done, timeoutMs)
    view.addEventListener('dom-ready', done)
  })
}

function waitForLoad(view: WebviewElement, timeoutMs: number): Promise<void> {
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
    const timer = setTimeout(done, timeoutMs)
    view.addEventListener('did-finish-load', done)
    view.addEventListener('did-fail-load', done)
  })
}

/**
 * 读正文的脚本。
 *
 * 优先 `innerText` —— 那是**渲染后的可见文本**，JS 生成的内容也在里面，
 * 这才是「用浏览器读页面」的意义。HTML 只在拿不到时兜底。
 */
const READ_SCRIPT = `
  (function () {
    try {
      var body = document.body ? document.body.innerText : ''
      return {
        text: body || '',
        html: document.documentElement ? document.documentElement.outerHTML : '',
        title: document.title || '',
        url: location.href || ''
      }
    } catch (e) {
      return { text: '', html: '', title: '', url: '', error: String(e) }
    }
  })()
`

/**
 * 消费 store 里的 pending 请求。
 *
 * @param webviewRef 指向 BrowserTab 里那个 webview 元素
 */
export function useBrowseDriver(webviewRef: React.RefObject<WebviewElement | null>): void {
  const pending = useBrowserStore((s) => s.pending)
  const clearPending = useBrowserStore((s) => s.clearPending)
  /* 正在处理的那一个，避免重复执行 */
  const busyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!pending) return
    if (busyRef.current === pending.id) return
    busyRef.current = pending.id

    let alive = true

    async function run(): Promise<void> {
      const reply = (result: {
        ok: boolean
        text?: string
        html?: string
        title?: string
        url?: string
        error?: string
      }): void => {
        void window.workbench?.browserResult?.(pending!.id, result)
      }

      /* 等 webview 挂上（切到浏览器标签后才会有） */
      const view = await waitForElement(() => webviewRef.current, 12_000)
      if (!alive) return
      if (!view) {
        reply({ ok: false, error: '浏览器标签没能打开，读不了网页' })
        clearPending()
        return
      }

      try {
        /* ① 先等它可用 —— 不等的话调任何方法都会报「must be attached to the DOM」 */
        await waitForDomReady(view, 15_000)
        if (!alive) return

        /*
         * ② 导航。
         * 新标签的 `src` 已经是目标地址了，webview 自己会去 —— 这种情况不用再 loadURL
         * （多调一次会白闪一下）。只有复用旧标签、地址不一致时才手动导。
         */
        const current = view.getURL?.() ?? ''
        if (current && current !== pending!.url) {
          const loading = view.loadURL?.(pending!.url)
          if (loading && typeof loading.then === 'function') await loading.catch(() => undefined)
          await waitForLoad(view, 20_000)
          /* 再等一会儿给 SPA —— 很多站点加载完才开始填内容 */
          await sleep(1200)
        }

        const raw = (await view.executeJavaScript?.(READ_SCRIPT)) as
          { text?: string; html?: string; title?: string; url?: string } | undefined

        if (!alive) return
        reply({
          ok: true,
          text: String(raw?.text ?? ''),
          /* 有 text 就不用发 html —— innerText 已经是干净的可见文本了 */
          html: raw?.text ? '' : String(raw?.html ?? ''),
          title: String(raw?.title ?? ''),
          url: String(raw?.url ?? pending!.url),
        })
      } catch (error) {
        if (!alive) return
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        clearPending()
      }
    }

    void run()

    return () => {
      alive = false
    }
  }, [pending, webviewRef, clearPending])
}
