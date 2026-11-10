import { useEffect, useRef } from 'react'
import type { Message } from '@/types'
import { activityLabel } from '@/lib/agentActivity'
import { useStopFeedback } from '@/stores/stopFeedback'
import { useUIStore } from '@/stores/useUIStore'

export function useFlowPresentation(message: Message, streaming: boolean) {
  const identity = message.execId ?? `${message.diskKey ?? message.id}:${message.answerIndex ?? 0}`
  const observedLive = useRef(new Set<string>(streaming ? [identity] : []))
  const stoppingFor = useStopFeedback((state) => state.requests[message.threadId])
  const permission = useUIStore((state) => state.permission?.threadId === message.threadId)
  const clarify = useUIStore((state) => state.clarify?.threadId === message.threadId)
  useEffect(() => {
    if (streaming) observedLive.current.add(identity)
    else if (stoppingFor === (message.execId ?? message.id)) {
      useStopFeedback.getState().clear(message.threadId, message.execId ?? message.id)
    }
  }, [streaming, stoppingFor, identity, message.execId, message.id, message.threadId])
  const stopping = streaming && stoppingFor === (message.execId ?? message.id)
  const waiting = streaming && (message.phase === 'waiting_user' || permission || clarify)
  const running = streaming && !stopping && !waiting && message.phase !== 'paused'
  const nodes = message.flow?.nodes ?? []
  const last = nodes.at(-1)
  const activeTool = message.toolRuns?.some((run) => run.pending)
  const writing = running && !activeTool && last?.kind === 'speech'
  const started = nodes.length > 0 || (message.phase && message.phase !== 'preparing')
  let summary: string
  if (stopping) summary = '正在停止'
  else if (waiting) summary = '等待你答复'
  else if (message.phase === 'cancelled') summary = '已停止'
  else if (message.phase === 'paused') summary = '已暂停'
  else if (message.interrupted) summary = '执行未完成'
  else if (message.status === 'error') summary = '执行遇到错误'
  else if (!streaming) summary = '执行过程'
  else if (!started) summary = '正在开始'
  else if (writing) summary = last?.kind === 'speech' && last.hold ? '正在生成答复' : '正在输出文字'
  else summary = activityLabel(message.toolRuns ?? [], message.phase)
  return {
    motion: streaming || observedLive.current.has(identity),
    running,
    writing,
    waiting,
    stopping,
    summary,
  }
}
