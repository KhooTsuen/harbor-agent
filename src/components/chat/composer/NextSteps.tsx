import { ArrowRight, X } from 'lucide-react'
import { nextStepsFor, type NextStep } from '@/lib/nextSteps'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   下一步（AG-033）

   任务刚跑完，在输入框上方给几个入口。文档原文：

     下一步：[运行测试] [查看 Diff] [继续检查] [提交修改]

   ★ 只是**快捷入口**：
     · 「查看 Diff」是纯导航（打开右栏审查标签）；
     · 其余几项都只是把话替用户写好，点下去走**普通发送链路** ——
       该弹权限还是弹权限（AG-013），和用户手打一模一样。
   绝不在这里直接跑命令或提交。

   位置选择：复用输入框上方「建议」那块地方（两者互斥，不叠两层）——
   AG-030 刚把噪音收拾干净，不能又加一排。
   ══════════════════════════════════════════════════════════════ */

export function NextSteps() {
  const nextSteps = useUIStore((s) => s.nextSteps)
  const setNextSteps = useUIStore((s) => s.setNextSteps)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const sendMessage = useThreadStore((s) => s.sendMessage)

  /* 只认当前这条对话 —— 切走了就不显示（也不用额外清理） */
  if (!nextSteps || nextSteps.threadId !== activeThreadId) return null

  const steps = nextStepsFor({ files: nextSteps.files })

  function run(step: NextStep): void {
    setNextSteps(null)
    if (step.id === 'diff') {
      /* 纯导航：不碰文件、不跑命令 */
      setActiveRightTab('diff')
      return
    }
    if (step.prompt) sendMessage(step.prompt)
  }

  return (
    <div aria-label="下一步" className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
      <span className="shrink-0 text-2xs text-fg-tertiary">下一步：</span>
      {steps.map((step) => (
        <button
          key={step.id}
          type="button"
          onClick={() => run(step)}
          className="flex items-center gap-1 rounded-pill border border-line-hairline bg-bg-raised/50 px-2.5 py-1 text-2xs text-fg-secondary transition-colors duration-fast hover:bg-bg-hover hover:text-fg-primary"
        >
          {step.label}
          {step.prompt ? <ArrowRight size={11} className="shrink-0" /> : null}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setNextSteps(null)}
        aria-label="不用了"
        title="不用了"
        className="shrink-0 rounded-pill p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
      >
        <X size={11} />
      </button>
    </div>
  )
}
