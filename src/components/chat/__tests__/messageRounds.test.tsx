import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRounds } from '../message/MessageRounds'
import type { MessageRound, ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   时间线排版：元素顺序必须是**发生顺序**

   三个聚合字段（reasoning / toolRuns / content）拼不出先后，
   所以这里钉住「按 rounds 的顺序排」这件事本身 —— 一旦有人改回
   「先全部思考、再全部工具、再全部正文」，这几条会红。

   测试用 act + createRoot，和本项目其它组件测试一致（不引 testing-library）。
   ══════════════════════════════════════════════════════════════ */

const runs: ToolRunRecord[] = [
  { id: 'r1', name: 'read_file', ok: true, output: '', ms: 12 },
  { id: 'r2', name: 'run_shell', ok: true, output: '', ms: 34 },
]

const rounds: MessageRound[] = [
  { reasoning: '先看一眼现状', content: '', tools: [0] },
  { reasoning: '', content: '第一段正文', tools: [] },
  { reasoning: '再想一下', content: '', tools: [1] },
  { reasoning: '', content: '第二段正文', tools: [] },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function draw(items: MessageRound[], streaming = false): HTMLElement {
  act(() => {
    root.render(<MessageRounds rounds={items} toolRuns={runs} streaming={streaming} />)
  })
  return host
}

function blocks(): HTMLElement[] {
  return [...host.querySelectorAll('[data-round]')] as HTMLElement[]
}

/** 这个块里有没有「思考过程」那个折叠按钮 */
function hasThink(el: HTMLElement): boolean {
  return [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('思考过程'))
}

describe('MessageRounds', () => {
  it('★ 一轮一个块，顺序就是轮次顺序', () => {
    draw(rounds)
    expect(blocks()).toHaveLength(4)
  })

  it('★ 每轮只装它自己那几样（不是三段堆叠）', () => {
    draw(rounds)
    const list = blocks()

    /* 第 1 轮：思考 + 工具，正文为空 → 不该有正文 */
    expect(hasThink(list[0])).toBe(true)
    expect(list[0].textContent).not.toContain('第一段正文')

    /* 第 2 轮：只有正文 */
    expect(list[1].textContent).toContain('第一段正文')
    expect(hasThink(list[1])).toBe(false)

    /* 第 3 轮：又是思考 + 工具 */
    expect(hasThink(list[2])).toBe(true)
  })

  it('★ 正文的先后顺序 = 轮次顺序（以前会被拼成一个串）', () => {
    const el = draw(rounds)
    const text = el.textContent ?? ''
    expect(text.indexOf('第一段正文')).toBeGreaterThan(-1)
    expect(text.indexOf('第一段正文')).toBeLessThan(text.indexOf('第二段正文'))
  })

  it('「正在思考…」只属于最后一轮（前面的轮次已经写完了）', () => {
    const el = draw(rounds, true)
    /* 最后一轮没有思考 → 整个时间线不该出现「正在思考」 */
    expect(el.textContent).not.toContain('正在思考')
    expect(hasThink(blocks()[0])).toBe(true)
  })

  it('工具下标越界不炸（落盘与读回之间版本不一致时）', () => {
    const el = draw([{ reasoning: '', content: '正文', tools: [99] }])
    expect(el.textContent).toContain('正文')
  })

  it('空字符串不算一段（不留空白块）', () => {
    const el = draw([{ reasoning: '   ', content: '', tools: [] }])
    expect((el.textContent ?? '').trim()).toBe('')
  })
})
