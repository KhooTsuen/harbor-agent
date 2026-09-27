import { useRealBackend } from '@/lib/backend'
import type { AppState } from './types'

/* ══════════════════════════════════════════════════════════════
   `useAppStore` 的持久化选项（从 useAppStore.ts 抽出来，那边顶到 300 行了）

   为什么必须有 `partialize`（真机数据）：zustand 的 `persist` 每次 `set` 都会把
   持久化对象 JSON.stringify 一遍再落盘。不裁剪的话，状态里带着**全部会话消息** ——
   1000 条那个性能夹具是 9MB。流式每来一片就 `set` 一次 → 每秒十几次 9MB 序列化 +
   落盘，长会话里主线程直接被压死（实测：发一条长 prompt 后 1-2 秒内 CDP 求值
   5 秒超时；用未改动的 beta.21 同样复现）。

   而在 Electron 里磁盘才是数据源（`appendToDisk` / `updateSessionMeta`），
   `skipHydration` 又已打开 —— 这份 blob 写了根本不会读回来，纯属白烧 CPU。
   浏览器调试模式（非 real backend）仍然整份保留：那边就是靠 localStorage 存的。
   ══════════════════════════════════════════════════════════════ */
export const appPersistOptions = {
  name: 'personal-agent:app',
  version: 1,
  /* Electron 的真实磁盘是唯一数据源，不从旧 localStorage 恢复演示数据。 */
  skipHydration: useRealBackend,
  partialize: (s: AppState) =>
    useRealBackend
      ? {
          projects: s.projects,
          /* 会话只留元信息，消息不进来 */
          threads: s.threads.map((thread) => ({ ...thread, messages: [] })),
          activeProjectId: s.activeProjectId,
          activeThreadId: s.activeThreadId,
        }
      : s,
}
