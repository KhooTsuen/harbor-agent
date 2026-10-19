import { describe, expect, it } from 'vitest'
import { allowedThreadsOf } from '../ArtifactsPanel'

/* ══════════════════════════════════════════════════════════════
   P2 #27：成果范围（当前对话 / 项目 / 全部）

   文档验收里最要紧的两条：
     · 当前对话视图**不会混入**其他对话的成果
     · 项目范围准确（含「纯聊天」这种没有项目的情况）
   ══════════════════════════════════════════════════════════════ */

const threads = [
  { id: 'a1', projectId: 'proj-a' },
  { id: 'a2', projectId: 'proj-a' },
  { id: 'b1', projectId: 'proj-b' },
  { id: 'loose' },
]

describe('P2 #27 成果范围判据', () => {
  it('当前对话：只放它自己，不混别的对话', () => {
    const allowed = allowedThreadsOf('thread', threads, 'a1')
    expect([...(allowed ?? [])]).toEqual(['a1'])
    expect(allowed?.has('a2')).toBe(false)
  })

  it('项目：只放同项目的兄弟对话（跨项目的不进来）', () => {
    const allowed = allowedThreadsOf('project', threads, 'a1')
    expect(allowed?.has('a1')).toBe(true)
    expect(allowed?.has('a2')).toBe(true)
    expect(allowed?.has('b1')).toBe(false)
  })

  it('项目：纯聊天（没有 projectId）只放它自己，不把别人的成果卷进来', () => {
    const allowed = allowedThreadsOf('project', threads, 'loose')
    expect([...(allowed ?? [])]).toEqual(['loose'])
  })

  it('全部：返回 null = 不过滤', () => {
    expect(allowedThreadsOf('all', threads, 'a1')).toBeNull()
  })

  it('当前对话已经不在列表里（被删了）→ 空集，不是全部', () => {
    const allowed = allowedThreadsOf('thread', threads, 'gone')
    expect(allowed?.size).toBe(0)
  })

  it('切换范围不会改动传入的对话数组（只读）', () => {
    const before = JSON.stringify(threads)
    allowedThreadsOf('project', threads, 'a1')
    allowedThreadsOf('all', threads, 'a1')
    expect(JSON.stringify(threads)).toBe(before)
  })
})
