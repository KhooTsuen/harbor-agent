import type { Thread } from '@/types'
import { useRealBackend } from '@/lib/backend'
import { fetchMessagesFromDisk, fetchWorkspaceFromDisk } from './disk'
import type { AppState } from './types'

/* ══════════════════════════════════════════════════════════════
   磁盘读写动作（loadFromDisk / openFromDisk）

   从 useAppStore.ts 拆出来的 —— 那边贴 300 行了。
   这两个动作是一对，而且**互相影响**（刷新工作区会不会清掉已读的消息），
   放一起才看得出来，所以没有各拆各的。

   ── 为什么要有 loadingThreadId ──────────────────────────────
   openFromDisk 是「先切选中、再去读消息」，读要几十到几百毫秒
   （千条会话真机 ~700ms）。这段窗口里 `thread.messages` 是**空数组**，
   界面分不清它是「刚建的空对话」还是「正在读」—— 以前一律渲染开屏
   （launch/LaunchScreen.tsx），而开屏一挂上就跑工作区扫描 / 未完成任务 /
   凭据检查一串 IPC 还要画灯塔，然后消息到了整个丢掉。

   真机量过：切千条会话那次 **65–76ms 长任务**就在这一刻（CPU Profile 里
   是 `fillText` / `fillRect` 一片 canvas 绘制 + 一堆原生 deserialize）。
   所以读的时候挂个 id 出来，界面改画骨架。
   ══════════════════════════════════════════════════════════════ */

type Setter = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
type Getter = () => AppState

type DiskActions = Pick<AppState, 'loadFromDisk' | 'openFromDisk'>

/**
 * 元数据刷新时**留住内存里已有的消息**。
 *
 * 会话列表是从磁盘元数据重建的（只有条数/标题/时间，没有消息），直接换上去
 * 会把打开着的会话清成空数组 —— 于是界面闪一下开屏，而 `openFromDisk` 那条
 * 「读盘期间没人动过消息才允许覆盖」的守卫也会因为引用变了而**把读回来的消息丢掉**
 * （症状：点了会话，侧栏高亮切过去了，消息区一直还是上一个会话）。
 */
export function mergeThreads(current: readonly Thread[], fresh: readonly Thread[]): Thread[] {
  return fresh.map((thread) => {
    const old = current.find((t) => t.id === thread.id)
    return old && old.messages.length > 0 ? { ...thread, messages: old.messages } : thread
  })
}

export function makeDiskActions(set: Setter, get: Getter): DiskActions {
  return {
    loadFromDisk: async () => {
      if (!useRealBackend) return
      const result = await fetchWorkspaceFromDisk()
      set((state) => ({
        /* 每个项目 = 侧栏一个文件夹；内核记着上次选中的是哪个（已失效则回退第一个） */
        projects: result.folders.map((f) => f.project),
        threads: mergeThreads(state.threads, result.threads),
        activeProjectId: result.activeId || (result.folders[0]?.project.id ?? ''),
        activeThreadId: result.threads.some((t) => t.id === state.activeThreadId)
          ? state.activeThreadId
          : (result.threads[0]?.id ?? ''),
      }))
    },

    openFromDisk: async (id) => {
      if (!useRealBackend) return
      set({ activeThreadId: id })
      const before = get().threads.find((t) => t.id === id)
      /* 内存里没有它的消息 = 这次真要去读：挂上 loading，界面别把空数组当空对话 */
      const mustRead = (before?.messages.length ?? 0) === 0
      if (mustRead) set({ loadingThreadId: id })
      /*
       * 卡住「读回来的时候把刚加的消息盖掉」这个真 bug：
       *
       * 这条 `await` 期间用户完全可能已经发消息了 —— `resumeTask`（点「继续」）
       * 就是 setActiveThread 紧接着 sendMessage，中间没有等待。
       * 读回来直接 set 就会把刚插进去的用户消息 + 流式占位一起抹掉，
       * 界面上就是「点继续以后对话一片空白，但 Agent 其实在跑」。
       *
       * 判据：内存里还是**调用前那个数组**（没人动过）才允许覆盖。
       * 注意不能用「长度是不是 0」—— 并发删消息也照样能把数组改成别的。
       */
      try {
        const messages = await fetchMessagesFromDisk(id)
        if (!messages) return
        const current = get().threads.find((t) => t.id === id)
        if (!current || current.messages !== before?.messages) return
        set((state) => ({
          threads: state.threads.map((t) => (t.id === id ? { ...t, messages } : t)),
        }))
      } finally {
        if (mustRead)
          set((state) => (state.loadingThreadId === id ? { loadingThreadId: null } : {}))
      }
    },
  }
}
