import { useCallback, useEffect, useState } from 'react'
import type { TaskRecord } from '@/types/safety'
import { bodyTextOf } from '@/lib/bodyText'
import { navigateToFlow } from '@/lib/flowNavigation'
import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'

type Target = { taskId: string; sessionId: string }

/** 任务只能按真实绑定定位；旧台账缺少绑定时仍打开会话，不按标题猜。 */
export function useTaskConversationNavigation() {
  const [target, setTarget] = useState<Target | null>(null)
  const activeThreadId = useAppStore((state) => state.activeThreadId)
  const loadingThreadId = useAppStore((state) => state.loadingThreadId)
  const thread = useAppStore((state) =>
    target ? state.threads.find((item) => item.id === target.sessionId) : undefined,
  )
  const showToast = useUIStore((state) => state.showToast)
  const matched = target
    ? [...(thread?.messages ?? [])]
        .reverse()
        .find((message) => message.role === 'assistant' && message.execTaskId === target.taskId)
    : undefined

  const openTask = useCallback((task: TaskRecord) => {
    if (!task.sessionId) return
    const app = useAppStore.getState()
    if (!app.threads.some((item) => item.id === task.sessionId)) {
      useUIStore.getState().showToast('info', '关联对话暂不可用', '任务记录保留，未找到对应对话。')
      return
    }
    if (app.activeThreadId !== task.sessionId) app.setActiveThread(task.sessionId)
    setTarget({ taskId: task.id, sessionId: task.sessionId })
  }, [])

  useEffect(() => {
    if (!target) return
    if (activeThreadId !== target.sessionId) {
      setTarget(null)
      return
    }
    if (loadingThreadId === target.sessionId) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const app = useAppStore.getState()
        if (app.activeThreadId !== target.sessionId) return
        if (app.loadingThreadId === target.sessionId) return
        const current = app.threads.find((item) => item.id === target.sessionId)
        const message = [...(current?.messages ?? [])]
          .reverse()
          .find((item) => item.role === 'assistant' && item.execTaskId === target.taskId)
        if (message) {
          const final = message.status === 'sent' && bodyTextOf(message)
          navigateToFlow(message.id, final ? `flow-answer-${message.id}` : undefined)
        } else {
          showToast('info', '已打开关联对话', '这条任务没有可精确定位的答复绑定记录。')
        }
        setTarget(null)
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [
    target,
    activeThreadId,
    loadingThreadId,
    thread?.id,
    thread?.messages.length,
    matched?.id,
    showToast,
  ])

  return openTask
}
