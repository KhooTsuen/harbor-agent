import { describe, expect, it } from 'vitest'
import { storedToUi } from '../disk'
import type { StoredMessage } from '@/types/backend'

/* ══════════════════════════════════════════════════════════════
   磁盘消息 → 界面消息

   这一步是「会话里存了什么」和「界面显示什么」之间唯一的转换点，
   漏一个字段就是「明明存了但看不见」。这次加的是 interrupted：
   上次进程被打断、只留下流式快照的那条，界面要说一句「这条没写完」。
   ══════════════════════════════════════════════════════════════ */

const base: StoredMessage = { role: 'assistant', content: '答案', ts: 123 }

describe('磁盘 → 界面', () => {
  it('基本字段都带过来', () => {
    const m = storedToUi(base, 't1')
    expect(m.threadId).toBe('t1')
    expect(m.role).toBe('assistant')
    expect(m.content).toBe('答案')
    expect(m.timestamp).toBe(123)
    expect(m.kind).toBe('text')
  })

  it('★ interrupted 要传上去（不然「这条没写完」就没人说）', () => {
    const m = storedToUi({ ...base, interrupted: true }, 't1')
    expect(m.interrupted).toBe(true)
  })

  it('没有 interrupted 时不要凭空加一个 false（老会话不受影响）', () => {
    expect('interrupted' in storedToUi(base, 't1')).toBe(false)
  })

  it('工具记录、引用、用量照旧带过来', () => {
    const m = storedToUi(
      {
        ...base,
        toolRuns: [{ id: 'x', name: 'read_file', ok: true, output: 'ok' }],
        citations: [{ id: 'c', kind: 'web', title: '来源', url: 'https://x' }],
        usage: { prompt: 1, completion: 2, total: 3, calls: 1, cached: 0 },
      },
      't1',
    )
    expect(m.toolRuns).toHaveLength(1)
    expect(m.citations).toHaveLength(1)
    expect(m.usage?.total).toBe(3)
  })

  it('报错的消息还是报错（kind / errorText 不变）', () => {
    const m = storedToUi({ ...base, error: '供应商 401' }, 't1')
    expect(m.kind).toBe('error')
    expect(m.errorText).toBe('供应商 401')
  })
})
