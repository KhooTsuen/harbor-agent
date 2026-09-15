import { describe, expect, it } from 'vitest'
import { mergeImport, migrateImport, CURRENT_VERSION } from '@/lib/migrations'
import type { Project, Thread } from '@/types'

function validThread(id = 't1'): Record<string, unknown> {
  return {
    id,
    projectId: 'p1',
    title: '导入的对话',
    mode: 'pair',
    model: 'x',
    reasoning: 'medium',
    messages: [{ id: 'm1', role: 'user', content: '你好', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('migrateImport', () => {
  it('接受合法数据并补齐缺省字段', () => {
    const result = migrateImport({ version: 1, threads: [validThread()] })
    expect(result.threads).toHaveLength(1)
    /* pinned / archived / tags 原数据没给，应该补上默认值 */
    expect(result.threads[0]?.pinned).toBe(false)
    expect(result.threads[0]?.archived).toBe(false)
    expect(result.threads[0]?.tags).toEqual([])
    expect(result.warnings).toHaveLength(0)
  })

  it('旧版本会提示已迁移', () => {
    const result = migrateImport({ version: 0, threads: [validThread()] })
    expect(result.threads).toHaveLength(1)
    expect(result.warnings.some((w) => w.includes('旧版本'))).toBe(true)
  })

  it('版本比当前新会提示', () => {
    const result = migrateImport({ version: CURRENT_VERSION + 5, threads: [] })
    expect(result.warnings.some((w) => w.includes('比当前程序'))).toBe(true)
  })

  it('非对象 / 结构不对直接拒绝', () => {
    expect(migrateImport(null).threads).toHaveLength(0)
    expect(migrateImport('不是对象').threads).toHaveLength(0)
    expect(migrateImport({ nope: true }).warnings[0]).toContain('文件结构不对')
  })

  it('单条线程坏掉只跳过那一条，其余照常导入', () => {
    const result = migrateImport({
      version: 1,
      threads: [validThread('a'), { 缺字段: true, id: 123 }, validThread('b')],
    })
    expect(result.threads).toHaveLength(2)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('第 2 条线程跳过')
  })

  it('没有项目时自动补一个兜底项目', () => {
    const result = migrateImport({ version: 1, threads: [validThread()] })
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0]?.name).toBe('导入的对话')
  })

  it('线程里缺 projectId 也会被兜底项目接住', () => {
    const thread = validThread()
    delete thread.projectId
    const result = migrateImport({ version: 1, threads: [thread] })
    expect(result.threads[0]?.projectId).toBe('imported')
  })
})

describe('mergeImport', () => {
  const existing = {
    threads: [{ id: 't1', title: '已有对话' } as Thread],
    projects: [{ id: 'p1', name: '已有项目' } as Project],
  }

  it('新 id 直接加入，排在前面', () => {
    const merged = mergeImport(existing, {
      threads: [{ id: 't2', title: '新的' } as Thread],
      projects: [],
    })
    expect(merged.threads[0]?.id).toBe('t2')
    expect(merged.addedThreads).toBe(1)
  })

  it('id 冲突时换新 id，不覆盖已有对话', () => {
    const merged = mergeImport(existing, {
      threads: [{ id: 't1', title: '撞名的' } as Thread],
      projects: [],
    })
    expect(merged.threads).toHaveLength(2)
    expect(merged.threads[0]?.id).not.toBe('t1')
    expect(merged.threads[0]?.title).toContain('导入')
    /* 原来那条还在 */
    expect(merged.threads.some((t) => t.id === 't1' && t.title === '已有对话')).toBe(true)
  })
})
