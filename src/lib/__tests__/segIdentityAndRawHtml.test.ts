import { describe, expect, it } from 'vitest'
import { advanceFlow, purposeOf, type ConversationFlow } from '../conversationFlow'
import { isRawHtmlEnabled } from '@/components/chat/markdown/RawHtml'

/* ══════════════════════════════════════════════════════════════
   第 2、4、9 项的边界用例 —— **已准备，未运行**（2026-11-11）

   ⚠️ 本轮按用户要求不跑测试。下面每条是**设计意图**，不是已验证事实。
   下一轮跑 `npm run test:unit` 时连同它们一起执行。

   钉三件事：
     · 上游给了段身份（segId）就按身份分段，不靠「挨着就并」
     · 段身份缺失时保持原行为（HTTP/SSE 那条路本来就没有消息 id）
     · 原始 HTML 开关只认明确开启值（第 9 项）
   ══════════════════════════════════════════════════════════════ */

const run = (events: Record<string, unknown>[]): ConversationFlow =>
  events.reduce(advanceFlow, { version: 2, turn: 0, nodes: [] } as ConversationFlow)

const speeches = (flow: ConversationFlow) =>
  flow.nodes.filter((node) => node.kind === 'speech')

describe('第 2 项 / 上游段身份（已准备，未运行）', () => {
  it('★★★ 同 segId 连续两段 → 合并成一段', () => {
    const flow = run([
      { type: 'content', text: '前半', segId: 'i1' },
      { type: 'content', text: '后半', segId: 'i1' },
    ])
    const list = speeches(flow)
    expect(list).toHaveLength(1)
    expect(list[0].text).toBe('前半后半')
  })

  it('★★★ 不同 segId → 各成一段，顺序保留', () => {
    const flow = run([
      { type: 'content', text: '甲', segId: 'i1' },
      { type: 'content', text: '乙', segId: 'i2' },
    ])
    const list = speeches(flow)
    expect(list.map((n) => n.text)).toEqual(['甲', '乙'])
    expect(list.map((n) => (n as { segId?: string }).segId)).toEqual(['i1', 'i2'])
  })

  it('★★★ 没有 segId → 保持原行为（相邻同类合并，不因此切碎）', () => {
    const flow = run([
      { type: 'content', text: '第一句' },
      { type: 'content', text: '第二句' },
    ])
    expect(speeches(flow)).toHaveLength(1)
  })

  it('★★ 一侧有 segId、另一侧没有 → 不强行分开（缺失按「不知道」处理）', () => {
    const flow = run([
      { type: 'content', text: '甲', segId: 'i1' },
      { type: 'content', text: '乙' },
    ])
    expect(speeches(flow)).toHaveLength(1)
  })

  it('★★ 段身份不参与「算不算答复」的判断（只看 stage / hold）', () => {
    const flow = run([
      { type: 'content', text: '答复', segId: 'i1', stage: 'answer' },
      { type: 'content', text: '过程', segId: 'i2', stage: 'process' },
    ])
    expect(speeches(flow).map(purposeOf)).toEqual(['answer', 'chatter'])
  })
})

describe('第 9 项 / 原始 HTML 开关只认明确开启值（已准备，未运行）', () => {
  const withStore = (value: string | null): boolean => {
    const store = new Map<string, string>()
    if (value !== null) store.set('harbor.rawHtml', value)
    const saved = globalThis.localStorage
    // @ts-expect-error 测试里替换最小 localStorage 形状
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    }
    try {
      return isRawHtmlEnabled()
    } finally {
      globalThis.localStorage = saved
    }
  }

  it('★★★ 未设置 → 关闭（默认必须是关）', () => {
    expect(withStore(null)).toBe(false)
  })

  it('★★★ 明确设为 "1" → 开启', () => {
    expect(withStore('1')).toBe(true)
  })

  it('★★★ 设为 "0" → 关闭', () => {
    expect(withStore('0')).toBe(false)
  })

  it('★★★ 设为空串 / "false" / 任意杂值 → 关闭（以前除 "0" 之外都算开启）', () => {
    expect(withStore('')).toBe(false)
    expect(withStore('false')).toBe(false)
    expect(withStore('no')).toBe(false)
    expect(withStore('随便什么')).toBe(false)
  })
})
