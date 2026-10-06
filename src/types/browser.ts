/* ══════════════════════════════════════════════════════════════
   浏览器工具（右栏「浏览器」标签）的桥

   单独一个文件而不是塞进 backend.ts：那边已经贴着 300 行，
   而「谁的桥接口住在哪个文件」本来就是这个项目的既有做法
   （见 notify.ts / image.ts 开头那段说明）。
   ══════════════════════════════════════════════════════════════ */

/** 主进程把一次浏览器动作交给渲染层去执行（真正点页面的是渲染层的 webview） */
export interface BrowserRequestEvent {
  id: string
  action: 'navigate' | 'snapshot' | 'click' | 'type' | 'nav'
  url?: string
  /** click/type: index 目标元素；type: text 内容、pressEnter 回车、authorized 已授权填密码 */
  index?: number
  /** nav: 往哪个方向走（back 上一页 / forward 下一页） */
  direction?: 'back' | 'forward'
  /** navigate: true = 在当前那个属于 Agent 的标签里打开、不开新标签（工具侧 `browse(url, sameTab: true)`） */
  sameTab?: boolean
  text?: string
  pressEnter?: boolean
  authorized?: boolean
}

export interface BrowserBridge {
  onBrowserRequest: (callback: (request: BrowserRequestEvent) => void) => () => void
  /** 网页里 window.open / target=_blank 的地址（主进程拦下真窗口后转过来的） */
  onBrowserOpenTab?: (callback: (url: string) => void) => () => void
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
      /** nav 成功时回一句「往哪个方向走的」（主进程据此写人话） */
      nav?: string
      error?: string
    },
  ) => Promise<{ ok: boolean; error?: string }>
}
