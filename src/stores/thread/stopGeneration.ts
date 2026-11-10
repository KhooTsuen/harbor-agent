import { getActiveThread, useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'
import { useStopFeedback } from '../stopFeedback'
import { stopActiveRequest } from './turnControl'

/** Show the request immediately; only the execution's own terminal event confirms a stop. */
export function stopGenerationWithFeedback(): void {
  const current = getActiveThread(useAppStore.getState())
  if (!current) return
  const live = [...current.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.status === 'streaming')
  const execution = live?.execId ?? live?.id
  if (execution) useStopFeedback.getState().request(current.id, execution)
  const stillCurrent = () =>
    !execution || useStopFeedback.getState().requests[current.id] === execution
  useUIStore.getState().showToast('info', '正在请求停止', '等待后台确认当前执行结束')
  void stopActiveRequest(current.id)
    .then((accepted) => {
      if (!stillCurrent()) return
      if (!accepted) {
        if (execution) useStopFeedback.getState().clear(current.id, execution)
        useUIStore.getState().showToast('error', '停止失败', '后台未确认取消，请重试')
        return
      }
      useUIStore.getState().showToast('info', '正在停止', '等待当前步骤结束后再发送新消息')
    })
    .catch(() => {
      if (!stillCurrent()) return
      if (execution) useStopFeedback.getState().clear(current.id, execution)
      useUIStore.getState().showToast('error', '停止失败', '无法确认后台已停止，请重试')
    })
}
