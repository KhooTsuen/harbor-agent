import { useUIStore } from '../useUIStore'

/* ══════════════════════════════════════════════════════════════
   离开一条对话时要做的收尾（2026-10-04，小尾巴 #4）

   澄清卡只有**一份**界面状态（`useUIStore.clarify`），而请求是每条对话各自的。
   离开时不处理的话：
     · 卡片跟着用户跑到别的对话里（看着像「新对话里在问我上一个活的问题」）；
     · 内核那边没人回话，一直等到 5 分钟超时 —— 那会被当成「用户离场」，
       按默认选项自己开工，可用户只是切了个对话 / 新建了一条。

   为什么要单独一个文件：**「离开」有不止一条路**。
   真机验证时发现的：侧栏那些走 `setActiveThread`，而「新建对话」走的是
   `createThread` 里的 `set({ activeThreadId })` —— 只改一处就会漏掉新对话那条路
   （探针里正是这样：卡开着点「新建对话」，卡跟到了新对话里）。
   ══════════════════════════════════════════════════════════════ */

/**
 * 离开 `leavingId` 这条对话：如果卡面上那张澄清卡是它的，就收掉并回话给内核。
 *
 * 只收「属于它」的那张 —— 后台可能还有别的对话挂着卡，那不归这次离开管。
 *
 * 2026-10-07 补：**权限卡同样要收**（以前只收澄清卡）。不收的话它会变成僵尸卡
 * 挂在界面上，而 `pickAboveInput` 永远让权限优先 —— 后面所有澄清卡都被挡住。
 */
export function onLeaveThread(leavingId: string | null | undefined): void {
  const id = String(leavingId ?? '')
  if (!id) return
  const open = useUIStore.getState().clarify
  if (open && open.threadId === id) useUIStore.getState().cancelClarify()
  const perm = useUIStore.getState().permission
  if (perm && perm.threadId === id) useUIStore.getState().cancelPermission()
}
