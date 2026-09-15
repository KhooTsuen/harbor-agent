import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@/types/backend'
import { diagnoseModel, modelAfterRemoval } from '@/lib/modelCheck'

/* ══════════════════════════════════════════════════════════════
   模型名输入体检

   用户在「用哪个模型」里能打出各种东西，这里把该说的话说清楚。
   ══════════════════════════════════════════════════════════════ */

function provider(patch: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-x',
    chatPath: '/chat/completions',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    enabled: true,
    hasKey: true,
    ...patch,
  }
}

describe('diagnoseModel', () => {
  it('空值给出后果说明', () => {
    expect(diagnoseModel('', [provider()])).toContain('不能为空')
    expect(diagnoseModel('   ', [provider()])).toContain('不能为空')
  })

  it('清单里的模型没问题', () => {
    expect(diagnoseModel('deepseek-chat', [provider()])).toBeNull()
  })

  it('名字不在清单里会提示', () => {
    expect(diagnoseModel('gpt-5', [provider()])).toContain('不在任何供应商的清单里')
  })

  it('还没配清单时不啰嗦', () => {
    expect(diagnoseModel('随便打的', [provider({ models: [] })])).toBeNull()
  })

  it('模型所属供应商被停用时提示', () => {
    expect(diagnoseModel('deepseek-chat', [provider({ enabled: false })])).toContain('停用')
  })

  it('多个供应商时能找到正确的那家', () => {
    const other = provider({ id: 'p2', name: 'Opencode', models: ['other-model'], enabled: false })
    expect(diagnoseModel('other-model', [provider(), other])).toContain('Opencode')
    expect(diagnoseModel('deepseek-chat', [provider(), other])).toBeNull()
  })

  it('没有任何供应商时，非空值不算错', () => {
    expect(diagnoseModel('随便打的', [])).toBeNull()
  })
})

describe('modelAfterRemoval', () => {
  it('删的不是当前在用的，保持不变', () => {
    expect(modelAfterRemoval('a', 'b', ['a'])).toBe('a')
  })

  it('删的正是当前在用的，落到剩下的第一个', () => {
    expect(modelAfterRemoval('a', 'a', ['b', 'c'])).toBe('b')
  })

  it('删完一个不剩就清空', () => {
    expect(modelAfterRemoval('a', 'a', [])).toBe('')
  })
})
