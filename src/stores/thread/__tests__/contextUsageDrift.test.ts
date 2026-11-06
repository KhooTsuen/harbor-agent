import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Message } from '@/types'
import type { ToolRunRecord } from '@/types/rounds'
import { buildHistory } from '../history'
import {
  CALL_OVERHEAD,
  IMAGE_COST,
  MESSAGE_OVERHEAD,
  OUTPUT_CAP,
  estimateMessages,
  estimateTokensOf,
  requestCharsOf,
} from '../contextUsage'

/* ══════════════════════════════════════════════════════════════
   用量口径不许漂（P1-B，2026-11-07）

   `contextUsage.ts` 是渲染层**唯一**的用量口径，而它描述的东西是「内核实际发出去的
   那条请求」。所以这里不自己算第二遍对照值 —— 而是：

     ① 用**真的** `buildHistory` 把消息展开成请求体形状；
     ② 把展开结果逐条喂给**真的**内核函数 `context-text.sizeOfMessage`；
     ③ 断言逐条相等（不是近似、不是只比总数）。

   比总数还不够：总数相等而分布错位（这条多算、那条少算）同样会在「哪一段最占地方」
   上给出错误答案。改一边忘另一边，这里当场红。

   常量也直接读内核那份 —— 三个数字写死两处是最容易漂的地方。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const require_ = createRequire(import.meta.url)
const textCore = require_(join(ROOT, 'electron/core/context-text.cjs')) as {
  sizeOfMessage: (m: {
    role?: string
    content?: unknown
    tool_calls?: unknown[]
    tool_call_id?: string
  }) => number
  MESSAGE_OVERHEAD: number
  CALL_OVERHEAD: number
  IMAGE_COST: number
}
const replayCore = require_(join(ROOT, 'electron/core/session-replay.cjs')) as {
  OUTPUT_CAP: number
}

/** 一条消息（只填这个测试用得到的字段） */
function msg(over: Partial<Message>): Message {
  return {
    id: 'msg_local1',
    threadId: 't',
    role: 'assistant',
    content: '',
    kind: 'text',
    status: 'sent',
    timestamp: 0,
    ...over,
  } as Message
}

function run(over: Partial<ToolRunRecord>): ToolRunRecord {
  return { id: 'r', name: 'read_file', ok: true, output: '', ...over } as ToolRunRecord
}

const PNG = `data:image/png;base64,${'iVBORw0KGgo'.repeat(20)}`

/**
 * 展开后的请求体形状 → 内核算出来的字符总数。
 *
 * `buildHistory(messages, '')` 就是 `turns.ts` 在发送时用的那一个函数，
 * 所以这里量的不是「我以为会发什么」，而是**真会发什么**。
 */
function kernelCharsOf(messages: Message[]): number {
  return buildHistory(messages, '').reduce(
    (sum, one) => sum + textCore.sizeOfMessage(one as Parameters<typeof textCore.sizeOfMessage>[0]),
    0,
  )
}

describe('用量口径 / 常量与内核同值', () => {
  it('★ MESSAGE_OVERHEAD / CALL_OVERHEAD / IMAGE_COST / OUTPUT_CAP 两处一致', () => {
    expect(MESSAGE_OVERHEAD).toBe(textCore.MESSAGE_OVERHEAD)
    expect(CALL_OVERHEAD).toBe(textCore.CALL_OVERHEAD)
    expect(IMAGE_COST).toBe(textCore.IMAGE_COST)
    expect(OUTPUT_CAP).toBe(replayCore.OUTPUT_CAP)
  })

  it('token 换算是同一个公式（chars/3 向上取整）', () => {
    expect(estimateTokensOf(0)).toBe(0)
    expect(estimateTokensOf(1)).toBe(1)
    expect(estimateTokensOf(3000)).toBe(1000)
    expect(estimateTokensOf(3001)).toBe(1001)
  })
})

describe('用量口径 / 逐条与内核相等（不是近似）', () => {
  const cases: Array<{ label: string; messages: Message[] }> = [
    {
      label: '纯文本三条',
      messages: [
        msg({ role: 'user', content: '你好' }),
        msg({ content: '在，什么事' }),
        msg({ role: 'user', content: '帮我看看这个文件' }),
      ],
    },
    {
      label: '一轮 1 次工具（输出超 2000 被截）',
      messages: [
        msg({ role: 'user', content: '读一下' }),
        msg({ content: '读完了。', toolRuns: [run({ output: 'x'.repeat(3000) })] }),
      ],
    },
    {
      label: '一轮 6 次工具（含失败、含无输出）',
      messages: [
        msg({ role: 'user', content: '跑一下' }),
        msg({
          content: '',
          toolRuns: [
            run({ output: 'y'.repeat(500) }),
            run({ ok: false, output: '报错了' }),
            run({ name: 'run_shell', ok: false, output: '' }),
            run({ output: 'z'.repeat(1500) }),
            run({ name: 'list_dir', output: 'a\nb' }),
            run({ output: 'w'.repeat(2500) }),
          ],
        }),
      ],
    },
    {
      label: '一轮 30 次工具（P0 那个形状）',
      messages: [
        msg({ role: 'user', content: '把那 30 个文件都读一遍' }),
        msg({
          content: '30 个都读完了',
          toolRuns: Array.from({ length: 30 }, () => run({ output: 'v'.repeat(1200) })),
        }),
      ],
    },
    {
      label: '用户带图',
      messages: [
        msg({ role: 'user', content: '这张图里是什么', images: [PNG] }),
        msg({ content: '是一张截图。' }),
      ],
    },
    {
      label: '只有图、没有文字',
      messages: [msg({ role: 'user', content: '', images: [PNG] }), msg({ content: '看到了。' })],
    },
  ]

  for (const one of cases) {
    it(`★ ${one.label}：整条累加与内核相等`, () => {
      const mine = one.messages.reduce((sum, m) => sum + requestCharsOf(m), 0)
      expect(mine).toBe(kernelCharsOf(one.messages))
    })
  }

  it('★ token 那一层也跟着相等（不是只有字符对）', () => {
    const messages = cases[3].messages
    expect(estimateMessages(messages)).toBe(estimateTokensOf(kernelCharsOf(messages)))
  })
})

describe('用量口径 / 正文为空不等于没内容', () => {
  it('★ 空正文 + 6 次工具：算出来的字符 > 0，且远大于「只算正文」', () => {
    const one = msg({
      content: '',
      toolRuns: Array.from({ length: 6 }, () => run({ output: 'q'.repeat(400) })),
    })
    const bare = msg({ content: '' })
    expect(requestCharsOf(one)).toBeGreaterThan(2000)
    expect(requestCharsOf(one)).toBeGreaterThan(requestCharsOf(bare) * 10)
  })

  it('★ 工具输出超 2000 的部分不计入（和真正发出去的一致）', () => {
    const long = msg({ toolRuns: [run({ output: 'x'.repeat(5000) })] })
    const capped = msg({ toolRuns: [run({ output: 'x'.repeat(OUTPUT_CAP) })] })
    expect(requestCharsOf(long)).toBe(requestCharsOf(capped))
  })
})

describe('用量口径 / 展开时不丢工具记录（与内核同一判据）', () => {
  it('★★ 正文为空但带工具记录的 assistant：不会被当成「不可用」丢掉', () => {
    const history = buildHistory(
      [
        msg({ role: 'user', content: '读吧' }),
        msg({ content: '', toolRuns: [run({ output: 'out-1' })] }),
      ],
      '',
    )
    const tools = history.filter((m) => m.role === 'tool')
    expect(tools.length).toBe(1)
    expect(String(tools[0].content)).toContain('out-1')
    /* 协议也得跟上：那条 assistant 必须声明同一个 id */
    const calls = history.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id))
    expect(calls).toContain(tools[0].tool_call_id)
  })
})
