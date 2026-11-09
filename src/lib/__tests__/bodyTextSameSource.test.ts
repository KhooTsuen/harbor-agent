import { describe, expect, it } from 'vitest'
import type { Message, MessageRound } from '@/types'
import { bodyTextOf } from '../bodyText'
import { fullRecordText, threadToMarkdown } from '../export'

/* ══════════════════════════════════════════════════════════════
   显示 / 复制 / 导出 取同一条正文

   ── 为什么单独立一条 ──────────────────────────────────────────
   2026-11-09 的 bug 是「复制到的 ≠ 屏幕上看到的」，修法是让复制复用渲染判据。
   但同一个病有**三个出口**：显示、复制、导出。只修一个等于留两个。
   这条测试钉的就是「三处结果一致」——任何一处偷偷改回 `message.content`，
   只要那条消息是多轮正文，这里就红。

   ── 造样本的规矩 ──────────────────────────────────────────────
   一律用**多轮 + 中间夹过程话**的形状（真实 Agent 消息就是这样）：
   纯单轮的话 `content` 和 `bodyText` 恰好相等，测不出区别。
   ══════════════════════════════════════════════════════════════ */

function msg(extra: Partial<Message>): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    content: '',
    reasoning: '',
    kind: 'text',
    status: 'sent',
    timestamp: 1,
    toolRuns: [],
    ...extra,
  } as Message
}

/** 「先说一段」→ 调工具 → 「结论」：第一轮没工具 = 正文，第二轮有工具 = 过程话 */
const multiRound = (): MessageRound[] => [
  { reasoning: '', content: '第一段：先说清楚我要查什么。', tools: [] },
  { reasoning: '', content: '查到了，没问题。', tools: [0] },
]

describe('正文同源 / 显示与复制一致', () => {
  it('★★★ 多轮正文：bodyTextOf 拿到第一段，message.content 只有第二段', () => {
    const m = msg({ rounds: multiRound(), content: '查到了，没问题。' })
    const body = bodyTextOf(m)
    expect(body).toContain('第一段')
    /* 这就是 bug 本身：content 里根本没有第一段 */
    expect(m.content).not.toContain('第一段')
  })

  it('★★★ 复制（bodyTextOf）与导出（threadToMarkdown）正文一致', () => {
    const m = msg({ rounds: multiRound(), content: '查到了，没问题。' })
    const body = bodyTextOf(m)
    const md = threadToMarkdown({
      id: 't1',
      title: '标题',
      mode: 'standard',
      model: 'm',
      createdAt: 1,
      tags: [],
      messages: [m],
    } as never)
    /* 导出里必须出现复制拿到的同一段正文 */
    expect(md).toContain(body)
    /* 而只有 content 的第二段、缺第一段的旧行为不该再出现 */
    expect(md).toContain('第一段')
  })

  it('★★★ 「复制完整记录」传了 bodyText 时，正文段与 bodyTextOf 一致', () => {
    const m = msg({ rounds: multiRound(), content: '查到了，没问题。' })
    const full = fullRecordText(m, bodyTextOf(m))
    expect(full).toContain(bodyTextOf(m))
  })

  it('★★ 不传 bodyText 时「完整记录」退回 content（旧的显式调用不受影响）', () => {
    const m = msg({ rounds: multiRound(), content: '查到了，没问题。' })
    const full = fullRecordText(m)
    expect(full).toContain('查到了，没问题。')
    expect(full).not.toContain('第一段')
  })

  it('★★ 单轮消息：三处结果完全一样（不能因为同源反而改动老行为）', () => {
    const m = msg({ content: '只有一段。' })
    expect(bodyTextOf(m)).toBe('只有一段。')
    const full = fullRecordText(m, bodyTextOf(m))
    expect(full).toContain('只有一段。')
  })

  it('★★ 用户消息与系统消息：各自的原文，不参与轮次判定', () => {
    const user = msg({ role: 'user', content: '我问的话', rounds: multiRound() })
    expect(bodyTextOf(user)).toBe('我问的话')
    const sys = msg({ role: 'system', content: '系统提示' })
    expect(bodyTextOf(sys)).toBe('系统提示')
  })

  it('★★ 只有思考没有正文 → 退回 content，不返回空串', () => {
    const m = msg({
      rounds: [{ reasoning: '想了很久', content: '', tools: [0] }],
      content: '兜底那句',
    })
    expect(bodyTextOf(m)).toBe('兜底那句')
  })

  it('★★ 一段正文都没有、content 也空 → 空串（不编内容）', () => {
    const m = msg({ rounds: [{ reasoning: '只想不说', content: '', tools: [0] }], content: '' })
    expect(bodyTextOf(m)).toBe('')
  })
})

describe('正文同源 / 保真', () => {
  it('★★★ Markdown 原样保留（标题 / 列表 / 代码块都不转义）', () => {
    const md = '# 标题\n\n- 一\n- 二\n\n```js\nconst a = 1\n```'
    const m = msg({ content: md })
    expect(bodyTextOf(m)).toBe(md)
  })

  it('★★ 多段之间空行分隔（粘出去还是一段一段）', () => {
    const m = msg({
      rounds: [
        { reasoning: '', content: '第一段', tools: [] },
        { reasoning: '', content: '第二段', tools: [] },
      ],
      content: '第二段',
    })
    expect(bodyTextOf(m)).toBe('第一段\n\n第二段')
  })
})
