import { useState } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { nextStepsFor, type NextStep } from '@/lib/nextSteps'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   下一步（AG-033 给入口 · AG-034 按上下文挑入口）

   任务刚跑完，在输入框上方给一句结论 + 几个入口：

     修改完成，测试尚未运行。
     [运行测试] [查看 Diff] [提交修改] [继续优化]

   ★ 只是**快捷入口**：
     · 「查看 Diff」切右栏审查标签、「查看测试结果」就地展开结果 —— 都是纯看；
     · 其余几项只是把话替用户写好，点下去走**普通发送链路**，
       该弹权限还是弹权限（AG-013）。绝不在这里直接跑命令或提交。

   位置选择：复用输入框上方「建议」那块地方（两者互斥，不叠两层）——
   AG-030 刚把噪音收拾干净，不能又加一排。
   ══════════════════════════════════════════════════════════════ */

export function NextSteps() {
  const nextSteps = useUIStore((s) => s.nextSteps)
  const setNextSteps = useUIStore((s) => s.setNextSteps)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const sendMessage = useThreadStore((s) => s.sendMessage)
  /*
   * 「结果展开着没」记的是**哪一份结果**，不是一个 boolean。
   * 上一轮展开着没管，下一轮卡片一出现就跟着展开（真机探针逮到的）——
   * 换成按内容认，换了任务自然就收起来了。
   */
  const [shownFor, setShownFor] = useState<string | null>(null)

  /* 只认当前这条对话 —— 切走了就不显示（也不用额外清理） */
  if (!nextSteps || nextSteps.threadId !== activeThreadId) return null

  const { headline, steps } = nextStepsFor(nextSteps.outcome)
  const { testCommand, testSummary } = nextSteps.outcome
  /* 按「哪一次任务」认，不是按命令认 —— 连着两轮跑同一条命令才分得开 */
  const resultKey = `${nextSteps.threadId}|${nextSteps.outcome.taskId || testCommand}`
  const showResult = shownFor === resultKey

  function run(step: NextStep): void {
    if (step.id === 'testResult') {
      /* 纯看：就地展开，不关卡片、不发消息 */
      setShownFor(showResult ? null : resultKey)
      return
    }
    setNextSteps(null)
    if (step.id === 'diff') {
      /* 纯导航：不碰文件、不跑命令 */
      setActiveRightTab('diff')
      return
    }
    if (step.prompt) sendMessage(step.prompt)
  }

  return (
    <div aria-label="下一步" className="mb-2 flex flex-col gap-1.5 px-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="shrink-0 text-2xs text-fg-secondary">{headline}</span>
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

      {/* 「查看测试结果」就地展开 —— 结果本来就记在台账里，不必再问模型一遍 */}
      {showResult ? (
        <div className="rounded-sm border border-line-subtle bg-bg-base/40">
          <div className="flex items-center gap-2 px-2 py-1 text-2xs text-fg-tertiary">
            <span className="min-w-0 flex-1 truncate font-mono">
              {testCommand || '（没有记录命令）'}
            </span>
            <button
              type="button"
              onClick={() => setShownFor(null)}
              className="shrink-0 rounded-sm px-1 hover:bg-bg-hover hover:text-fg-primary"
            >
              收起
            </button>
          </div>
          <pre className="max-h-40 overflow-auto border-t border-line-subtle px-2 py-1.5 font-mono text-2xs leading-[1.6] whitespace-pre-wrap text-fg-secondary">
            {testSummary || '（这次没留下输出）'}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
