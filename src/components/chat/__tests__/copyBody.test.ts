import { describe, expect, it } from 'vitest'
import type { Message, MessageRound } from '@/types'
import { bodyTextOf } from '@/components/chat/message/bodyText'
import { answerPatch, toAnswerRecord } from '@/lib/answers'
import { fullRecordText } from '@/lib/export'

/* ══════════════════════════════════════════════════════════════
   「复制正文」= 界面上看到的正文（2026-11-09 用户报的 bug）

   ── 病 ────────────────────────────────────────────────────────
   点「复制正文」，剪贴板里和那条消息上显示的对不上。

   根因：取数走了两条路
     · 界面 `MessageRounds` 逐轮画 `rounds[i].content`，跳过「过程话」
     · 复制直接 `message.content`（**只有最后一轮**）

   ── 这一组钉什么 ──────────────────────────────────────────────
   ① `bodyTextOf` 返回的必须就是界面判定的正文（多轮都要）
   ② 思考 / 工具 / 过程话**一个字都不能混进来**
   ③ 切回答版本时 `rounds` 必须跟着换（否则界面显示 A、复制到 B）
   ④ Markdown 原文保真（不转义、不裁行、多段留空行）
   ⑤ 流式进行中与结束后，判据一致
   ══════════════════════════════════════════════════════════════ */

/** 造一轮：默认无工具、无思考 */
function round(content: string, tools: number[] = [], reasoning = ''): MessageRound {
  return { content, reasoning, tools }
}

/** 造一条助手消息 */
function assistant(patch: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    kind: 'text',
    status: 'sent',
    content: '',
    timestamp: 1,
    ...patch,
  } as Message
}

describe('复制正文 / ① 多轮正文都要复制到（这是 bug 本体）', () => {
  it('★★★ 两轮正文、中间夹一轮过程话 → 复制两段正文，不含过程话', () => {
    const m = assistant({
      content: '结论：都检查好了。',
      rounds: [
        round('先说明一下背景。'),
        round('我先看一下 A 文件。', [0], '想想'),
        round('结论：都检查好了。'),
      ],
      toolRuns: [{ id: 'x', name: 'read_file', ok: true, output: 'ok' }],
    })
    /* 界面显示两段；以前复制只拿到最后一段 */
    expect(bodyTextOf(m)).toBe('先说明一下背景。\n\n结论：都检查好了。')
    /* 明确钉住「不等于旧行为」—— 这是回归防线 */
    expect(bodyTextOf(m)).not.toBe(m.content)
  })

  it('★★★ 三段正文全都要带上，顺序不变', () => {
    const m = assistant({
      content: '第三段结论。',
      rounds: [round('第一段。'), round('第二段。', [0]), round('第三段结论。')],
      toolRuns: [{ id: 'x', name: 'read_file', ok: true, output: 'ok' }],
    })
    /* 第二轮有工具 → 是过程话，被排除；第一 / 第三 都是正文 */
    expect(bodyTextOf(m)).toBe('第一段。\n\n第三段结论。')
  })

  it('★★ 只有一轮正文时与 content 相同（纯问答不受影响）', () => {
    const m = assistant({ content: '就一句话。', rounds: [round('就一句话。')] })
    expect(bodyTextOf(m)).toBe('就一句话。')
  })
})

describe('复制正文 / ② 思考、工具、过程话不许混进来', () => {
  it('★★★ 思考不进正文', () => {
    const m = assistant({
      content: '答案。',
      reasoning: '我在心里想了很多，这段不该被复制走。',
      rounds: [round('答案。', [], '我在心里想了很多，这段不该被复制走。')],
    })
    expect(bodyTextOf(m)).toBe('答案。')
    expect(bodyTextOf(m)).not.toContain('我在心里想')
  })

  it('★★★ 工具调用不进正文', () => {
    const m = assistant({
      content: '跑完了。',
      toolRuns: [{ id: 'x', name: 'run_shell', ok: true, output: '隐密的命令输出' }],
      rounds: [round('跑完了。', [0])],
    })
    expect(bodyTextOf(m)).toBe('跑完了。')
    expect(bodyTextOf(m)).not.toContain('run_shell')
    expect(bodyTextOf(m)).not.toContain('隐密的命令输出')
  })

  it('★★ 过程话那一轮即使有正文也不复制（界面收进了折叠区）', () => {
    const m = assistant({
      content: '结论。',
      rounds: [round('我现在去跑一下测试。', [0]), round('结论。')],
      toolRuns: [{ id: 'x', name: 'run_shell', ok: true, output: 'ok' }],
    })
    expect(bodyTextOf(m)).not.toContain('我现在去跑一下测试')
  })
})

describe('复制正文 / ③ 切回答版本：rounds 必须跟着换', () => {
  it('★★★ answerPatch 会把记录里的 rounds 换上去（否则界面显示 A、复制到 B）', () => {
    const record = {
      role: 'assistant' as const,
      key: 'k1',
      content: '旧答案的正文',
      ts: 1,
      rounds: [round('旧答案的正文')],
    }
    const patch = answerPatch(record, 0)
    expect(patch.content).toBe('旧答案的正文')
    expect(patch.rounds).toEqual([round('旧答案的正文')])
  })

  it('★★★ 记录里没有 rounds → 给空数组，让界面退回用 content 合成（不显示别人的正文）', () => {
    const patch = answerPatch({ role: 'assistant', key: 'k1', content: '老记录的答案', ts: 1 }, 1)
    expect(patch.rounds).toEqual([])
    expect(patch.content).toBe('老记录的答案')
  })

  it('★★★ toAnswerRecord 会把 rounds 收进台账（不收就无值可换）', () => {
    const m = assistant({
      content: '第二段。',
      rounds: [round('第一段。'), round('第二段。')],
    })
    expect(toAnswerRecord(m).rounds).toEqual([round('第一段。'), round('第二段。')])
  })

  it('★★ 没有 rounds 的老消息不进台账（保持存储形状不变）', () => {
    const m = assistant({ content: '老格式。' })
    expect(toAnswerRecord(m).rounds).toBeUndefined()
  })
})

describe('复制正文 / ④ Markdown 与多段保真', () => {
  it('★★★ 标题 / 列表 / 代码块原样保留（不转义、不拆行）', () => {
    const md = ['# 标题', '', '- 一', '- 二', '', '```ts', 'const a = 1', '```'].join('\n')
    const m = assistant({ content: md, rounds: [round(md)] })
    expect(bodyTextOf(m)).toBe(md)
  })

  it('★★★ 多段之间保留空行（粘出去还是一段一段）', () => {
    const m = assistant({
      content: '甲。',
      rounds: [round('甲。'), round('乙。')],
    })
    expect(bodyTextOf(m)).toBe('甲。\n\n乙。')
  })

  it('★ 单段内的换行不被压掉', () => {
    const text = '第一行\n第二行\n第三行'
    const m = assistant({ content: text, rounds: [round(text)] })
    expect(bodyTextOf(m)).toBe(text)
  })

  it('★ 空轮不产生多余空行', () => {
    const m = assistant({ content: '甲。', rounds: [round('甲。'), round('   ')] })
    expect(bodyTextOf(m)).toBe('甲。')
  })
})

describe('复制正文 / ⑤ 流式与历史重载', () => {
  it('★★ 流式中（status=streaming）判据不变 —— 界面显示什么就复制什么', () => {
    const m = assistant({
      status: 'streaming',
      content: '正在写',
      rounds: [round('先说一句。', [0]), round('正在写')],
      toolRuns: [{ id: 'x', name: 'read_file', ok: true, output: 'ok' }],
    })
    /*
     * rounds[0] 有工具、又不是最后一个有正文的轮 → 按判据是「过程话」，
     * 界面把它收进折叠区、不当正文显示。所以复制也不该有它 ——
     * 这条钉的是「流式与否不改判据」，不是「多轮全都复制」。
     */
    expect(bodyTextOf(m)).toBe('正在写')
  })

  it('★★★ 老记录（没有 rounds 字段）→ 只有一份正文，与 content 一致', () => {
    /* 磁盘上一条 rounds 都没有（这次扫描实测），它们必须照旧可复制 */
    const m = assistant({ content: '老格式的答案。', reasoning: '老思考' })
    expect(bodyTextOf(m)).toBe('老格式的答案。')
  })

  it('★★ 断掉的回复（interrupted）正文照旧可复制', () => {
    const m = assistant({ content: '写到一半', interrupted: true, rounds: [round('写到一半')] })
    expect(bodyTextOf(m)).toBe('写到一半')
  })

  it('★ 一轮正文都没有（只有思考）→ 退回 content，不返回空串', () => {
    const m = assistant({ content: '兜底文字', rounds: [round('', [0], '只想没写')] })
    expect(bodyTextOf(m)).toBe('兜底文字')
  })
})

describe('复制正文 / ⑥ 用户与系统消息', () => {
  it('★★ 用户消息复制自己的原文', () => {
    const m = assistant({ role: 'user', content: '我发的话' })
    expect(bodyTextOf(m)).toBe('我发的话')
  })

  it('★★ 系统消息复制自己的原文', () => {
    const m = assistant({ role: 'system', content: '系统提示' })
    expect(bodyTextOf(m)).toBe('系统提示')
  })
})

describe('复制正文 / ⑦ 完整记录与「复制」同源', () => {
  it('★★★ 传了 bodyText 时正文用那份（两个按钮只差过程，不差正文）', () => {
    const m = assistant({
      content: '结论。',
      rounds: [round('第一段。'), round('结论。')],
      reasoning: '想了',
    })
    const text = fullRecordText(m, bodyTextOf(m))
    expect(text).toContain('第一段。')
    expect(text).toContain('结论。')
    /* 过程仍在（那是两个按钮的区别） */
    expect(text).toContain('想了')
  })

  it('★★ 不传 bodyText 时退回 content（导出那条路行为不变）', () => {
    const m = assistant({ content: '结论。', rounds: [round('第一段。'), round('结论。')] })
    expect(fullRecordText(m)).toBe('结论。')
  })
})
