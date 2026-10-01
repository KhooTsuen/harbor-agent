import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClarifyQuestion, ClarifyReply } from '@/types'
import { ClarifyCard } from '../ClarifyCard'

/* ══════════════════════════════════════════════════════════════
   开工前澄清卡（AG-053，真渲染）

   需求里最要紧的一条：**每个选项下面写清「因为 X，所以会有 Y」**。
   所以这里钉的不只是「点得动」，还有：
     · effect 必须显示出来（不然用户没法判断）
     · 默认选项要标出来（用户离场时按它继续，他得知道是哪个）
     · 可以只写补充不选选项（「可以自由回答、补充想法」）
     · 跳过 ≠ 开始执行：跳过的回执 `skipped: true`，答案一律为空
     · 只读模式（回看历史）：**一个都点不动**，但能看到当时选了什么
   ══════════════════════════════════════════════════════════════ */

const questions: ClarifyQuestion[] = [
  {
    question: '用哪个包管理器？',
    options: [
      { label: 'pnpm', effect: '仓库里有 pnpm-lock.yaml，换 npm 会多装 1 份依赖' },
      { label: 'npm', effect: '要重新生成 lock 文件，多花约 30 秒' },
    ],
    allowFreeform: true,
    defaultValue: 'pnpm',
    defaultFrom: 'model',
  },
  {
    question: '要不要顺手跑一遍测试？',
    options: [{ label: '跑', effect: '多花约 40 秒，能提前发现改坏' }],
    allowFreeform: false,
    defaultValue: '跑',
    defaultFrom: 'first',
  },
]

let container: HTMLDivElement
let root: Root
const replies: ClarifyReply[] = []

function draw(props: Partial<Parameters<typeof ClarifyCard>[0]> = {}): void {
  act(() =>
    root.render(
      <ClarifyCard questions={questions} onReply={(reply) => replies.push(reply)} {...props} />,
    ),
  )
}

const buttonByText = (text: string): HTMLElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text))

beforeEach(() => {
  replies.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('卡片上必须看得见的东西', () => {
  it('★ 每个选项都带「因为…」（需求原话：写清因为 X 所以 Y）', () => {
    draw()
    expect(container.textContent).toContain('因为：仓库里有 pnpm-lock.yaml，换 npm 会多装 1 份依赖')
    expect(container.textContent).toContain('因为：要重新生成 lock 文件，多花约 30 秒')
  })

  it('★ 默认选项标出来（离场时按它继续，用户得知道是哪个）', () => {
    draw()
    expect(container.textContent).toContain('没收到回答就按它来')
  })

  it('模型没标默认时如实说（不假装是模型选的）', () => {
    draw()
    expect(container.textContent).toContain('AI 没标默认，取第一个')
  })

  it('允许自由回答的题才有输入框（不允许的不给）', () => {
    draw()
    const inputs = container.querySelectorAll('input[type="text"]')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.getAttribute('aria-label')).toContain('用哪个包管理器？')
  })
})

describe('答完之后回什么', () => {
  it('★ 选了选项 → 回执带上 question 与 choice', () => {
    draw()
    act(() => buttonByText('pnpm')?.click())
    act(() => buttonByText('就这么干')?.click())
    expect(replies).toHaveLength(1)
    expect(replies[0]?.skipped).toBe(false)
    const first = replies[0]?.answers[0]
    expect(first?.question).toBe('用哪个包管理器？')
    expect(first?.choice).toBe('pnpm')
  })

  it('★ 可以只写补充、不选选项（自由回答）', () => {
    draw()
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    /*
     * 受控 input 要用**原生 value setter** 再派发 input 事件，React 才认这次改动
     * （直接 `input.value = x` 会被 React 的受控层丢掉 —— 这条踩过）。
     */
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      if (input && setValue) {
        setValue.call(input, '其实用 yarn 也行')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    act(() => buttonByText('就这么干')?.click())
    expect(replies[0]?.answers[0]?.choice).toBe('')
    expect(replies[0]?.answers[0]?.text).toBe('其实用 yarn 也行')
  })

  it('★ 跳过 → skipped=true 且答案清空（跟「答了」是两条路）', () => {
    draw()
    act(() => buttonByText('pnpm')?.click())
    act(() => buttonByText('跳过')?.click())
    expect(replies[0]?.skipped).toBe(true)
    expect(replies[0]?.answers.every((one) => one.choice === '' && one.text === '')).toBe(true)
  })

  it('没答的题也回一条空答复（内核要对齐每一问）', () => {
    draw()
    act(() => buttonByText('就这么干')?.click())
    expect(replies[0]?.answers).toHaveLength(2)
    expect(replies[0]?.answers[1]?.choice).toBe('')
  })
})

describe('只读卡（回看历史）', () => {
  it('★ 一个都点不动（不是「点了没反应」，是根本没有可点的选项）', () => {
    draw({
      readOnly: true,
      answered: {
        skipped: false,
        answers: [{ question: '用哪个包管理器？', choice: 'npm', text: '我习惯 npm' }],
      },
    })
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('input')).toHaveLength(0)
  })

  it('★ 看得出当时选了什么、为什么、以及他的补充', () => {
    draw({
      readOnly: true,
      answered: {
        skipped: false,
        answers: [{ question: '用哪个包管理器？', choice: 'npm', text: '我习惯 npm' }],
      },
    })
    expect(container.textContent).toContain('npm（已选）')
    expect(container.textContent).toContain('多花约 30 秒')
    expect(container.textContent).toContain('他还补充：我习惯 npm')
  })

  it('当时跳过的，也说一句（不然回看像漏答了）', () => {
    draw({ readOnly: true, answered: { skipped: true, answers: [] } })
    expect(container.textContent).toContain('当时跳过了')
  })

  /* ── 自动采纳（AG-053 批③） ────────────────────────────────
     超时 / 无人值守这两种**没人点头**的情况，回看时必须说清：
     标的是「默认」而不是「已选」—— 不然用户会以为那是他自己挑的。 */
  it('★ 超时自动采纳：说清「你当时不在」，标的是（默认）不是（已选）', () => {
    draw({ readOnly: true, answered: { skipped: true, answers: [] }, auto: 'timeout' })
    const text = container.textContent ?? ''
    expect(text).toContain('你当时不在')
    expect(text).toContain('pnpm（默认）')
    /* 不能同时说「他选了」、也不能说「他跳过了」——两件事他都没做 */
    expect(text).not.toContain('（已选）')
    expect(text).not.toContain('当时跳过了')
  })

  it('★ 无人值守（定时任务）：说清「没人在场」', () => {
    draw({ readOnly: true, answered: { skipped: true, answers: [] }, auto: 'unattended' })
    const text = container.textContent ?? ''
    expect(text).toContain('定时任务')
    expect(text).toContain('pnpm（默认）')
  })

  it('两个问题的默认选项各自标出来（不是只标第一个）', () => {
    draw({ readOnly: true, answered: { skipped: true, answers: [] }, auto: 'timeout' })
    expect(container.textContent).toContain('跑（默认）')
  })
})
