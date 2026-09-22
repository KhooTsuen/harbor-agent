import { describe, expect, it } from 'vitest'
import { activateVersion, pushVersion } from '../messageVersions'
import type { Message } from '@/types'

/* ══════════════════════════════════════════════════════════════
   用户消息的「多版本」纯逻辑

   编辑一条消息 = 同一条消息多一版，不是多出一条一模一样的提问。
   这里只测两个纯函数；「点了编辑界面到底怎么变」在
   `components/chat/__tests__/messageEditor.test.tsx` 里真渲染着测。
   ══════════════════════════════════════════════════════════════ */

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'u1',
  threadId: 't1',
  role: 'user',
  content: '原问题',
  kind: 'text',
  status: 'sent',
  timestamp: 1,
  ...over,
})

describe('pushVersion', () => {
  it('★ 第一次编辑：把原文补成第 1 版，新内容是第 2 版', () => {
    const patch = pushVersion(msg(), '新问题')
    expect(patch.versions).toEqual(['原问题', '新问题'])
    expect(patch.versionIndex).toBe(1)
    expect(patch.content).toBe('新问题')
    expect(patch.edited).toBe(true)
  })

  it('已经有版本表时往后追，不重写前面的', () => {
    const patch = pushVersion(msg({ versions: ['v1', 'v2'], versionIndex: 0, content: 'v1' }), 'v3')
    expect(patch.versions).toEqual(['v1', 'v2', 'v3'])
    expect(patch.versionIndex).toBe(2)
  })

  it('内容和最后一版一样就不重复追加（连点两次保存不该多出一版）', () => {
    const patch = pushVersion(msg({ versions: ['v1', 'v2'], versionIndex: 1, content: 'v2' }), 'v2')
    expect(patch.versions).toEqual(['v1', 'v2'])
    expect(patch.versionIndex).toBe(1)
  })
})

describe('activateVersion', () => {
  const two = msg({ content: 'v2', versions: ['v1', 'v2'], versionIndex: 1 })

  it('切到第 1 版', () => {
    const patch = activateVersion(two, 0)
    expect(patch?.content).toBe('v1')
    expect(patch?.versionIndex).toBe(0)
  })

  it('★ 越界返回 null（调用方什么都不做 —— 不能因为一个错索引把内容改坏）', () => {
    expect(activateVersion(two, -1)).toBeNull()
    expect(activateVersion(two, 2)).toBeNull()
    expect(activateVersion(two, 99)).toBeNull()
  })

  it('没有版本表的老消息当单版本处理，只认第 0 版', () => {
    expect(activateVersion(msg(), 0)?.content).toBe('原问题')
    expect(activateVersion(msg(), 1)).toBeNull()
  })
})
