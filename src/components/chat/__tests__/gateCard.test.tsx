import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClarifyQuestion, ClarifyReply } from '@/types'
import { GateCard } from '../GateCard'

/* ══════════════════════════════════════════════════════════════
   A 闸门卡（2026-10-07，真渲染）

   为什么单列一张卡：gate 卡和澄清卡**共用同一个组件**时，底部固定四个出口，
   但对 gate 卡，「跳过，你自己看着办」「换个说法」的**真实后果都是停手**
   （内核只认 label === 「就按这个计划执行」才放行）—— 措辞与后果相反。
   这里钉住：gate 卡**只有两个按钮**，且就是内核给的那两个选项。
   ══════════════════════════════════════════════════════════════ */

const questions: ClarifyQuestion[] = [
  {
    question: '就按上面这个计划动手吗？',
    options: [
      { label: '就按这个计划执行', effect: '现在开始动手（按上面列的那几个文件和改法）' },
      { label: '先别动，我再看看', effect: '这一轮到此为止，一个文件都不改' },
    ],
    allowFreeform: true,
    defaultValue: '先别动，我再看看',
    defaultFrom: 'model',
  },
]

let container: HTMLDivElement
let root: Root
const replies: ClarifyReply[] = []

function draw(): void {
  act(() =>
    root.render(<GateCard questions={questions} onReply={(reply) => replies.push(reply)} />),
  )
}

const buttons = (): HTMLElement[] => [...container.querySelectorAll('button')]

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

describe('A 闸门卡', () => {
  it('★ 只出两个按钮，就是内核给的两个选项（没有「跳过 / 换个说法 / 先不做了」）', () => {
    draw()
    expect(buttons()).toHaveLength(2)
    expect(buttons()[0]?.textContent).toContain('就按这个计划执行')
    expect(buttons()[1]?.textContent).toContain('先别动')
    expect(container.textContent).not.toContain('跳过')
    expect(container.textContent).not.toContain('换个说法')
    expect(container.textContent).not.toContain('先不做了')
  })

  it('★ 点「执行」→ 回传的 choice 就是那个 label（内核按 label 判放行）', () => {
    draw()
    act(() => buttons()[0]?.click())
    expect(replies.at(-1)?.skipped).toBe(false)
    expect(replies.at(-1)?.answers[0]?.choice).toBe('就按这个计划执行')
  })

  it('★ 点「先别动」→ choice = 那个 label（内核判为「没批准」停手）', () => {
    draw()
    act(() => buttons()[1]?.click())
    expect(replies.at(-1)?.answers[0]?.choice).toBe('先别动，我再看看')
  })

  it('每个选项的「因为 X 所以 Y」显示出来', () => {
    draw()
    expect(container.textContent).toContain('一个文件都不改')
    expect(container.textContent).toContain('现在开始动手')
  })
})
