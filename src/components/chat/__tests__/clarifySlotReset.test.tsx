import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClarifyQuestion } from '@/types'
import { useUIStore } from '@/stores/useUIStore'
import { ClarifySlot } from '../ClarifySlot'

/* ══════════════════════════════════════════════════════════════
   换一张澄清卡 = 换一个组件实例（2026-10-04，小尾巴 #3）

   卡片自己的勾选/补充是 `useState`。上一张卡答了一半，主进程又推来下一张时，
   如果 `ClarifySlot` 不换 key，React 会复用同一个实例 → 新卡继承旧卡的 picked/notes。
   最难看的情形是**两轮问了同样的问题文本**：拿问题文本当 key 等于没换 key，
   用户会看到上一轮的答案已经「选好了」。

   这里钉的就是这件事：同一个问题文本、不同 confirmId，勾选不许串。
   ══════════════════════════════════════════════════════════════ */

const QUESTION_TEXT = '用哪个包管理器？'

const first: ClarifyQuestion[] = [
  {
    question: QUESTION_TEXT,
    options: [
      { label: 'pnpm', effect: 'A' },
      { label: 'npm', effect: 'B' },
    ],
    allowFreeform: false,
    defaultValue: 'pnpm',
    defaultFrom: 'model',
  },
]

const second: ClarifyQuestion[] = [
  {
    question: QUESTION_TEXT,
    options: [
      { label: 'yarn', effect: 'C' },
      { label: 'bun', effect: 'D' },
    ],
    allowFreeform: false,
    defaultValue: 'yarn',
    defaultFrom: 'model',
  },
]

let container: HTMLDivElement
let root: Root

const draw = () => act(() => root.render(<ClarifySlot />))
const buttonByText = (text: string): HTMLElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text))
const ask = (confirmId: string, clarify: ClarifyQuestion[]) =>
  act(() => {
    useUIStore.setState({
      clarify: {
        kind: 'clarify',
        confirmId,
        title: 't',
        description: '',
        confirmText: '',
        danger: false,
        clarify,
      },
    })
  })

const pressed = () =>
  [...container.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent ?? '')

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useUIStore.setState({ clarify: null })
})

describe('澄清卡更换时不许串味', () => {
  it('★ 勾过的选项不会带到下一张卡（同一个问题文本也一样）', () => {
    ask('clr_1', first)
    draw()
    const pnpm = buttonByText('pnpm')
    expect(pnpm).toBeTruthy()
    act(() => pnpm?.click())
    /* 勾上了：那个选项带着 aria-pressed=true（单选时问题不会收起，所以不看「已选…」那行） */
    expect(pressed().join('')).toContain('pnpm')

    ask('clr_2', second)
    draw()
    /* 新卡必须是干净的：一个勾都没有，新选项都在 */
    expect(pressed().length).toBe(0)
    expect(buttonByText('yarn')).toBeTruthy()
    expect(container.textContent).not.toContain('已选')
  })

  it('补充说明里的字也不会跟过去', () => {
    ask('clr_3', first)
    draw()
    const note = container.querySelector('textarea')
    if (note) {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(note, '上一张卡里写的话')
        note.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect((note as HTMLTextAreaElement).value).toBe('上一张卡里写的话')
    }
    ask('clr_4', second)
    draw()
    const next = container.querySelector('textarea') as HTMLTextAreaElement | null
    expect(next?.value ?? '').toBe('')
  })

  it('同一个 confirmId 重复渲染不会把用户答了一半的东西清掉', () => {
    ask('clr_5', first)
    draw()
    act(() => buttonByText('npm')?.click())
    expect(pressed().join('')).toContain('npm')
    /* 同一张卡（比如上面又推了一次同样的状态）—— 必须保持 */
    ask('clr_5', first)
    draw()
    expect(pressed().join('')).toContain('npm')
  })

  it('没有澄清请求时不渲染任何东西', () => {
    useUIStore.setState({ clarify: null })
    draw()
    expect(container.textContent).toBe('')
  })
})
