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

/** 这个块里有没有「思考过程」那个折叠按钮 */
function hasThink(el: HTMLElement): boolean {
  return [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('思考过程'))
}

describe('MessageRounds', () => {
  /*
   * ★ 2026-10-21 改口径：跑完之后**过程收进折叠区**，正文直接显示。
   *
   * 旧断言（「一轮一个块、`[data-round]` 数等于轮数」「思考按钮在哪个块里」）
   * 钉的是「全平铺」那个结构 —— 而那正是长任务要滚过几十行才看到结论的原因。
   * 现在：
   *   · 过程（思考 + 工具）在 `[data-process-open]` 里，默认收起时**不在 DOM 里**
   *   · 正文在 `[data-round-body]` 里，永远可见
   *   · 流式中**不平铺也不折叠**地保持原样（要看见现在在干什么）
   */
  it('★★★ 跑完之后过程收起：默认只有「查看过程」入口 + 正文', () => {
    draw(rounds)
    /* 入口在，且标了 aria-expanded=false（默认收起） */
    const entry = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.includes('查看过程') || b.textContent?.match(/\d+ 个步骤/),
    )
    expect(entry).toBeTruthy()
    expect(entry?.getAttribute('aria-expanded')).toBe('false')
    /* 折叠时过程不在 DOM 里 —— 用户看不到思考与工具行 */
    expect(host.querySelector('[data-process-open]')).toBeNull()
    expect(host.textContent).not.toContain('思考过程')
  })

  it('★★★ 正文不受折叠影响：一直可见、顺序不变', () => {
    const el = draw(rounds)
    const text = el.textContent ?? ''
    expect(text.indexOf('第一段正文')).toBeGreaterThan(-1)
    expect(text.indexOf('第一段正文')).toBeLessThan(text.indexOf('第二段正文'))
    /* 正文有自己的锚点，与过程区分开 */
    expect(host.querySelectorAll('[data-round-body]').length).toBeGreaterThan(0)
  })

  it('★★ 纯问答（没有思考也没有工具）不显示空的「查看过程」入口', () => {
    draw([{ reasoning: '', content: '只有一段正文', tools: [] }])
    expect(host.textContent).toContain('只有一段正文')
    const entry = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('查看过程'),
    )
    expect(entry).toBeUndefined()
  })

  it('★★★ 流式中也收起：入口写「实时任务」，过程不在外面', () => {
    draw(rounds, true)
    const entry = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('实时任务'),
    )
    expect(entry).toBeTruthy()
    expect(entry?.getAttribute('aria-expanded')).toBe('false')
    /* 收起 = 过程不在 DOM 里；思考与工具要点开才看得见 */
    expect(host.querySelector('[data-process-open]')).toBeNull()
  })

  it('★★★ 流式中入口不报步骤数（会随事件一直跳字）', () => {
    draw(rounds, true)
    const entry = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('实时任务'),
    )
    expect(entry?.textContent).not.toMatch(/个步骤/)
  })

  it('★★★ 流式中点开入口：思考与工具照常出现（不是变没了）', () => {
    draw(rounds, true)
    const entry = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('实时任务'),
    )
    act(() => entry?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(host.querySelector('[data-process-open]')).toBeTruthy()
    expect(hasThink(host)).toBe(true)
  })

  it('★★★ 一轮都没结束（刚发送）也有入口，展开里是「现在在干什么」', () => {
    draw([], true)
    const entry = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('实时任务'),
    )
    expect(entry).toBeTruthy()
    act(() => entry?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    /* 空时间线时活动行就是展开区唯一的内容（验收表第一行） */
    expect(host.querySelector('[data-live-activity]')).toBeTruthy()
  })

  it('「正在思考…」只属于最后一轮（前面的轮次已经写完了）', () => {
    const el = draw(rounds, true)
    /* 最后一轮没有思考 → 整个时间线不该出现「正在思考」 */
    expect(el.textContent).not.toContain('正在思考')
  })

  it('工具下标越界不炸（落盘与读回之间版本不一致时）', () => {
    const el = draw([{ reasoning: '', content: '正文', tools: [99] }])
    expect(el.textContent).toContain('正文')
  })

  it('空字符串不算一段（不留空白块）', () => {
    const el = draw([{ reasoning: '   ', content: '', tools: [] }])
    expect((el.textContent ?? '').trim()).toBe('')
  })

  /* ── streamOutput 开关（`assistant.streamOutput`） ──────────
     关掉时「正文不逐字蹦」：过程和工具照旧实时出现，只有答案本身等写完再显示。
     默认（不传）必须还是老行为 —— 这是绝大多数人用的那条路。 */
  function drawHidden(content: string, streaming: boolean): HTMLElement {
    act(() => {
      root.render(
        <MessageRounds
          rounds={[{ reasoning: '想过', content, tools: [] }]}
          toolRuns={runs}
          streaming={streaming}
          hideStreamingContent
        />,
      )
    })
    return host
  }

  it('★ 关掉流式输出：流式中不显示正文，只提示「正在写回答…」', () => {
    const el = drawHidden('写了一半', true)
    expect(el.textContent).not.toContain('写了一半')
    expect(el.textContent).toContain('正在写回答')
    /*
     * 过程照旧看得见 —— 别把「不生字」做成「什么都看不到」。
     * 但从 2026-10-21 起流式中也默认收起，所以先点开入口再断言（不是不显示）。
     */
    const entry = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('实时任务'),
    )
    act(() => entry?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(hasThink(el)).toBe(true)
  })

  it('★ 关掉流式输出：写完（streaming=false）正文照常出来', () => {
    const el = drawHidden('写完了', false)
    expect(el.textContent).toContain('写完了')
    expect(el.textContent).not.toContain('正在写回答')
  })

  it('默认（开着流式输出）：流式中就逐字显示，行为不变', () => {
    const el = draw([{ reasoning: '', content: '写了一半', tools: [] }], true)
    expect(el.textContent).toContain('写了一半')
  })
})
