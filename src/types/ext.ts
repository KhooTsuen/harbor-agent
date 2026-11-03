/* ══════════════════════════════════════════════════════════════
   浏览器扩展桥（Phase 2）

   单独一个文件而不是塞进 backend.ts：那边已经贴着 300 行，
   而「谁的桥接口住在哪个文件」本来就是这个项目的既有做法
   （见 browser.ts / notify.ts / image.ts 开头那段说明）。
   ══════════════════════════════════════════════════════════════ */

/**
 * 主进程推来的「扩展刚读了一个页面」事件（通道 `ext:page`）。
 *
 * 形状与 `core/ext-bridge.cjs` 的 ingest 里那次 `send('ext:page', …)` **同源** ——
 * 别在渲染层再翻译一层（硬约束 #9）。
 */
export interface ExtPageEvent {
  sessionId: string
  url: string
  title: string
  chars: number
  /** true = 没有「当前会话」可落，主进程新建了一条兜底会话 */
  created: boolean
  truncated: boolean
}

export interface ExtBridge {
  /**
   * 把「界面当前打开的会话」报给主进程。
   *
   * 为什么要报：Edge 扩展读到的页面内容由**扩展进程**经命名管道送进主进程
   * （见 electron/core/ext-bridge.cjs），主进程要决定它落进哪条会话 ——
   * 而「现在打开的是哪条」只有渲染层知道。
   *
   * 尽力而为：没报过 / 报的那条已被删时，主进程会**新建一条专用会话**兜底，
   * 页面内容不会丢。
   */
  extActiveSession: (id: string) => Promise<{ ok: boolean }>

  /**
   * 订阅「扩展读了一个页面」事件。
   *
   * 为什么需要它：页面内容是**扩展进程 → 命名管道 → 主进程**直接写进会话文件的，
   * 渲染层完全不知情。没有这条订阅，用户点完「读当前页」界面上**什么都不会变**，
   * 得手动切一下会话才看得见（那正是 Phase 2 验收时发现的缺口）。
   */
  onExtPage?: (callback: (event: ExtPageEvent) => void) => () => void

  /**
   * 「安装浏览器插件」的当前状态（只读）。
   *
   * 形状与 `core/edge-install.cjs` 的 `status()` **同源** —— 那边是唯一真相源，
   * 这里只是把字段声明一遍（别在渲染层再翻译一层，硬约束 #9）。
   *
   * ⚠️ `connected` 才是「装好了」的判据：文件都在、注册表也对，但 Edge 里还没
   * 加载扩展时它是 false。界面上不能拿 `hostOk && registered` 当已安装。
   */
  extStatus?: () => Promise<EdgeInstallStatus>

  /** 真装（拷产物 + 写宿主清单 + 写注册表，幂等）。路径不收 —— 全在主进程算 */
  extInstall?: () => Promise<EdgeInstallStatus & { ok: boolean; error?: string; opened?: boolean }>
}

/** 「安装浏览器插件」的状态。字段与 `electron/core/edge-install.cjs` 的 status() 一一对应 */
export interface EdgeInstallStatus {
  /** 由 manifest 的 `key` 算出的固定 32 位 ID（空串 = 算不出来） */
  extensionId: string
  /** 扩展产物已装到 data 下（Edge 要「加载解压缩的扩展」时选的就是 `targetDir`） */
  staged: boolean
  /** 该让用户去选的目录 */
  targetDir: string
  /** 宿主清单落到哪（排查时给人看） */
  hostManifest: string
  /** 包装器落到哪 */
  wrapper: string
  /** allowed_origins 已经是我们算出来的 ID */
  hostOk: boolean
  /** 注册表指对了 */
  registered: boolean
  /** 扩展真的连上来了 —— 唯一能说「装好了」的判据 */
  connected: boolean
  /** 产物源头在不在（打包漏了就是 false） */
  sourceOk: boolean
  sourceDir: string
}
