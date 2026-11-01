import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRounds } from '../message/MessageRounds'
import { WAITING_MODEL_LABEL } from '@/lib/agentActivity'
import { PROCESS_RUNNING_LABEL } from '@/lib/processSummary'
import type { MessageRound, ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   过程区：用户给的六类场景逐条钉住（2026-10-21）

   验收表里那六行不是「看起来对」就算过的 —— 每一行都有一个
   **会悄悄变错**的点：

     · 刚发送：入口要有，且展开能看到「正在等待模型回应…」
     · 运行中：入口恒为「实时任务」，不许出现步骤数 / 秒数（会一直跳字）
     · 正常完成：步骤数一次性算出来，过程完整、正文独立
     · 无过程：连入口都不许出现（纯问答不该有空的「查看过程」）
     · 停止：写「已中断」，过程默认可见，正文仍在（标明未完成在 MessageItem）
     · 失败：写「失败 · N 个步骤」，过程默认可见
     · 重开历史：入口只读持久化字段，同样的记录渲染两次必须一模一样
   ══════════════════════════════════════════════════════════════ */

const runs = (n: number): ToolRunRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    name: 'read_file',
    ok: true,
    output: 'ok',
    ms: 12,
    summary: `f${i}.ts`,
  }))

/** 33 步的长任务：一轮里连续调 33 次，最后一轮出正文 */
const longRounds: MessageRound[] = [
  { reasoning: '先看现状', content: '', tools: Array.from({ length: 33 }, (_, i) => i) },
  { reasoning: '', content: '这是最终回答。', tools: [] },
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

function draw(
  roundList: MessageRound[],
  opts: { toolRuns?: ToolRunRecord[]; streaming?: boolean; message?: object } = {},
): HTMLElement {
  act(() => {
    root.render(
      <MessageRounds
        rounds={roundList}
        toolRuns={opts.toolRuns ?? []}
        streaming={opts.streaming ?? false}
        message={opts.message as never}
      />,
    )
  })
  return host
}

/** 入口按钮（唯一那颗 aria-label="查看过程"） */
const entryOf = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>('button[aria-label="查看过程"]')

/** 点开/收起入口 */
function toggle(el: HTMLElement): void {
  act(() => entryOf(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('场景一：刚发送、等模型', () => {
  it('★★★ 入口就在（「实时任务」），展开能看到「正在等待模型回应…」', () => {
    const el = draw([], { streaming: true })
    expect(entryOf(el)?.textContent).toBe(PROCESS_RUNNING_LABEL)
    /* 收起时活动不露在外面 —— 它属于展开区 */
    expect(el.textContent).not.toContain(WAITING_MODEL_LABEL)
    toggle(el)
    expect(el.querySelector('[data-process-open]')).toBeTruthy()
    expect(el.textContent).toContain(WAITING_MODEL_LABEL)
  })
})

describe('场景二：正在思考 / 调工具', () => {
  it('★★★ 入口仍是「实时任务」，一个计数都不报', () => {
    const el = draw([{ reasoning: '想想', content: '', tools: [0, 1] }], {
      toolRuns: runs(2),
      streaming: true,
    })
    const text = entryOf(el)?.textContent ?? ''
    expect(text).toBe(PROCESS_RUNNING_LABEL)
    expect(text).not.toMatch(/步骤|字|秒|分/)
  })

  it('★★ 展开里能看到正在跑的工具（说清在干什么，不是一句「正在处理」）', () => {
    const busy: ToolRunRecord[] = [{ id: 'b', name: 'read_file', ok: true, output: '' }]
    const el = draw([{ reasoning: '', content: '', tools: [0] }], {
      toolRuns: busy,
      streaming: true,
    })
    toggle(el)
    expect(el.textContent).toContain('正在读取')
  })
})

describe('场景三：运行中收起后又展开', () => {
  it('★★★ 入口始终是「实时任务」；重新展开仍然按发生顺序、不重复', () => {
    const el = draw(longRounds, { toolRuns: runs(33), streaming: true })
    expect(entryOf(el)?.textContent).toBe(PROCESS_RUNNING_LABEL)
    toggle(el)
    toggle(el)
    expect(el.querySelector('[data-process-open]')).toBeNull()
    toggle(el)

    const order = [...el.querySelectorAll('[data-round]')].map((n) =>
      Number(n.getAttribute('data-round')),
    )
    /* 顺序不减（乱序会破坏「这段在干什么」的时间感） */
    expect(order).toEqual([...order].sort((a, b) => a - b))
    /* 同一轮不重复出现 */
    expect(new Set(order).size).toBe(order.length)
  })
})

describe('场景四：正常完成（33 个步骤）', () => {
  it('★★★ 入口写「33 个步骤」，收起时过程不在外面', () => {
    const el = draw(longRounds, { toolRuns: runs(33), message: { durationMs: 31_000 } })
    expect(entryOf(el)?.textContent).toBe('33 个步骤')
    expect(el.querySelector('[data-process-open]')).toBeNull()
    /* 正文独立显示（不因过程收起而消失） */
    expect(el.textContent).toContain('这是最终回答。')
  })

  it('★★★ 展开后过程完整、用时在展开区第一行', () => {
    const el = draw(longRounds, { toolRuns: runs(33), message: { durationMs: 31_000 } })
    toggle(el)
    expect(el.querySelector('[data-process-elapsed]')?.textContent).toContain('用时 31 秒')
    expect(el.querySelectorAll('[data-round]').length).toBeGreaterThan(0)
    expect(el.textContent).toContain('读取 33 个文件')
  })
})

describe('场景五：完成、但没有过程', () => {
  it('★★★ 不显示空入口，直接给最终回答', () => {
    const el = draw([{ reasoning: '', content: '只有结论', tools: [] }], {
      message: { durationMs: 3_000 },
    })
    expect(entryOf(el)).toBeNull()
    expect(el.textContent).toContain('只有结论')
  })
})

describe('场景六：用户点停止 / 执行失败', () => {
  it('★★★ 停止：入口写「已中断」，过程默认可见，正文不丢', () => {
    const el = draw(longRounds, {
      toolRuns: runs(5),
      message: { interrupted: true, durationMs: 12_000 },
    })
    expect(entryOf(el)?.textContent).toBe('已中断')
    /* 失败 / 中断不能被默认折叠 —— 过程一眼可见 */
    expect(el.querySelector('[data-process-open]')).toBeTruthy()
    expect(el.textContent).toContain('这是最终回答。')
  })

  it('★★★ 失败：入口写「失败 · N 个步骤」，失败那一步的原因可见', () => {
    const bad: ToolRunRecord[] = [
      { id: 'a', name: 'read_file', ok: true, output: 'ok', ms: 3 },
      { id: 'b', name: 'run_shell', ok: false, output: '退出码 1：找不到命令', ms: 9 },
    ]
    const el = draw([{ reasoning: '', content: '', tools: [0, 1] }], {
      toolRuns: bad,
      message: { status: 'error' },
    })
    expect(entryOf(el)?.textContent).toBe('失败 · 2 个步骤')
    expect(el.querySelector('[data-process-open]')).toBeTruthy()
    /* 真实错误要说出来（只画红叉等于把「为什么失败」丢了） */
    expect(el.textContent).toContain('找不到命令')
  })
})

describe('场景七：重开历史对话', () => {
  it('★★★ 同样的记录渲染两次，入口一字不差（不重算、不换个说法）', () => {
    const props = { toolRuns: runs(33), message: { durationMs: 31_000 } }
    const first = draw(longRounds, props)
    const a = entryOf(first)?.textContent
    const second = draw(longRounds, props)
    expect(entryOf(second)?.textContent).toBe(a)
  })

  it('★★ 老记录没有 durationMs → 只说步骤数，不编造秒数', () => {
    const el = draw(longRounds, { toolRuns: runs(33), message: {} })
    const text = entryOf(el)?.textContent ?? ''
    expect(text).toBe('33 个步骤')
    expect(text).not.toMatch(/秒|分/)
  })
})
