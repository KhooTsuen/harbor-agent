import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Message, ToolRunRecord } from '@/types'
import { MessageList } from '../MessageList'
import { ToolLine, describeRuns } from '../message/ToolLine'
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

/** 点开当前那些可折叠的控件（概览行）—— 用一个函数是因为调用点很多 */
function clickExpander(): void {
  for (const button of [...container.querySelectorAll('button[aria-expanded="false"]')]) {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
}

describe('AG-038 / 10000 个 Tool Event', () => {
  it('★ 归类之后是一行（不是一万行）', () => {
    const runs = Array.from({ length: 10_000 }, () => toolRun())
    /* 一万次同名调用 → 一句话（「读取 10000 个文件」），不是一万个元素 */
    expect(describeRuns(runs)).toBe('读取 10000 个文件')
  })

  it('★ 收起时 DOM 里只有一行；展开也要有上限', () => {
    const runs = Array.from({ length: 10_000 }, () => toolRun())
    const collapsed = render(<ToolLine runs={runs} />)
    report('10000 个工具事件（收起）', collapsed.ms, collapsed.nodes)
    expect(collapsed.nodes).toBeLessThan(40)

    const expandedAt = performance.now()
    act(() => clickExpander())
    const ms = performance.now() - expandedAt
    const nodes = container.querySelectorAll('*').length
    report('10000 个工具事件（展开到底）', ms, nodes)
    /*
     * 展开一万行谁也受不了 —— 必须有上限。修之前实测 **9.4 秒 / 12 万节点**，
     * 现在是「最近 100 步」一千多个节点。判据是「不随数据线性爆炸」，
     * 不是某个精确数字。
     */
    expect(nodes, `展开后 ${nodes} 个节点`).toBeLessThan(2000)
    /* 截断了就得说出来，不能假装只有这些 */
    expect(container.textContent).toContain('没摊开')
  })
})

describe('AG-038 / 步数多也要截', () => {
  it('★ 200 步（读一个、跑一条交替）只摊开最近 100 步', () => {
    const runs = Array.from({ length: 200 }, (_, i) =>
      toolRun({ name: i % 2 === 0 ? 'read_file' : 'run_shell' }),
    )
    render(<ToolLine runs={runs} />)
    act(() => clickExpander())
    const nodes = container.querySelectorAll('*').length
    /* 明细行自己的按钮没有 aria-expanded（没输出就不可展开），所以数出来是
       1（概览行）+ 最多 100（明细行） */
    const rows = container.querySelectorAll('button').length
    report('200 步（展开）', 0, nodes, `${rows} 个可点行`)
    expect(nodes, `${nodes} 个节点`).toBeLessThan(3000)
    expect(rows).toBeLessThanOrEqual(101)
    expect(container.textContent).toContain('没摊开')
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
    const empty = render(<MessageList messages={[]} />)
    const one = render(<MessageList messages={[message()]} />)
    report('空列表', empty.ms, empty.nodes)
    report('一条消息', one.ms, one.nodes, `每条 ${one.nodes - empty.nodes} 个节点`)
    expect(one.nodes).toBeGreaterThan(empty.nodes)
  })
})

/* 让 lint 满意：这两个是给将来扩展用的入口，先占位 */
void vi
