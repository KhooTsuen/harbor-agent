import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { storedToUi } from '../disk'
import { bodyTextOf } from '@/lib/bodyText'
import { migrateFlow, purposeOf, FLOW_VERSION } from '@/lib/conversationFlow'
import type { StoredMessage } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   第二阶段：用途字段真的落盘、真的读回

   这里从**磁盘上的形状**（StoredMessage）开始走，而不是手搓一个 Message ——
   本项目栽过好几次「存了但读回时不带」（思考过程、图片、clarify、execId 都栽过），
   只测「我们自己的对象能读自己」是测不出这类漏字段的。
   ══════════════════════════════════════════════════════════════ */

const ROUNDS_TEXT = '结论：两个文件都没问题，可以继续。'

function stored(flow: StoredMessage['flow']): StoredMessage {
  return {
    role: 'assistant',
    key: 'msg_a1',
    content: ROUNDS_TEXT,
    ...(flow ? { flow } : {}),
    execId: 'req_1',
  }
}

describe('正文块用途 / 落盘与读回', () => {
  it('★★★ 四态原样通过 storedToUi（chatter / answer / final / unconfirmed）', () => {
    const flow = {
      version: 2 as const,
      turn: 2,
      nodes: [
        { kind: 'speech' as const, id: 0, turn: 0, text: '过程话', purpose: 'chatter' as const },
        { kind: 'speech' as const, id: 1, turn: 1, text: '答复片段', purpose: 'answer' as const },
        { kind: 'speech' as const, id: 2, turn: 2, text: '正式答复', purpose: 'final' as const },
        {
          kind: 'speech' as const,
          id: 3,
          turn: 2,
          text: '没确认',
          purpose: 'unconfirmed' as const,
        },
      ],
      final: '正式答复',
    }
    const ui = storedToUi(stored(flow), 'thread_1')
    expect(ui.flow?.nodes.map(purposeOf)).toEqual(['chatter', 'answer', 'final', 'unconfirmed'])
  })

  it('★★★ 老记录（v1，无 purpose）读回后按答复片段看待，且 version 归一', () => {
    const v1 = {
      version: 1 as const,
      turn: 1,
      nodes: [{ kind: 'speech' as const, id: 0, turn: 0, text: '老记录里的字' }],
    }
    const ui = storedToUi(stored(v1), 'thread_1')
    expect(ui.flow?.version).toBe(FLOW_VERSION)
    expect(purposeOf(ui.flow!.nodes[0])).toBe('answer')
  })

  it('★★★ 有 flow.final 时，正文取它**唯一一份**（显示/复制/导出同源）', () => {
    const flow = {
      version: 2 as const,
      turn: 1,
      nodes: [
        { kind: 'speech' as const, id: 0, turn: 0, text: '过程话', purpose: 'chatter' as const },
        { kind: 'speech' as const, id: 1, turn: 1, text: '正式答复', purpose: 'final' as const },
      ],
      final: '正式答复',
    }
    const ui = storedToUi(stored(flow), 'thread_1')
    /* content 是最后一轮；flow.final 是结算后的那一份 —— 两者不同时以 final 为准 */
    expect(ui.content).toBe(ROUNDS_TEXT)
    expect(bodyTextOf(ui)).toBe('正式答复')
  })

  it('★★ 没结算的老记录：正文退回 rounds/content，不返回空串', () => {
    const ui = storedToUi(stored(undefined), 'thread_1')
    expect(ui.flow).toBeUndefined()
    expect(bodyTextOf(ui)).toBe(ROUNDS_TEXT)
  })

  it('★★ v1 迁移是纯函数：不改入参（老会话读出来不被抹上写入痕迹）', () => {
    const v1 = {
      version: 1 as const,
      turn: 1,
      nodes: [{ kind: 'speech' as const, id: 0, turn: 0, text: 'x' }],
    }
    const snapshot = JSON.parse(JSON.stringify(v1))
    migrateFlow(v1)
    expect(v1).toEqual(snapshot)
  })
})

describe('正文块用途 / 真相源对齐', () => {
  it('★★★ schema 里声明的四态与代码常量逐字一致（防两边各写一套）', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/conversationFlow.ts'), 'utf8')
    /* 常量本身是唯一真相源；这里钉的是它**没有被拆成两份字面量** */
    expect(src.match(/SPEECH_PURPOSES = \[/g)?.length).toBe(1)
    for (const purpose of ['chatter', 'answer', 'final', 'unconfirmed']) {
      expect(src).toContain(`'${purpose}'`)
    }
  })

  it('★★★ 渲染层按 purpose 分流，不再把所有 speech 都塞进过程区', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/chat/message/ConversationFlowView.tsx'),
      'utf8',
    )
    /* 过程区的过滤条件必须提到 purposeOf —— 否则「同一段显示两遍」会回来 */
    expect(src).toMatch(/processNodes[\s\S]{0,120}purposeOf/)
    expect(src).toContain('data-flow-unconfirmed')
  })
})
