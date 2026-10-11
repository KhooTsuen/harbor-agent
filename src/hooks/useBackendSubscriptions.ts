import { useEffect } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'
import { useRealBackend, subscribePluginChanges } from '@/lib/backend'
import { subscribeImageDone } from '@/lib/subscriptions'
import { useTaskStore } from '@/stores/useTaskStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useTaskNotifications } from '@/hooks/useTaskNotifications'
import { useDownloadNotifications } from '@/hooks/useDownloadNotifications'
import { useErrorSignal } from '@/hooks/useErrorSignal'
import { uid } from '@/lib/utils'

/**
 * M3：一轮开始后，等内核把任务写进台账再补刷一次的时间。
 * 只在**跑起来那一刻**用一次（`setTimeout`），不是周期定时器。
 */
const TASK_REFRESH_DELAY_MS = 2000

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
   * 下载的开始 / 完成 / 失败提示。
   * 它同时是**下载事件的唯一订阅点** —— 面板按标签条件渲染，订阅放那儿的话，
   * 用户在内置浏览器里点下载时没人接（见 hook 的文件头）。
   */
  useDownloadNotifications()

  /*
   * Phase 1 · A1：右栏「错误」标签的「未读严重错误」信号。
   * 同一套触发方式（挂载 / 窗口可见 / 一轮跑完），空闲不轮询。
   */
  useErrorSignal()

  /*
   * 未完成任务：启动、对话运行状态变化、窗口重新可见时刷新。
   * 空闲时不轮询；任务不会凭空变化，20 秒常驻定时器只会重复读磁盘。
   *
   * M3：除此之外，「一轮**开始**」时再补一发**一次性**刷新 —— 见下面注释。
   */
  useEffect(() => {
    if (!useRealBackend) return
    const refresh = useTaskStore.getState().refresh
    const refreshVisible = (): void => {
      if (!document.hidden) void refresh()
    }
    refreshVisible()
    document.addEventListener('visibilitychange', refreshVisible)
    /*
     * M3 · 一轮开始时补一次台账刷新。
     *
     * 这个 effect 依赖 `runningCount`（= 正在跑的对话数），所以它变了本就会重跑
     * 一次 —— 但**跑开始那一刻刷得太早**：这时内核多半还没把任务写进台账
     * （任务要在这一轮真正跑起来、头几步之后才落盘），于是「后台任务在运行」
     * 这个数会一直等到**这一轮结束**（runningCount 回落）才更新，中间是滞后的
     * （Phase 2 真机实测到过：流式中顶栏不亮，手动打开「任务」面板触发一次刷新
     * 后立刻变准）。
     *
     * 补法：跑开始后**延迟一次**再刷，等内核把台账写完。刻意用 `setTimeout`
     * 而不是 `setInterval` —— 只补这一发，绝不退化成常驻轮询（那正是本项目
     * 反复强调不要做的）。延迟是启发值，真机验证时对过数（见 Phase 4 报告）。
     */
    let timer = 0
    if (runningCount > 0) {
      timer = window.setTimeout(refreshVisible, TASK_REFRESH_DELAY_MS)
    }
    return () => {
      document.removeEventListener('visibilitychange', refreshVisible)
      if (timer) window.clearTimeout(timer)
    }
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
