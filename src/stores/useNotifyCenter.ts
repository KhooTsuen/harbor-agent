import { create } from 'zustand'
import type { NotifyCategory } from '@/types'
import { uid } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   通知中心 —— 右下角那些「事后看就行」的提示，收在这里

   ── 和右栏「错误」标签的分工（别混）──────────────────────────
     · **错误**（`ErrorsPanel`）：内核在出错现场记的诊断，带分类 / 位置 /
       建议，按 7 / 30 天窗口查，**只读不删** —— 那是排查用的。
     · **通知**（这里）：给人看的事件流水，带「查看结果」这类按钮，
       可以清空。一次失败会同时出现在两边，但**用途不同**，不是重复。

   ── 三条自我约束 ─────────────────────────────────────────────
     ① **只存在内存里**（不落 localStorage）：用户要的是「本次打开期间的收件箱」。
        落盘会引出保留期、清理、跨重启去重一堆问题，而收益只是「关机也能回看」。
     ② **有上限**（`MAX_NOTIFY_ITEMS`），超出丢最旧的 —— 没有上限的数组
        迟早会把界面拖慢（右下角的 toast 就是没上限才糊一屏的）。
     ③ **偏好不在这里**：每一类去哪儿属于设置（`Settings.notifyRoutes`，
        在 `useSettingsStore` 里）。同一件事存两份必然漂 —— 这个 store
        只负责条目本身，读偏好一律去设置里读。
   ══════════════════════════════════════════════════════════════ */

/** 上限：再多用户也不会翻，只会在打开面板时卡一下 */
const MAX_NOTIFY_ITEMS = 200

export interface NotifyItem {
  id: string
  category: NotifyCategory
  /** 语气（决定图标与颜色；与类别是两件事：同一类里也可能有 success/info） */
  kind: 'success' | 'error' | 'info' | 'warning'
  title: string
  description?: string
  /** 这条是什么时候进来的（毫秒时间戳） */
  at: number
  /** 未读：面板没打开时进来的都算未读，打开一次就清 */
  unread: boolean
  /**
   * 按钮（「查看结果」「查看下载」）。
   *
   * ★ 存**函数**而不是存「要跳去哪儿」的字符串：跳转逻辑分散在七八个调用点
   *   （切对话 / 开右栏标签 / 打电话给主进程），把它们各自重写成一份可序列化
   *   的描述，等于给每个调用点再造一套真相源。这个数组只活在内存里，不落盘，
   *   所以函数不会遇到「序列化后失效」的问题。
   */
  action?: { label: string; run: () => void }
}

interface NotifyCenterState {
  items: NotifyItem[]
  /** 进来一条（由 `useUIStore.showToast` 按用户偏好分流后调用） */
  push: (item: Omit<NotifyItem, 'id' | 'at' | 'unread'>) => void
  /** 用户点开了「通知」标签 —— 全部标为已读，不清空 */
  markAllRead: () => void
  /** 清空收件箱（用户自己点的） */
  clear: () => void
  /** 去掉一条 */
  remove: (id: string) => void
}

export const useNotifyCenter = create<NotifyCenterState>()((set) => ({
  items: [],
  push: (item) =>
    set((s) => ({
      /*
       * 去重：同类别 + 同标题 + 同描述，且**都还没读过**时不再堆一条。
       * 重复的典型来源：Agent 连续三次同样的工具失败 —— 收件箱里堆三条
       * 一模一样的东西，只会把真正不同的那条挤下去。
       * 已读的不参与去重：那时候用户已经看过了，再来一条是**新发生的事**。
       */
      items: [
        { ...item, id: uid('notify'), at: Date.now(), unread: true },
        ...s.items.filter(
          (old) =>
            !(
              old.unread &&
              old.category === item.category &&
              old.title === item.title &&
              old.description === item.description
            ),
        ),
      ].slice(0, MAX_NOTIFY_ITEMS),
    })),
  markAllRead: () =>
    set((s) =>
      s.items.some((item) => item.unread)
        ? { items: s.items.map((item) => (item.unread ? { ...item, unread: false } : item)) }
        : s,
    ),
  clear: () => set({ items: [] }),
  remove: (id) => set((s) => ({ items: s.items.filter((item) => item.id !== id) })),
}))

/** 未读条数（右栏标签角标读它） */
export function unreadNotifyCount(items: readonly NotifyItem[]): number {
  let n = 0
  for (const item of items) if (item.unread) n++
  return n
}
