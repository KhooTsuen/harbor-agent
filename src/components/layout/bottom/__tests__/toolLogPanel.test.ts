import { describe, expect, it } from 'vitest'
import type { AuditEntry } from '@/types/safety'
import { summarize } from '../ToolLogPanel'

/* ══════════════════════════════════════════════════════════════
   运行日志的行摘要

   一条日志在列表里只占一行，摘要只能取一个字段 —— 优先级得钉死：
   error（失败要看原因）→ 文件（改了哪个）→ 网络目标（访问了什么）
   → result（结果文本）。顺序乱了，列表里最该看的失败信息会被
   无关的 result 挤掉。
   ══════════════════════════════════════════════════════════════ */

function base(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: 0,
    sessionId: '',
    taskId: '',
    tool: 'read_file',
    permission: '',
    approval: null,
    startedAt: 0,
    finishedAt: 0,
    ms: 1,
    ok: true,
    error: '',
    affectedFiles: [],
    networkTarget: '',
    ...overrides,
  }
}

describe('summarize', () => {
  it('★ 失败原因（error）优先级最高', () => {
    expect(summarize(base({ error: '权限不足', result: '好的结果' }))).toBe('权限不足')
  })

  it('没有 error 时用受影响文件', () => {
    expect(summarize(base({ affectedFiles: ['src/a.ts'] }))).toBe('src/a.ts')
  })

  it('没有文件时用网络目标', () => {
    expect(summarize(base({ networkTarget: 'https://example.com' }))).toBe('https://example.com')
  })

  it('最后才用 result', () => {
    expect(summarize(base({ result: '完成' }))).toBe('完成')
  })

  it('全空返回空字符串', () => {
    expect(summarize(base())).toBe('')
  })
})
