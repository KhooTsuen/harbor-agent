import { useEffect } from 'react'
import { shouldNotifyEnd } from '@/lib/taskNotify'
import { subscribeNotificationClick, subscribeTaskEnd } from '@/lib/subscriptions'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useRealBackend } from '@/lib/backend'

/* ══════════════════════════════════════════════════════════════
   后台任务通知（AG-029）—— 渲染层只负责**应用内那条提示**

   需求：任务完成/失败时告诉用户，**不抢焦点**，并给一个「查看结果」入口。

   ── 分工 ──
   主进程：判断一轮跑完没有、组装文案、决定要不要弹**系统通知** ——
     「窗口现在是不是被用户看着」只有它答得准（`isMinimized()` /
     `isVisible()` / `isFocused()` 是 Electron 的原话，渲染层只有一个
     `document.hasFocus()` 分不清最小化、藏托盘、被盖住）。
   渲染层：只决定要不要弹**应用内提示**（它知道用户在看哪条对话）。

   ★ 不抢焦点 = 三条：
     ① 不调用窗口聚焦 / 不弹模态；
     ② 不自动切对话（只给按钮，点不点由用户）；
     ③ 用户正在看这条对话（且窗口在前台）时根本不弹。
     系统通知的点击是例外 —— 那是用户自己点的，主进程会把窗口叫回来。
   ══════════════════════════════════════════════════════════════ */

/** 跳到某条任务的结果：切到它的对话 + 打开右栏任务中心 */
function openTaskResult(threadId: string): void {
  if (!threadId) return
  useAppStore.getState().setActiveThread(threadId)
  useUIStore.getState().setActiveRightTab('tasks')
}

export function useTaskNotifications(): void {
  /* 点系统通知 → 和点应用内「查看结果」走同一条路 */
  useEffect(() => {
    if (!useRealBackend) return
    return subscribeNotificationClick(({ id }) => openTaskResult(id))
  }, [])

  useEffect(() => {
    if (!useRealBackend) return
    return subscribeTaskEnd((payload) => {
      /*
       * AG-033：任务**成功完成**且就是当前这条对话 → 亮出「下一步」入口。
       *   · 只看 success（文档说的是「任务完成后」；失败/取消给建议没意义）
       *   · 只认当前对话（别的对话跑完，用户还在这条上）
       * 入口只是把话写好，点下去走普通发送链路，不会自动执行任何东西。
       */
      if (
        payload.kind === 'success' &&
        payload.sessionId === useAppStore.getState().activeThreadId
      ) {
        useUIStore
          .getState()
          .setNextSteps({ threadId: payload.sessionId, outcome: payload.outcome })
      }

      if (
        !shouldNotifyEnd({
          threadId: payload.sessionId,
          activeThreadId: useAppStore.getState().activeThreadId,
          windowFocused: document.hasFocus(),
        })
      ) {
        return
      }
      useUIStore.getState().showToast(payload.kind, payload.title, payload.description, {
        label: '查看结果',
        onClick: () => openTaskResult(payload.sessionId),
      })
    })
  }, [])
}
