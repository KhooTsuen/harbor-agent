/* ══════════════════════════════════════════════════════════════
   浏览器工具（右栏「浏览器」标签）的桥

   单独一个文件而不是塞进 backend.ts：那边已经贴着 300 行，
   而「谁的桥接口住在哪个文件」本来就是这个项目的既有做法
   （见 notify.ts / image.ts 开头那段说明）。
   ══════════════════════════════════════════════════════════════ */

/** 主进程把一次浏览器动作交给渲染层去执行（真正点页面的是渲染层的 webview） */
export interface BrowserRequestEvent {
  id: string
  action: 'navigate' | 'snapshot' | 'click' | 'type' | 'nav' | 'wcid'
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
  /** click: true = 落点被遮挡也强制点（跳过命中核对，工具侧 `browse_click(index, force: true)`） */
  force?: boolean
}

export interface BrowserBridge {
  onBrowserRequest: (callback: (request: BrowserRequestEvent) => void) => () => void
  /** 网页里 window.open / target=_blank 的地址（主进程拦下真窗口后转过来的） */
  onBrowserOpenTab?: (callback: (url: string) => void) => () => void
  /**
   * 把「当前标签的 webContents id」（B5）推给主进程 —— 主进程据此经 CDP 直连，
   * 不必每次都问渲染层。两种用途：① 纯缓存更新（带 sessionId + webContentsId）；
   * ② 回 navigate 的话（再带 `requestId` + `ready`）。
   */
  browserActive: (payload: {
    sessionId?: string
    webContentsId?: number
    /** 回哪一条 navigate 请求（纯缓存更新时不带） */
    requestId?: string
    /** 页面已就绪（回 navigate 时带） */
    ready?: boolean
    ok?: boolean
    error?: string
  }) => Promise<{ ok: boolean; error?: string }>
}
