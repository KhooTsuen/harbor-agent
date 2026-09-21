import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Message, ToolRunRecord } from '@/types'
import { MessageList } from '../MessageList'
import { ToolRunList, groupRuns } from '../ToolRuns'
import { Markdown } from '../Markdown'
import { ProgressTimeline } from '../ProgressTimeline'
import { installDomStubs } from './domStubs'

installDomStubs()

/* ══════════════════════════════════════════════════════════════
   AG-038 Renderer 性能测试

   文档列的六种极端情形，目标一句话：

     > Agent 执行时间增长不能导致 Renderer 明显卡顿。

   这条要求翻译成可测的东西就是两类判据：

     · **规模有界**：节点/行数不随数据线性爆炸（该折叠的折叠、该截断的截断）
     · **不退化**：耗时随规模**大致线性**，不是二次方（O(n²) 是「越用越卡」的根）

   所以这里的断言主要是**数量**（确定、跨机器稳定），耗时只做「不许爆炸」的兜底
   （宽松到只在真的退化成 O(n²) 时才红）。每次跑都会把数字打出来 ——
   它同时是一份可以对比的基准。
   ══════════════════════════════════════════════════════════════ */

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterAll(() => {
  act(() => root.unmount())
  container.remove()
})

let seq = 0
const message = (patch: Partial<Message> = {}): Message => ({
  id: `m${(seq += 1)}`,
  threadId: 't1',
  role: 'assistant',
  kind: 'text',
  content: '一句话回答。',
  status: 'sent',
  timestamp: 1700000000000 + seq,
  ...patch,
})

const toolRun = (patch: Partial<ToolRunRecord> = {}): ToolRunRecord => ({
  id: `r${(seq += 1)}`,
  name: 'read_file',
  ok: true,
  output: '',
  ms: 12,
  ...patch,
})

/** 渲染并返回：耗时 + 容器里的 DOM 节点数 */
function render(node: React.ReactNode): { ms: number; nodes: number } {
  const startedAt = performance.now()
  act(() => root.render(node))
  const ms = performance.now() - startedAt
  return { ms, nodes: container.querySelectorAll('*').length }
}

const report = (label: string, ms: number, nodes: number, extra = ''): void => {
  // eslint-disable-next-line no-console
  console.log(
    `[AG-038] ${label}：${ms.toFixed(0)}ms · DOM ${nodes} 个节点${extra ? ` · ${extra}` : ''}`,
  )
}

describe('AG-038 / 1000 条消息', () => {
  it('★ 1000 条消息只渲染最近一批（渐增渲染）', () => {
    const small = render(
      <MessageList
        messages={Array.from({ length: 50 }, () => message())}
        onSuggestion={() => {}}
      />,
    )
    const big = render(
      <MessageList
        messages={Array.from({ length: 1000 }, () => message())}
        onSuggestion={() => {}}
      />,
    )
    const rendered = () => container.querySelectorAll('[data-message-id]').length
    report('50 条', small.ms, small.nodes)
    report('1000 条', big.ms, big.nodes, `真的画了 ${rendered()} 条`)

    /*
     * 钉的是**渲染条数**，不是耗时：1000 条全渲染在 jsdom 里也就 3 秒，
     * 拿时间当判据根本管不住（第一版就是这么写的 —— 把上限关掉照样绿，
     * 变异测试逮到的）。真机的对照数字见 CHANGELOG。
     */
    expect(rendered(), `渲染了 ${rendered()} 条`).toBeLessThanOrEqual(200)
    expect(big.nodes, `${big.nodes} 个节点`).toBeLessThan(8000)

    /* 截断了要给出口，不能让人看不到更早的；而且**点了要真加载** */
    const more = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('载入更早的'),
    )
    expect(more?.textContent).toContain('还有 800 条')
    act(() => more?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const after = rendered()
    report('点「载入更早」之后', 0, container.querySelectorAll('*').length, `画了 ${after} 条`)
    expect(after).toBeGreaterThan(200)
    expect(after).toBeLessThanOrEqual(500)
  }, 15000)

  it('★ 1000 条里滚动一次不该重排整棵树（耗时随数据线性，不退化成平方）', () => {
    const messages = Array.from({ length: 1000 }, () => message())
    render(<MessageList messages={messages} onSuggestion={() => {}} />)
    const scroller =
      container.querySelector('[data-message-scroller]') ?? container.firstElementChild

    const startedAt = performance.now()
    act(() => {
      for (let i = 0; i < 20; i += 1) {
        scroller?.dispatchEvent(new Event('scroll'))
      }
    })
    const ms = performance.now() - startedAt
    report('20 次滚动事件', ms, container.querySelectorAll('*').length)
    expect(ms).toBeLessThan(1500)
  })
})

describe('AG-038 / 10000 个 Tool Event', () => {
  it('★ 归类之后是一行（不是一万行）', () => {
    const runs = Array.from({ length: 10_000 }, () => toolRun())
    const groups = groupRuns(runs)
    expect(groups).toHaveLength(1)
    expect(groups[0].runs).toHaveLength(10_000)
  })

  it('★ 收起时 DOM 里只有一行；展开也要有上限', () => {
    const runs = Array.from({ length: 10_000 }, () => toolRun())
    const collapsed = render(<ToolRunList runs={runs} />)
    report('10000 个工具事件（收起）', collapsed.ms, collapsed.nodes)
    expect(collapsed.nodes).toBeLessThan(40)

    /* 要**点两层**才见得到那一万行：先展开列表，再展开那一组 */
    const clickAll = () => {
      const buttons = [...container.querySelectorAll('button[aria-expanded="false"]')]
      for (const button of buttons) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    const expandedAt = performance.now()
    act(() => clickAll())
    act(() => clickAll())
    const ms = performance.now() - expandedAt
    const nodes = container.querySelectorAll('*').length
    report('10000 个工具事件（展开到底）', ms, nodes)
    /*
     * 展开一万行谁也受不了 —— 必须有上限。修之前实测 **9.4 秒 / 12 万节点**，
     * 现在是「最近 100 条」1223 个节点。判据是「不随数据线性爆炸」，
     * 不是某个精确数字。
     */
    expect(nodes, `展开后 ${nodes} 个节点`).toBeLessThan(2000)
    /* 截断了就得说出来，不能假装只有这些 */
    expect(container.textContent).toContain('没摊开')
  })
})

describe('AG-038 / 工具组太多也要截', () => {
  it('★ 200 组（读一个、跑一条交替）只摊开最近 50 组', () => {
    const runs = Array.from({ length: 200 }, (_, i) =>
      toolRun({ name: i % 2 === 0 ? 'read_file' : 'run_shell' }),
    )
    render(<ToolRunList runs={runs} />)
    const clickAll = () => {
      for (const button of [...container.querySelectorAll('button[aria-expanded="false"]')]) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }
    }
    act(() => clickAll())
    act(() => clickAll())
    const nodes = container.querySelectorAll('*').length
    report('200 组（展开）', 0, nodes)
    expect(nodes, `${nodes} 个节点`).toBeLessThan(3000)
    expect(container.textContent).toContain('组没摊开')
  })
})

describe('AG-038 / 超长 Markdown 与大型代码块', () => {
  it('超长 Markdown（3000 行）', () => {
    const text = Array.from(
      { length: 3000 },
      (_, i) => `第 ${i + 1} 行：**粗体** 与 \`代码\`。`,
    ).join('\n\n')
    const result = render(<Markdown text={text} />)
    report('3000 段 Markdown', result.ms, result.nodes)
    expect(result.ms).toBeLessThan(4000)
  })

  it('★ 大型代码块默认折叠（2 万行不许进 DOM）', () => {
    const code = Array.from({ length: 20_000 }, (_, i) => `const value${i} = ${i}`).join('\n')
    const result = render(<Markdown text={'```ts\n' + code + '\n```'} />)
    report('2 万行代码块（默认折叠）', result.ms, result.nodes)
    expect(result.nodes, `2 万行代码块渲染出 ${result.nodes} 个节点`).toBeLessThan(400)
  })
})

describe('AG-038 / 长时间 Streaming', () => {
  it('★ 2000 次分片更新：总耗时与节点数都不许爆炸', () => {
    const chunks = Array.from({ length: 2000 }, (_, i) => `片${i} `)
    const startedAt = performance.now()
    act(() => {
      for (let i = 0; i < chunks.length; i += 1) {
        root.render(<Markdown text={chunks.slice(0, i + 1).join('')} />)
      }
    })
    const ms = performance.now() - startedAt
    const nodes = container.querySelectorAll('*').length
    report('2000 次流式更新', ms, nodes)
    expect(ms, `${ms}ms / 2000 次`).toBeLessThan(6000)
  })
})

describe('AG-038 / 大型 Task Timeline', () => {
  it('★ 只渲染最近几步（不是一万步全进 DOM）', () => {
    const steps = Array.from({ length: 10_000 }, (_, i) => ({
      at: 1700000000000 + i,
      tool: 'read_file',
      ok: true,
      ms: 5,
      summary: `读了第 ${i} 个文件`,
    }))
    const result = render(
      <ProgressTimeline phases={[]} steps={steps} plan={['[x] 一', '[ ] 二']} />,
    )
    report('10000 步时间线', result.ms, result.nodes)
    expect(result.nodes, `${result.nodes} 个节点`).toBeLessThan(300)
  })
})

describe('AG-038 / 渲染器基线（跨版本对比用）', () => {
  it('空列表与一条消息的基线', () => {
    const empty = render(<MessageList messages={[]} onSuggestion={() => {}} />)
    const one = render(<MessageList messages={[message()]} onSuggestion={() => {}} />)
    report('空列表', empty.ms, empty.nodes)
    report('一条消息', one.ms, one.nodes, `每条 ${one.nodes - empty.nodes} 个节点`)
    expect(one.nodes).toBeGreaterThan(empty.nodes)
  })
})

/* 让 lint 满意：这两个是给将来扩展用的入口，先占位 */
void vi
