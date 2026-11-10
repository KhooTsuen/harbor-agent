import { describe, expect, it } from 'vitest'
import type { Message } from '@/types'
import {
  advanceFlow,
  pendingSpeechesOf,
  purposeOf,
  type ConversationFlow,
} from '../conversationFlow'
import { bodyTextOf } from '../bodyText'
import { fullRecordText } from '../export'

/* ══════════════════════════════════════════════════════════════
   第 4 项：单模型正文的分段补充、更正与统一结算（2026-11-10）

   ⚠️ **本文件为新增的防御性用例源码，本轮未运行**（用户要求不跑测试）。
      它记录的是本轮结算改动的预期边界，不代表已验证通过。

   ── 修的到底是什么 ────────────────────────────────────────────
   原来 `settle()` 把同一轮的 `answer` 片段**一律**标 `final`，
   但只有「被终稿吸收」和「作为 prefix 前置」两种真进了 `final` 字段。
   剩下的片段被标成「已结算」、文本却不在交付里 —— 渲染层按
   「`purpose === 'final'` 就不再单独出」处理，那段正文**静默消失**。

   ── 本文件钉住的三件事 ────────────────────────────────────────
     ① 没进终稿的片段不许标 `final`（不许冒充已结算），文本也不许丢
     ② 已明确钉住的答复（`hold`）在工具之后仍保留答复归属
     ③ 显示、复制、导出问同一份投影（不能一处有、一处空）

   ── 它钉不住、也不该假装能钉住的 ──────────────────────────────
   单模型的普通正文没有上游阶段信号（`content` 事件不带 `stage`），
   「补充」与「更正」在上游数据里长得一样。所以这里只断言
   「A 不会被静默丢掉」，**不断言 A 一定要并进正文** ——
   并进去就成了靠文字相似度猜替换范围，那正是要避免的。
   ══════════════════════════════════════════════════════════════ */

const run = (events: Record<string, unknown>[]): ConversationFlow =>
  events.reduce(advanceFlow, { version: 2, turn: 0, nodes: [] } as ConversationFlow)

const message = (flow: ConversationFlow, patch: Partial<Message> = {}): Message => ({
  id: 'answer',
  threadId: 'thread',
  role: 'assistant',
  content: '累计原文',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  flow,
  ...patch,
})

const speeches = (flow: ConversationFlow) =>
  flow.nodes
    .filter((node) => node.kind === 'speech')
    .map((node) => ({
      text: node.kind === 'speech' ? node.text : '',
      purpose: node.kind === 'speech' ? purposeOf(node) : '',
    }))

describe('第 4 项 / 单模型正文分段结算（新增用例，未运行）', () => {
  it('★★★ 正文 → 工具 → 补充：先前那段不许被静默丢掉（可追溯），但不冒充交付正文', () => {
    const flow = run([
      { type: 'content', text: '先读 A 文件' },
      { type: 'agent.tool.started', toolCallId: 'read-a' },
      { type: 'content', text: '另外 B 文件也读了' },
      { type: 'done', finalContent: '另外 B 文件也读了' },
    ])
    const all = speeches(flow)
    /* ① A 的原文还在（没被抹掉，展开过程区能看回原文）——这是「不静默丢失」 */
    expect(all.some((item) => item.text === '先读 A 文件')).toBe(true)
    /*
     * ② 它没有上游「这是答复」的信号（`stage: 'answer'`），工具一开就按事实降级成
     *    过程材料。所以它**不是**交付正文的一部分：标 `final` 会让渲染层以为它已在
     *    终稿里（从而不显示），标 `unconfirmed` 又会把「确定被取代」说成「拿不准」。
     */
    const first = all.find((item) => item.text === '先读 A 文件')
    expect(first?.purpose).toBe('chatter')
    /* ③ 因此它不进正文投影（不冒充答复）—— 交付正文就是终稿那一份 */
    expect(pendingSpeechesOf(flow)).not.toContain('先读 A 文件')
    expect(bodyTextOf(message(flow))).toBe('另外 B 文件也读了')
  })

  it('★★★ 正文 → 工具 → 更正（终稿完整覆盖）：被吸收的片段标 final，正文只有一份', () => {
    const flow = run([
      { type: 'content', text: '甲方案' },
      { type: 'agent.tool.started', toolCallId: 'check' },
      { type: 'content', text: '乙方案（更正）' },
      { type: 'done', finalContent: '乙方案（更正）' },
    ])
    expect(flow.final).toBe('乙方案（更正）')
    /* 正文投影里不出现已失效的旧说法 */
    expect(bodyTextOf(message(flow))).toBe('乙方案（更正）')
    /* 旧片段仍在原始记录里可追溯 */
    expect(speeches(flow).some((item) => item.text === '甲方案')).toBe(true)
  })

  it('★★ 明确答复片段（hold）后面再调工具，仍保留答复归属', () => {
    const flow = run([
      { type: 'content', text: '明确答复的一段', stage: 'answer' },
      { type: 'agent.tool.started', toolCallId: 'later' },
      { type: 'content', text: '收尾一句话' },
      { type: 'done', finalContent: '收尾一句话' },
    ])
    const held = speeches(flow).find((item) => item.text === '明确答复的一段')
    expect(held?.purpose).not.toBe('chatter')
    /* 它不在终稿里 → 作为前段进 final 字段，不丢 */
    expect(flow.final).toContain('明确答复的一段')
  })

  it('★★ 过程发言（stage=process）不被当成正文带进交付', () => {
    const flow = run([
      { type: 'content', text: '我这就去看看', stage: 'process' },
      { type: 'agent.tool.started', toolCallId: 'go' },
      { type: 'content', text: '结论' },
      { type: 'done', finalContent: '结论' },
    ])
    expect(flow.final).toBe('结论')
    expect(pendingSpeechesOf(flow)).not.toContain('我这就去看看')
  })

  it('★★★ 没结算时：复制不冒充答复（空），导出保留原文并标注未结算', () => {
    const flow = run([
      { type: 'content', text: '写了一半' },
      { type: 'aborted' },
      { type: 'done', paused: true },
    ])
    /*
     * 复制那条路**不拿片段冒充正式答复**（「正式答复只有一个」的既有契约）。
     * 屏幕上那段话照样看得见（`ConversationFlowView` 带「还没结算」横幅显示），
     * 只是「复制正文」不会把没确认的文字当答复交出去。
     */
    expect(bodyTextOf(message(flow))).toBe('')
    /* 导出必须保留原文，并如实标「这段还没结算」—— 看得见，但不冒充 */
    const exported = fullRecordText(message(flow))
    expect(exported).toContain('写了一半')
    expect(exported).toContain('还没结算')
  })

  it('★ 纯工具、无正文：两条路都给空，不编造内容', () => {
    const flow = run([{ type: 'agent.tool.started', toolCallId: 'only' }, { type: 'done' }])
    expect(bodyTextOf(message(flow))).toBe('')
    expect(pendingSpeechesOf(flow)).toHaveLength(0)
  })
})
