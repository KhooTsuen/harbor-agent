import { describe, expect, it } from 'vitest'
import { fullRecordText, processSection, threadToMarkdown } from '@/lib/export'
import type { Message, Thread } from '@/types'

/* ══════════════════════════════════════════════════════════════
   复制 / 导出（2026-10-21：回答与过程分流）

   ── 为什么要单独钉这几条 ──────────────────────────────────────
   用户拍板过：「复制默认只复制最终回答；需要时可选择复制完整记录；
   导出和历史回看不能丢失工具、错误及未完成状态。」

   三件事都容易做错且**看不出错**：
     ① 默认复制如果把过程也带上，用户贴给别人时会带一堆工具输出
     ② 「完整记录」如果漏掉失败原因，排查时等于少一半信息
     ③ 导出如果丢掉「这条没写完」，读文件的人会当成完整答案
   ══════════════════════════════════════════════════════════════ */

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    title: '测试线程',
    messages: [],
    status: 'idle',
    mode: 'pair',
    model: 'test',
    reasoning: 'high',
    pinned: false,
    archived: false,
    tags: [],
    exportedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function assistant(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    content: '这是最终回答。',
    kind: 'text',
    status: 'sent',
    timestamp: 0,
    ...over,
  }
}

const okRun = { id: 'r1', name: 'read_file', ok: true, output: '读到了', ms: 120 }
const badRun = { id: 'r2', name: 'browse', ok: false, output: '连接超时', ms: 3000 }

describe('processSection（过程区，复制与导出共用）', () => {
  it('★★★ 没有过程时返回空串（纯问答不产出空 details）', () => {
    expect(processSection(assistant())).toBe('')
  })

  it('★★★ 有过程时收进 <details>（默认折叠，不抢正文的位置）', () => {
    const text = processSection(assistant({ reasoning: '我在想', toolRuns: [okRun] }))
    expect(text).toContain('<details>')
    expect(text).toContain('</details>')
    /* 步骤数按 toolRuns 长度算（思考不算「步骤」—— 它没有可数的次数） */
    expect(text).toContain('1 个步骤')
  })

  it('★★★ 失败步骤必须带原因（只画一个 ✗ 等于把为什么失败丢了）', () => {
    const text = processSection(assistant({ toolRuns: [okRun, badRun] }))
    expect(text).toContain('✗')
    expect(text).toContain('原因：连接超时')
  })

  it('★★ 用时写进 summary（导出文件里也看得见跑了多久）', () => {
    const text = processSection(assistant({ durationMs: 31_000, toolRuns: [okRun] }))
    expect(text).toContain('用时 31 秒')
  })

  it('★★ 中断写「已中断」而不是用时', () => {
    const text = processSection(
      assistant({ interrupted: true, durationMs: 31_000, toolRuns: [okRun] }),
    )
    expect(text).toContain('已中断')
    expect(text).not.toContain('用时')
  })
})

describe('fullRecordText（复制完整记录）', () => {
  it('★★★ 过程在前、正文在后（与界面同一套内容归属）', () => {
    const text = fullRecordText(assistant({ reasoning: '想一下', toolRuns: [okRun] }))
    expect(text.indexOf('<details>')).toBeLessThan(text.indexOf('这是最终回答。'))
  })

  it('★★★ 未完成要留一句（不能让人以为这就是全篇）', () => {
    const text = fullRecordText(assistant({ interrupted: true }))
    expect(text).toContain('没写完')
  })

  it('★★★ 出错要留一句', () => {
    const text = fullRecordText(assistant({ status: 'error' }))
    expect(text).toContain('没能完成')
  })

  it('★★ 纯问答的完整记录 = 正文（不多出空块）', () => {
    expect(fullRecordText(assistant())).toBe('这是最终回答。')
  })
})

describe('threadToMarkdown（导出）', () => {
  it('★★★ 导出保留过程区（历史回看不丢工具）', () => {
    const md = threadToMarkdown(
      makeThread({ messages: [assistant({ reasoning: '想', toolRuns: [okRun] })] }),
    )
    expect(md).toContain('<details>')
    expect(md).toContain('read_file')
  })

  it('★★★ 导出保留失败原因', () => {
    const md = threadToMarkdown(makeThread({ messages: [assistant({ toolRuns: [badRun] })] }))
    expect(md).toContain('连接超时')
  })

  it('★★★ 导出保留未完成状态', () => {
    const md = threadToMarkdown(makeThread({ messages: [assistant({ interrupted: true })] }))
    expect(md).toContain('没写完')
  })

  it('★★ 纯问答不产出空的 details 块', () => {
    const md = threadToMarkdown(makeThread({ messages: [assistant()] }))
    expect(md).not.toContain('<details>')
    expect(md).toContain('这是最终回答。')
  })

  it('用户消息仍原样导出', () => {
    const md = threadToMarkdown(
      makeThread({
        messages: [
          {
            id: 'u1',
            threadId: 't1',
            role: 'user',
            content: '帮我看看',
            kind: 'text',
            status: 'sent',
            timestamp: 0,
          },
        ],
      }),
    )
    expect(md).toContain('### 你')
    expect(md).toContain('帮我看看')
  })
})
