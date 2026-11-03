import type { NotifyCategory, ToastKind } from '@/types'
import { categoryOf, routeFor } from '@/lib/notifyCenter'
import { useNotifyCenter } from '@/stores/useNotifyCenter'
import { useSettingsStore } from '@/stores/useSettingsStore'

/* ══════════════════════════════════════════════════════════════
   一条提示该去哪儿 —— **分流只在这里做**

   从 `useUIStore` 的 `showToast` 里抽出来的：那个 store 已经贴着 300 行红线，
   而这段逻辑（定类 → 查偏好 → 决定弹 / 记 / 丢）本来就自成一块，
   塞在 store 里会让「界面状态」和「通知策略」两件事搅在一起。

   ★ 一次只判一次：调用方拿到 `true` 就知道「已经处理完了，别再弹卡」。
     不允许调用方自己再判一遍 `route` —— 两处判断必然漂。
   ══════════════════════════════════════════════════════════════ */

export interface DispatchInput {
  kind: ToastKind
  title: string
  description?: string
  /** 按钮（「查看结果」「查看下载」）—— 有按钮多半意味着「点一下去看」 */
  action?: { label: string; onClick: () => void }
  /** 调用方点名的类别（比按 kind 推断准，见 `categoryOf`） */
  category?: NotifyCategory
}

/**
 * @returns `true` = 这条已经分流掉了（进了收件箱，或用户选了「都不要」），
 *          调用方**不要**再往右下角弹。`false` = 该弹卡片。
 */
export function dispatchNotify(input: DispatchInput): boolean {
  const { kind, title, description, action, category } = input
  /*
   * **每次现读**设置：用户在面板上刚改完，下一条提示就得按新规矩走。
   * 缓存这份偏好会造出「改了没生效」的观感 —— 而它就是这么被发现的。
   */
  const cat = categoryOf(kind, Boolean(action), category)
  const route = routeFor(useSettingsStore.getState().settings.notifyRoutes, cat)

  /* 「都不要」：不弹也不记 */
  if (route === 'off') return true

  if (route === 'center') {
    /*
     * 「只进收件箱」。这类提示**不进**右下角那份历史（`toastHistory`）：
     * 它已经在通知标签里了，再记一份等于同一件事在两个地方出现。
     */
    useNotifyCenter.getState().push({
      category: cat,
      kind,
      title,
      ...(description ? { description } : {}),
      ...(action ? { action: { label: action.label, run: action.onClick } } : {}),
    })
    return true
  }

  return false
}
