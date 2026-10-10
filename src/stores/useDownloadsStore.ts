import { create } from 'zustand'
import {
  FALLBACK_LIMITS,
  downloadsAction,
  downloadsAdd,
  downloadsClear,
  downloadsList,
  downloadsSetLimits,
  type DownloadEvent,
  type DownloadItem,
  type DownloadLimits,
} from '@/lib/downloadsApi'

/* ═══════════════════════════════════════════════════════════════
   下载管理器快照

   后端（`electron/core/download-queue.cjs` + 台账 data/downloads.json）是唯一
   真相源，这里只是界面看到的那一份：

     · **进度**（progress 事件）就地改内存，不重新拉整表 —— 大文件每 200ms 拉一次
       是纯浪费。
     · **状态跃迁**（added/started/done/failed/paused/removed/cleared）才拉整表，
       因为「谁在跑、排第几」只有后端知道。
     · 拉不到（浏览器预览 / 内核没起）→ items 为空、error 一句人话，不白屏。
   ═══════════════════════════════════════════════════════════════ */

interface DownloadsState {
  items: DownloadItem[]
  /** 正在跑的 id（后端内存态推过来的） */
  running: string[]
  limits: DownloadLimits
  loaded: boolean
  /** 拉不到时的说明（空 = 正常） */
  error: string
  refresh: () => Promise<void>
  applyEvent: (event: DownloadEvent) => void
  add: (url: string, path: string) => Promise<{ ok: boolean; error?: string }>
  act: (
    id: string,
    action: 'pause' | 'resume' | 'retry' | 'remove',
  ) => Promise<{ ok: boolean; error?: string }>
  clearFinished: () => Promise<{ ok: boolean; error?: string }>
  setLimits: (patch: Partial<DownloadLimits>) => Promise<{ ok: boolean; error?: string }>
}

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  items: [],
  running: [],
  limits: FALLBACK_LIMITS,
  loaded: false,
  error: '',

  refresh: async () => {
    const snapshot = await downloadsList()
    if (!snapshot) {
      set({ loaded: true, error: '读不到下载列表（内核没起 / 浏览器预览没有内核）' })
      return
    }
    set({
      items: snapshot.items,
      running: snapshot.running,
      limits: snapshot.limits,
      loaded: true,
      error: '',
    })
  },

  applyEvent: (event) => {
    const id = event.id ?? ''
    /* 进度就地更新：只在已存在的那条上改，缺了等下一次 refresh 补 */
    if (event.type === 'progress' && id) {
      set((state) => ({
        items: state.items.map((item) =>
          item.id === id
            ? {
                ...item,
                received: event.received ?? item.received,
                total: event.total ?? item.total,
                speedBps: event.speedBps ?? 0,
                status: 'running',
              }
            : item,
        ),
      }))
      return
    }
    if (event.type === 'limits' && event.limits) {
      set({ limits: event.limits })
      return
    }
    /* 其余都是「队列形状变了」，拉一次整表 */
    void get().refresh()
  },

  add: async (url, path) => {
    const result = await downloadsAdd(url, path)
    if (result.ok) await get().refresh()
    return { ok: result.ok, error: result.error }
  },

  act: async (id, action) => {
    const result = await downloadsAction(id, action)
    if (result.ok) await get().refresh()
    return result
  },

  clearFinished: async () => {
    const result = await downloadsClear()
    if (result.ok) await get().refresh()
    return { ok: result.ok, error: result.error }
  },

  setLimits: async (patch) => {
    const result = await downloadsSetLimits(patch)
    if (result.ok && result.limits) set({ limits: result.limits })
    return { ok: result.ok, error: result.error }
  },
}))
