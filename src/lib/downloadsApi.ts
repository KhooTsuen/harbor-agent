/* ══════════════════════════════════════════════════════════════
   下载管理器 API（界面 ↔ 内核）

   内核侧（`electron/core/download-*.cjs` + `handlers/downloads.cjs`）已经把
   「谁在跑、谁在排队、限速多少」定死了，前端只做**搬运 + 显示**：

     · 进度是**推**过来的（`downloads:event`），不是轮询拉 —— 大文件轮询会把
       IPC 打爆。「进度」事件带 `received / total / speedBps`，界面就地更新；
       状态跃迁（started / done / failed / paused / removed）再拉一次整表。
     · 限速 / 并发上限的**默认值与区间**由内核 `download-store.cjs` 说了算，
       前端不自己编（编出来会和实际行为对不上）。

   为什么桥类型写在这儿：`types/backend.ts` 已经超过 200 行（硬约束 #2），
   不往里塞 `downloads*` 这几个方法。做法与 `schedulesApi.ts` 一致 ——
   本地声明桥类型 + 一次 `as unknown as`（不用 any / @ts-ignore），
   桥不在时**优雅降级**（返回 null / ok:false，让面板说一句人话，不崩不白屏）。
   ══════════════════════════════════════════════════════════════ */

/** 一条下载任务（内核 `download-store.cjs` 的形状） */
export type DownloadItem = {
  id: string
  url: string
  /** 最终产物的绝对路径 */
  file: string
  name: string
  /** 总字节；0 = 服务器没给 content-length */
  total: number
  received: number
  /** queued / running / paused / done / failed */
  status: string
  error: string
  createdAt: number
  updatedAt: number
  finishedAt: number
  /** 开了几条连接（0 = 还没跑过） */
  connections: number
  /** 试过几次（含断点续传的次数） */
  attempts: number
  speedBps: number
}

/** 队列的并发 / 限速配置（内核是真相源） */
export type DownloadLimits = {
  /** 同时下几个（1–8） */
  maxConcurrent: number
  /** 全局限速 KB/s；0 = 不限 */
  maxKBps: number
  /** 单个文件几条连接（1–16） */
  connections: number
}

/** 列表快照：条目 + 内存里的运行态 + 当前限速配置 */
export type DownloadListSnapshot = {
  items: DownloadItem[]
  /** 正在跑的 id（只在内存里，进程一停就空） */
  running: string[]
  limits: DownloadLimits
}

/** 主进程推来的事件（`downloads:event`） */
export type DownloadEvent = {
  type:
    | 'added'
    | 'started'
    | 'progress'
    | 'queued'
    | 'paused'
    | 'done'
    | 'failed'
    | 'removed'
    | 'cleared'
    | 'limits'
  id?: string
  name?: string
  received?: number
  total?: number
  speedBps?: number
  bytes?: number
  resumed?: boolean
  error?: string
  limits?: DownloadLimits
  removed?: number
}

export type DownloadWriteResult = { ok: boolean; item?: DownloadItem; error?: string }

/** 内核侧待暴露的那几个方法（`electron/preload.cjs` 里已经挂上了） */
export type DownloadsBridge = {
  downloadsList?: () => Promise<{
    ok: boolean
    items?: DownloadItem[]
    running?: string[]
    limits?: DownloadLimits
    error?: string
  }>
  downloadsAdd?: (payload: { url: string; path: string }) => Promise<DownloadWriteResult>
  downloadsPause?: (id: string) => Promise<{ ok: boolean; error?: string }>
  downloadsResume?: (id: string) => Promise<{ ok: boolean; error?: string }>
  downloadsRetry?: (id: string) => Promise<{ ok: boolean; error?: string }>
  downloadsRemove?: (id: string) => Promise<{ ok: boolean; error?: string }>
  downloadsClear?: () => Promise<{ ok: boolean; removed?: number; error?: string }>
  downloadsSetLimits?: (patch: Partial<DownloadLimits>) => Promise<{
    ok: boolean
    limits?: DownloadLimits
    error?: string
  }>
  onDownloadsEvent?: (callback: (payload: DownloadEvent) => void) => () => void
}

export const FALLBACK_LIMITS: DownloadLimits = { maxConcurrent: 2, maxKBps: 0, connections: 4 }

export const downloadsBridge: DownloadsBridge | undefined =
  typeof window !== 'undefined'
    ? (window.workbench as unknown as DownloadsBridge | undefined)
    : undefined

/** 桥接好了吗（浏览器预览没有内核，面板据此显示一句人话） */
export function downloadsBridgeReady(): boolean {
  return typeof downloadsBridge?.downloadsList === 'function'
}

const NO_BRIDGE = '当前环境不支持下载管理，请在桌面版里使用（浏览器预览没有内核）'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function downloadsList(): Promise<DownloadListSnapshot | null> {
  if (typeof downloadsBridge?.downloadsList !== 'function') return null
  try {
    const result = await downloadsBridge.downloadsList()
    if (!result?.ok) return null
    return {
      items: result.items ?? [],
      running: result.running ?? [],
      limits: result.limits ?? FALLBACK_LIMITS,
    }
  } catch {
    return null
  }
}

export async function downloadsAdd(url: string, path: string): Promise<DownloadWriteResult> {
  if (typeof downloadsBridge?.downloadsAdd !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    return await downloadsBridge.downloadsAdd({ url, path })
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/** 暂停 / 继续 / 重试 / 删除：同一个形状，按 action 分发 */
export async function downloadsAction(
  id: string,
  action: 'pause' | 'resume' | 'retry' | 'remove',
): Promise<{ ok: boolean; error?: string }> {
  const fn =
    downloadsBridge?.[
      {
        pause: 'downloadsPause',
        resume: 'downloadsResume',
        retry: 'downloadsRetry',
        remove: 'downloadsRemove',
      }[action] as 'downloadsPause'
    ]
  if (typeof fn !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    return await fn(id)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function downloadsClear(): Promise<{ ok: boolean; removed?: number; error?: string }> {
  if (typeof downloadsBridge?.downloadsClear !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    return await downloadsBridge.downloadsClear()
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function downloadsSetLimits(
  patch: Partial<DownloadLimits>,
): Promise<{ ok: boolean; limits?: DownloadLimits; error?: string }> {
  if (typeof downloadsBridge?.downloadsSetLimits !== 'function')
    return { ok: false, error: NO_BRIDGE }
  try {
    return await downloadsBridge.downloadsSetLimits(patch)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/* ── 保存位置：文件夹 + 文件名（像浏览器那样） ─────────────── */

/**
 * 从地址里猜文件名 —— 像浏览器那样，但**还没发包**，所以只能从路径末段猜，
 * 拿不到服务器给的 `Content-Disposition`。查询串 / 片段剥掉，百分号解开。
 * 猜不出（`.../download?id=1`）返回空串 —— 界面据此留空让用户自己填，不编假名字。
 */
export function fileNameFromUrl(raw: string): string {
  let pathname = ''
  try {
    pathname = new URL(String(raw ?? '').trim()).pathname
  } catch {
    return ''
  }
  const last = pathname.split('/').filter(Boolean).pop() ?? ''
  if (!last) return ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/**
 * 把「保存文件夹 + 文件名」拼成一条路径交给内核。
 * 文件夹留空 → 只给文件名，由内核按工作目录展开（与 download 工具同一条约定）。
 */
export function joinTarget(dir: string, name: string): string {
  const base = String(name ?? '').trim()
  if (!base) return ''
  const folder = String(dir ?? '')
    .trim()
    .replace(/[\\/]+$/, '')
  return folder ? `${folder}\\${base}` : base
}

/* ── 展示用小工具（界面多处要用，收在一处） ─────────────────── */

export function humanBytes(bytes: number): string {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function humanSpeed(bps: number): string {
  const n = Number(bps) || 0
  if (n <= 0) return ''
  return `${humanBytes(n)}/s`
}

/** 百分数（total 未知时返回 null —— 界面显示「已收 X」而不是假装知道百分比） */
export function percentOf(item: { received: number; total: number }): number | null {
  const total = Number(item.total) || 0
  if (total <= 0) return null
  return Math.min(100, Math.floor((Number(item.received) / total) * 100))
}

export function statusText(status: string): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '下载中'
    case 'paused':
      return '已暂停'
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return status
  }
}
