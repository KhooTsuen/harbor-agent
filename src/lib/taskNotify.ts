/* ══════════════════════════════════════════════════════════════
   「该不该打扰用户」的判断（AG-029）

   只有这一条留在渲染层 —— 通知的**内容**在核心里
   （`electron/core/task-notify.cjs`），因为要弹系统通知的是主进程。
   这里只回答一个问题：这条通知该不该变成应用内的提示。

   「不抢焦点」这条要求在这里落地：**只有用户没在看的任务才提示** ——
   他正盯着这条对话时弹一条「任务完成」纯属打扰；
   反过来，窗口在后台（切到别的应用了）时哪怕就是当前对话也要提示，
   因为他根本没看到。
   ══════════════════════════════════════════════════════════════ */

export function shouldNotifyEnd(options: {
  threadId: string
  activeThreadId: string
  windowFocused: boolean
}): boolean {
  if (!options.windowFocused) return true
  return options.threadId !== options.activeThreadId
}
