import type { AgentPhase, ToastKind } from '@/types'
import type { TaskRecord } from '@/types/safety'

/* ══════════════════════════════════════════════════════════════
   后台任务通知的内容（AG-029）

   需求原文的示例：

     Agent 任务完成
     「Agent Execution 优化」
     已修改 4 个文件
     测试通过
     [查看结果]

   放成纯函数是为了能直接测：通知的内容、以及「该不该打扰」这两件事
   都不依赖 React，也不用真跑一遍 agent。
   ══════════════════════════════════════════════════════════════ */

const END_META: Partial<Record<AgentPhase, { kind: ToastKind; title: string }>> = {
  completed: { kind: 'success', title: '后台任务完成' },
  failed: { kind: 'error', title: '后台任务失败' },
}

/** 取结果的第一行 —— 「测试通过」这种结论通常就写在最前面 */
function firstLine(text: string): string {
  return (
    String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.slice(0, 80) ?? ''
  )
}

export interface TaskEndNotice {
  kind: ToastKind
  title: string
  description: string
}

/**
 * 任务结束时该显示什么。
 *
 * `phase` 不是「完成 / 失败」就返回 null —— 用户自己按的停止（cancelled）
 * 不通知：那是他刚做的事，再弹一条「已取消」是噪音（需求里也只列了完成/失败）。
 */
export function endNotice(phase: AgentPhase, task?: TaskRecord): TaskEndNotice | null {
  const meta = END_META[phase]
  if (!meta) return null

  const name = task?.title || task?.goal || '未命名任务'
  const lines = [`「${name}」`]

  if (task) {
    const files = task.changedFiles.length
    lines.push(files > 0 ? `已修改 ${files} 个文件` : '没有改动文件')
    const conclusion = firstLine(task.result)
    if (conclusion) lines.push(conclusion)
    else if (phase === 'failed')
      lines.push(firstLine(task.errors.at(-1)?.message ?? '') || '执行失败')
  }

  return { kind: meta.kind, title: meta.title, description: lines.join('\n') }
}

/**
 * 该不该打扰用户。
 *
 * 「不抢焦点」这条要求在这里落地：**只有用户没在看的任务才通知** ——
 * 他正盯着这条对话时弹一条「任务完成」纯属打扰；
 * 反过来，窗口在后台（切到别的应用了）时哪怕就是当前对话也要通知，
 * 因为他根本没看到。
 */
export function shouldNotifyEnd(options: {
  threadId: string
  activeThreadId: string
  windowFocused: boolean
}): boolean {
  if (!options.windowFocused) return true
  return options.threadId !== options.activeThreadId
}
