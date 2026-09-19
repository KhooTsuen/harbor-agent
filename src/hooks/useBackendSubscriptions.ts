import { useEffect } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useRealBackend, subscribePluginChanges } from '@/lib/backend'
import { subscribeImageDone } from '@/lib/subscriptions'
import { useTaskStore } from '@/stores/useTaskStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useTaskNotifications } from '@/hooks/useTaskNotifications'
import { uid } from '@/lib/utils'

/* ══════════════════════════════════════════════════════════════
   主进程推来的「非对话流」事件

   从 App.tsx 抽出来的 —— 那边只该管布局和快捷键。

   这两类事件的共同点：**发生的时候对话那一轮早就结束了**，
   所以只能靠主进程推回来，前端再补进界面。
   ══════════════════════════════════════════════════════════════ */

export function useBackendSubscriptions(): void {
  const runningCount = useThreadStore((state) => state.sendingThreads.length)

  /*
   * AG-029：后台任务完成/失败的通知。
   * 和下面几项同一性质 —— 事情发生时用户可能根本没在看这条对话。
   */
  useTaskNotifications()

  /*
   * 未完成任务：启动、对话运行状态变化、窗口重新可见时刷新。
   * 空闲时不轮询；任务不会凭空变化，20 秒常驻定时器只会重复读磁盘。
   */
  useEffect(() => {
    if (!useRealBackend) return
    const refresh = useTaskStore.getState().refresh
    const refreshVisible = (): void => {
      if (!document.hidden) void refresh()
    }
    refreshVisible()
    document.addEventListener('visibilitychange', refreshVisible)
    return () => document.removeEventListener('visibilitychange', refreshVisible)
  }, [runningCount])

  /* 插件热插拔：发现新增/删除插件时弹个轻提示（不打断） */
  useEffect(() => {
    if (!useRealBackend) return
    const off = subscribePluginChanges(({ added, removed }) => {
      const showToast = useUIStore.getState().showToast
      if (added.length > 0) {
        showToast('success', `检测到新插件：${added.join('、')}`, '下一轮对话即可使用，不用重启')
      } else if (removed.length > 0) {
        showToast('info', `插件已移除：${removed.join('、')}`)
      }
    })
    return off
  }, [])

  /*
   * 生图出图了。
   *
   * 生图是异步的：工具提交完就走了（上游排队要好几分钟），出图时那一轮
   * 对话早结束了 —— 主进程负责写会话 + 推事件，这里把它插进当前界面，
   * 否则用户得切走再切回来才看得到。
   */
  useEffect(() => {
    if (!useRealBackend) return
    const off = subscribeImageDone((payload) => {
      const showToast = useUIStore.getState().showToast

      /* 先处理「进行中」的进度事件 —— 界面要能实时看到它在排队还是正在画 */
      if (payload.status && payload.status !== 'done' && payload.status !== 'failed') {
        useUIStore.getState().setImageTask({
          taskId: payload.taskId,
          sessionId: payload.sessionId,
          status: payload.status,
          elapsedMs: payload.elapsedMs ?? 0,
        })
        return
      }
      /* 出图或失败：进度条收掉 */
      useUIStore.getState().setImageTask(null)

      if (payload.error) {
        showToast('error', '生图失败', payload.error)
        return
      }
      const sessionId = payload.sessionId
      if (sessionId && payload.content) {
        const exists = useAppStore
          .getState()
          .threads.find((t) => t.id === sessionId)
          ?.messages.some((m) => m.content === payload.content)
        /* 重连 / 重放时可能推两遍，按内容去重 */
        if (!exists) {
          useAppStore.getState().addMessage(sessionId, {
            id: uid('msg'),
            threadId: sessionId,
            role: 'assistant',
            content: payload.content,
            kind: 'text',
            status: 'sent',
            timestamp: Date.now(),
          })
        }
      }
      showToast('success', '图片生成好了', payload.file ?? '')
    })
    return off
  }, [])
}
