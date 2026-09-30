import { useState } from 'react'
import { CircleHelp, Sparkles } from 'lucide-react'
import type { ClarifyQuestion, ClarifyReply } from '@/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   开工前澄清卡（AG-053）

   贴输入框上方那块地方（和权限条同一个位置，由 `lib/clarify.ts` 的
   `pickAboveInput` 仲裁，永不叠）。

   需求里最要紧的一条：**每个选项下面要写清「因为 X，所以会有 Y」**（具体数字
   或事实，不是主观判断）—— 所以选项是两行：label 一行、effect 一行小字。
   内核那侧已经校验过 `effect` 是否「具体」（没数字也没量词会记警告），
   这边不再重复判断，只如实显示。

   三件事用户可以干：**选一个**（每题单选）、**补一句**（自由回答）、**跳过**
   （整个卡片跳过，Agent 自己拍板并在回复里说明理由）。
   ══════════════════════════════════════════════════════════════ */

export interface ClarifyCardProps {
  questions: readonly ClarifyQuestion[]
  onReply: (reply: ClarifyReply) => void
  /** 历史只读卡（批③）：只显示，不许点 */
  readOnly?: boolean
  /** 只读模式下已经答过的内容 */
  answered?: ClarifyReply | null
}

export function ClarifyCard({ questions, onReply, readOnly = false, answered }: ClarifyCardProps) {
  /** 问题 → 选中的选项 label */
  const [picked, setPicked] = useState<Record<string, string>>({})
  /** 问题 → 用户补的那句话 */
  const [notes, setNotes] = useState<Record<string, string>>({})

  const reply = (skipped: boolean): ClarifyReply => ({
    skipped,
    answers: questions.map((item) => ({
      question: item.question,
      choice: skipped ? '' : (picked[item.question] ?? ''),
      text: skipped ? '' : (notes[item.question] ?? '').trim(),
    })),
  })

  /* ── 只读（回看历史）：把当时选了什么标出来，选项都不可点 ── */
  if (readOnly) {
    const done = answered ?? { answers: [], skipped: false }
    return (
      <section
        className="mb-2 rounded-md border border-line-subtle bg-bg-raised/30 px-3 py-2"
        aria-label="当时问过的问题"
      >
        <p className="mb-1 flex items-center gap-1.5 text-2xs text-fg-tertiary">
          <CircleHelp size={11} />
          开工前问过这几个问题
          {done.skipped ? '（当时跳过了）' : ''}
        </p>
        {questions.map((item, index) => {
          const answer = done.answers.find((one) => one.question === item.question)
          const choice = answer?.choice ?? ''
          return (
            <div key={item.question} className="mt-1">
              <p className="text-2xs text-fg-secondary">
                {index + 1}. {item.question}
              </p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {item.options.map((option) => {
                  const chosen = option.label === choice
                  return (
                    <li
                      key={option.label}
                      className={cn('text-2xs', chosen ? 'text-fg-primary' : 'text-fg-tertiary')}
                    >
                      · {option.label}
                      {chosen ? '（已选）' : ''}
                      <span className="text-fg-tertiary"> —— {option.effect}</span>
                    </li>
                  )
                })}
              </ul>
              {answer?.text ? (
                <p className="mt-0.5 text-2xs text-fg-tertiary">他还补充：{answer.text}</p>
              ) : null}
            </div>
          )
        })}
      </section>
    )
  }

  return (
    <section
      className="mb-2 max-h-[min(46vh,420px)] overflow-auto rounded-md border border-line-focus bg-bg-raised shadow-low"
      aria-label="开工前先对齐"
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
          <h3 className="text-xs font-medium text-fg-primary">动手前先对齐一下</h3>
          <p className="mt-0.5 text-2xs leading-relaxed text-fg-secondary">
            答完它再开工。不想答就点「跳过」—— Agent 会自己拍板，并在回复里说明理由。
          </p>

          {questions.map((item, index) => (
            <div key={item.question} className="mt-2.5">
              <p className="text-xs text-fg-primary">
                {index + 1}. {item.question}
              </p>
              <div className="mt-1 flex flex-col gap-1">
                {item.options.map((option) => {
                  const chosen = picked[item.question] === option.label
                  return (
                    <button
                      key={option.label}
                      type="button"
                      aria-pressed={chosen}
                      onClick={() =>
                        setPicked((state) => ({ ...state, [item.question]: option.label }))
                      }
                      className={cn(
                        'rounded-sm border px-2 py-1 text-left transition-colors duration-fast',
                        chosen
                          ? 'border-line-focus bg-bg-hover'
                          : 'border-line-hairline hover:bg-bg-hover',
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-2xs text-fg-primary">
                        {chosen ? <Sparkles size={11} /> : null}
                        {option.label}
                        {/* 默认选项要看得见：用户离场时按它继续，他得知道是哪个 */}
                        {option.label === item.defaultValue ? (
                          <span className="text-fg-tertiary">
                            （没收到回答就按它来
                            {item.defaultFrom === 'first' ? '，AI 没标默认，取第一个' : ''}）
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-2xs text-fg-tertiary">
                        因为：{option.effect}
                      </span>
                    </button>
                  )
                })}
              </div>
              {item.allowFreeform ? (
                <input
                  type="text"
                  value={notes[item.question] ?? ''}
                  onChange={(event) =>
                    setNotes((state) => ({ ...state, [item.question]: event.target.value }))
                  }
                  placeholder="想补充点什么就写在这儿（可以只写这个、不选）"
                  aria-label={`补充：${item.question}`}
                  className="mt-1 w-full rounded-sm border border-line-hairline bg-bg-base/40 px-2 py-1 text-2xs text-fg-primary placeholder:text-fg-tertiary focus:border-line-focus focus:outline-none"
                />
              ) : null}
            </div>
          ))}

          <div className="mt-2.5 flex items-center justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => onReply(reply(true))}>
              跳过，你自己看着办
            </Button>
            <Button variant="primary" size="sm" onClick={() => onReply(reply(false))}>
              就这么干
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
