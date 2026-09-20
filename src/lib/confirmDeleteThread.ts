import { useAppStore } from '@/stores/useAppStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   删对话（连同它的任务历史）—— 统一入口

   两个入口：侧栏的「删除」和 Ctrl+W。确认文案必须**一模一样**，
   否则用户会以为这两处删掉的东西不一样。

   为什么要有确认：现在删的不只是一条对话，还有它的任务台账
   （任务中心里那些记录会一起没），不能撤销。
   ══════════════════════════════════════════════════════════════ */

function short(text: string, max = 24): string {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function confirmDeleteThread(threadId: string): void {
  const thread = useAppStore.getState().threads.find((t) => t.id === threadId)
  if (!thread) return

  useUIStore.getState().askPermission({
    kind: 'delete-thread',
    title: '删除这条对话？',
    description:
      `「${short(thread.title, 40)}」里的 ${thread.messages.length} 条消息、` +
      '以及这条对话的任务记录都会一起删掉，不能撤销。',
    confirmText: '删除',
    danger: true,
    onConfirm: () => {
      void (async () => {
        const removed = await useAppStore.getState().deleteThread(threadId)
        const ui = useUIStore.getState()
        if (removed > 0) {
          ui.showToast(
            'success',
            '已删除',
            `${short(thread.title)} · 一并清理了 ${removed} 条任务历史`,
          )
        } else {
          ui.showToast('success', '已删除', short(thread.title))
        }
      })()
    },
  })
}
