import { describe, expect, it } from 'vitest'
import {
  advanceFlow,
  conversationFlowSchema,
  migrateFlow,
  purposeOf,
  FLOW_VERSION,
  type ConversationFlow,
} from '../conversationFlow'

/* ══════════════════════════════════════════════════════════════
   第二阶段：每段文字有身份和用途

   这里钉的是**判据**，不是实现 —— 几条都对应过真实故障或明确的产品口径：
     · 过程发言 vs 答复片段：靠「后面还干不干活」降级，不靠措辞猜
     · 正式答复不夺回：已明确属于交付的片段，后面再调工具也还是答复
     · 结算唯一：`final` 只有一个来源，暂停 / 用尽 / 截断一律不结算
     · 老记录只读兼容：v1 读进来不改写，写回才是 v2
   ══════════════════════════════════════════════════════════════ */

function project(events: Record<string, unknown>[]): ConversationFlow {
  return events.reduce<ConversationFlow>(advanceFlow, { version: FLOW_VERSION, turn: 0, nodes: [] })
}

const speeches = (flow: ConversationFlow) => flow.nodes.filter((node) => node.kind === 'speech')

describe('正文块身份 / ① 过程发言与答复片段', () => {
  it('★★★ 说了话又去调工具 → 那段降级成过程发言（不是答复）', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '我先看看这两个文件。' },
      { type: 'agent.tool.started', toolCallId: 'call_1' },
    ])
    const first = speeches(flow)[0]
    expect(purposeOf(first)).toBe('chatter')
  })

  it('★★★ 最后一段没被任何工具打断 → 保持答复片段', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '结论：两个文件都没问题。' },
    ])
    expect(purposeOf(speeches(flow)[0])).toBe('answer')
  })

  it('★★ 新一轮开始时，上一轮没结算的话降级（跨轮也一样）', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '第一轮说的' },
      { type: 'turn_start' },
      { type: 'content', text: '第二轮说的' },
    ])
    expect(speeches(flow).map(purposeOf)).toEqual(['chatter', 'answer'])
  })

  it('★★ 模型重试和换轮同构：重试那段是过程，不是答复', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '半截被重试掉的话' },
      { type: 'retry' },
      { type: 'content', text: '重试后的话' },
    ])
    expect(speeches(flow).map(purposeOf)).toEqual(['chatter', 'answer'])
  })
})

describe('正文块身份 / ② 正式答复不夺回', () => {
  it('★★★ 已结算成 final 的片段，后面再调工具也不改回 chatter', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '这是答复' },
      { type: 'done', finalContent: '这是答复' },
      /* 结算之后又来一轮工具（真实场景：收尾门禁顶回去让模型再干活） */
      { type: 'agent.tool.started', toolCallId: 'call_after' },
    ])
    expect(speeches(flow).map(purposeOf)).toEqual(['final'])
  })

  it('★★★ 已 final 的片段，再来一轮 content 也不被降级', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '这是答复' },
      { type: 'done', finalContent: '这是答复' },
      { type: 'turn_start' },
      { type: 'content', text: '后面又说的' },
    ])
    expect(speeches(flow).map(purposeOf)).toEqual(['final', 'answer'])
  })
})

describe('正文块身份 / ③ 结算唯一正式答复', () => {
  it('★★★ 有交付正文 → 这一轮的答复片段被它吸收，final 只有一个', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '草稿一段' },
      { type: 'done', finalContent: '正式答复' },
    ])
    expect(flow.final).toBe('正式答复')
    expect(speeches(flow).map(purposeOf)).toEqual(['final'])
  })

  it('★★★ 暂停 / 轮数用尽 / 截断 → 一律不结算，标未确认', () => {
    for (const flag of ['paused', 'exhausted', 'truncated'] as const) {
      const flow = project([
        { type: 'turn_start' },
        { type: 'content', text: '可能没说完' },
        { type: 'done', [flag]: true, finalContent: '可能没说完', finishReason: 'stop' },
      ])
      expect(flow.final, `${flag} 不该结算`).toBeUndefined()
      expect(speeches(flow).map(purposeOf), `${flag} 应标未确认`).toEqual(['unconfirmed'])
    }
  })

  it('★★★ 没有交付正文、但 Provider 说 stop → 最后一段认作正式答复', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '这就是答案' },
      { type: 'done', finalContent: '', finishReason: 'stop' },
    ])
    expect(speeches(flow).map(purposeOf)).toEqual(['final'])
  })

  it('★★★ 没有交付正文、也没有 stop 信号 → 一个字都不改（不猜）', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '不知道算不算答复' },
      { type: 'done', finalContent: '' },
    ])
    expect(flow.final).toBeUndefined()
    expect(speeches(flow).map(purposeOf)).toEqual(['answer'])
  })

  it('★★ finish_reason 不是 stop（例如 length）不据此结算', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '撞上限了' },
      { type: 'done', finalContent: '', finishReason: 'length' },
    ])
    expect(speeches(flow).map(purposeOf)).toEqual(['answer'])
  })
})

describe('正文块身份 / ④ 老记录只读兼容', () => {
  it('★★★ v1 记录读进来补 purpose 但**不改 version 到磁盘**（migrateFlow 只读归一）', () => {
    const v1: ConversationFlow = {
      version: 1,
      turn: 1,
      nodes: [{ kind: 'speech', id: 0, turn: 0, text: '老记录里的一句话' }],
    }
    const migrated = migrateFlow(v1)
    expect(migrated.version).toBe(FLOW_VERSION)
    expect(purposeOf(migrated.nodes[0])).toBe('answer')
    /* 原对象没被就地改（老会话读出来不该被抹上写入痕迹） */
    expect(v1.nodes[0]).toEqual({ kind: 'speech', id: 0, turn: 0, text: '老记录里的一句话' })
  })

  it('★★ v1 带 final 的老记录：final 照旧，不重新结算', () => {
    const v1: ConversationFlow = {
      version: 1,
      turn: 1,
      nodes: [{ kind: 'speech', id: 0, turn: 0, text: '草稿' }],
      final: '老的正式答复',
    }
    expect(migrateFlow(v1).final).toBe('老的正式答复')
  })

  it('★★ 没有 purpose 的 v1 节点按答复片段看待（乐观，不是过程）', () => {
    const v1: ConversationFlow = {
      version: 1,
      turn: 1,
      nodes: [{ kind: 'speech', id: 0, turn: 0, text: 'x' }],
    }
    expect(purposeOf(v1.nodes[0])).toBe('answer')
  })
})

describe('正文块身份 / ⑤ 形状与保真', () => {
  it('★★★ 落盘再读回，四态与文本一字不差（schema 往返）', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '过程话' },
      { type: 'agent.tool.started', toolCallId: 'c1' },
      { type: 'content', text: '结论段' },
      { type: 'done', finalContent: '结论段' },
    ])
    const round = conversationFlowSchema.parse(JSON.parse(JSON.stringify(flow)))
    expect(round).toEqual(flow)
    expect(speeches(round).map(purposeOf)).toEqual(['chatter', 'final'])
  })

  it('★★ 同轮连续正文并成一段（不会碎成几十个节点）', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'content', text: '一' },
      { type: 'content', text: '二' },
      { type: 'content', text: '三' },
    ])
    expect(speeches(flow)).toHaveLength(1)
    expect(speeches(flow)[0].kind === 'speech' && speeches(flow)[0].text).toBe('一二三')
  })

  it('★★ 思考块不参与用途判定（它永远是过程）', () => {
    const flow = project([
      { type: 'turn_start' },
      { type: 'reasoning', text: '想一想' },
      { type: 'content', text: '说一句' },
      { type: 'done', finalContent: '说一句' },
    ])
    const thoughts = flow.nodes.filter((node) => node.kind === 'reasoning')
    expect(thoughts).toHaveLength(1)
    expect(purposeOf(thoughts[0])).toBe('')
  })
})
