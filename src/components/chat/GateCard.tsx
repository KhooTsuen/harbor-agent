import type { ClarifyQuestion, ClarifyReply } from '@/types'
import { cn } from '@/lib/utils'
import { CircleHelp } from 'lucide-react'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   A 闸门（2026-10-07）——「执行前的计划复核」卡

   和普通澄清卡（`ClarifyCard`）**共用一条挂载点、一条 IPC 往返**，但出口不一样：
   澄清卡有四个出口（先不做了 / 换个说法 / 跳过 / 就这么干），而对 gate 卡，
   那些出口的后果**全是「停手」**（内核只认选项 label === 「就按这个计划执行」才
   放行）—— 措辞与后果相反：用户点「跳过，你自己看着办」，模型却停手了。

   所以 gate 卡只出**它自己的两个选项**当提交按钮，点哪个就是哪个 —— 不再有
   含糊的第三个、第四个按钮。

   ★ label / effect / 默认项**全部取自内核给的 `questions[0].options`**
     （`ask-user-gate.cjs` 的 `GATE_QUESTION`）—— 不在这里重写一遍，
     跨模块只有一个真相源（硬约束 9）。
   ══════════════════════════════════════════════════════════════ */

export interface GateCardProps {
  questions: readonly ClarifyQuestion[]
  onReply?: (reply: ClarifyReply) => void
}

export function GateCard({ questions, onReply }: GateCardProps) {
  const q = questions[0]
  if (!q) return null

  /** 点哪个选项 → 就把它的 label 原样回传（内核按 label 判「执行 / 先别动」） */
  const submit = (choice: string) =>
    onReply?.({ skipped: false, answers: [{ question: q.question, choice, text: '' }] })

  return (
    <section
      className="mb-2 rounded-md border border-line-focus bg-bg-raised shadow-low"
      aria-label="执行前复核"
      role="dialog"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full"
          style={{ background: 'rgb(255 255 255 / 0.08)', color: colorOf('waiting') }}
        >
          <CircleHelp size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-medium text-fg-primary">动手前再确认一次</h3>
          <p className="mt-0.5 text-2xs text-fg-secondary">{q.question}</p>
          <div className="mt-2 flex flex-col gap-1">
            {q.options.map((option, index) => (
              <button
                key={option.label}
                type="button"
                /* 第一个选项（内核给的「执行」项）给主色边框，其余描边 —— 主次分明 */
                className={cn(
                  'rounded-sm border px-2.5 py-1.5 text-left transition-colors duration-fast',
                  index === 0
                    ? 'border-line-focus bg-bg-hover'
                    : 'border-line-hairline hover:bg-bg-hover',
                )}
                onClick={() => submit(option.label)}
              >
                <span className="flex items-center gap-1.5 text-xs text-fg-primary">
                  {option.label}
                  {option.label === q.defaultValue ? (
                    <span className="text-2xs text-fg-tertiary">（更稳妥的那个）</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-2xs text-fg-tertiary">
                  因为：{option.effect}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
