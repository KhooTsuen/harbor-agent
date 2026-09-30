/* ══════════════════════════════════════════════════════════════
   浏览器工具（右栏「浏览器」标签）的桥

   单独一个文件而不是塞进 backend.ts：那边已经贴着 300 行，
   而「谁的桥接口住在哪个文件」本来就是这个项目的既有做法
   （见 notify.ts / image.ts 开头那段说明）。
   ══════════════════════════════════════════════════════════════ */

/** 主进程把一次浏览器动作交给渲染层去执行（真正点页面的是渲染层的 webview） */
export interface BrowserRequestEvent {
  id: string
  action: 'navigate' | 'snapshot' | 'click' | 'type'
  url?: string
  /** click/type: index 目标元素；type: text 内容、pressEnter 回车、authorized 已授权填密码 */
  index?: number
  text?: string
  pressEnter?: boolean
  authorized?: boolean
}

export interface BrowserBridge {
  onBrowserRequest: (callback: (request: BrowserRequestEvent) => void) => () => void
  browserResult: (
    id: string,
    result: {
      ok: boolean
      text?: string
      html?: string
      title?: string
      url?: string
      snapshot?: unknown
      click?: string
      type?: string
      into?: string
      password?: boolean
      needsConfirm?: boolean
      error?: string
    },
  ) => Promise<{ ok: boolean; error?: string }>
}
