import { useEffect } from 'react'
import type { AgentPhase } from '@/types'
import { isTerminalPhase } from '@/lib/agentPhase'
import { endNotice, shouldNotifyEnd } from '@/lib/taskNotify'
import { useAppStore } from '@/stores/useAppStore'
import { useTaskStore } from '@/stores/useTaskStore'
import { useUIStore } from '@/stores/useUIStore'
import { useRealBackend } from '@/lib/backend'

/* ══════════════════════════════════════════════════════════════
   后台任务通知（AG-029）

   需求：任务完成/失败时告诉用户，**不抢焦点**，并给一个「查看结果」入口。

   为什么盯「相位变化」而不是聊天事件流：
   相位由主进程状态机推（AG-001），是唯一真相；聊天事件流是按 requestId
   订阅的，而且一条对话可能因为暂停/重试走好几轮 —— 盯相位只需看
   「这条对话刚才还在跑，现在结束了」，不用管中间发生了什么。

   ★ 不抢焦点 = 三件事都不做：
     ① 不调用窗口聚焦 / 不弹系统级模态；
     ② 不自动切对话（只弹一条带按钮的提示，点不点由用户）；
     ③ 用户正在看这条对话（且窗口在前台）时根本不弹。
   ══════════════════════════════════════════════════════════════ */

export function useTaskNotifications(): void {
  useEffect(() => {
    if (!useRealBackend) return

    /*
     * 上一次看到的相位（按对话）。启动时是空的，第一条回调里每个对话的
     * previous 都是 undefined —— 那种情况**一律跳过**，否则「启动时本来就
     * 已经结束」的那些对话会被当成刚刚完成，一开机弹一排通知。
     * （不要另外再「先记一遍当前状态」：那是同一个目的的第二套机制，
     *   会让这个判断变得无法被测试验证 —— 变异测试抓到过。）
     */
    const seen = new Map<string, AgentPhase | undefined>()

    return useAppStore.subscribe((state) => {
      for (const thread of state.threads) {
        const previous = seen.get(thread.id)
        seen.set(thread.id, thread.phase)

        /* 只认「刚才是别的相位、现在落在终态」这一次跳变 */
        if (previous === undefined || previous === thread.phase) continue
        if (!isTerminalPhase(thread.phase)) continue
        const phase = thread.phase as AgentPhase

        if (
          !shouldNotifyEnd({
            threadId: thread.id,
            activeThreadId: state.activeThreadId,
            windowFocused: document.hasFocus(),
          })
        ) {
          continue
        }
        void notify(thread.id, phase)
      }
    })
  }, [])
}

/** 拉一次最新任务台账，再按它组通知内容（任务名、改了几个文件、结果） */
async function notify(threadId: string, phase: AgentPhase): Promise<void> {
  await useTaskStore.getState().refresh()
  /* task:list 按 updatedAt 倒序 —— 第一条就是这条对话最近的活儿 */
  const task = useTaskStore.getState().tasks.find((item) => item.sessionId === threadId)
  const notice = endNotice(phase, task)
  if (!notice) return

  useUIStore.getState().showToast(notice.kind, notice.title, notice.description, {
    label: '查看结果',
    onClick: () => {
      useAppStore.getState().setActiveThread(threadId)
      /* 结果在任务中心里 —— 顺手把右栏切到那儿，不用用户自己找 */
      useUIStore.getState().setActiveRightTab('tasks')
    },
  })
}
