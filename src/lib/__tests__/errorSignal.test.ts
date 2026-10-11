import { describe, expect, it } from 'vitest'
import type { ErrorEntry } from '@/types/errors'
import { countUnreadSevere, isSevere, worstUnreadSeverity } from '../errorSignal'

/* ══════════════════════════════════════════════════════════════
   Phase 1 · A1：错误「未读」信号的纯函数

   角标和面板共用这一份判据 —— 这里钉住「什么算严重」「什么算未读」，
   免得三处各写一套（跨模块约定只有一处真相源）。
   ══════════════════════════════════════════════════════════════ */

const entry = (over: Partial<ErrorEntry>): ErrorEntry => ({
  key: 'k',
  kind: 'tool_failure',
  severity: 'P0',
  message: 'm',
  hint: '',
  origin: 'tool',
  location: 'x',
  firstSeen: 0,
  lastSeen: 0,
  count: 1,
  needsUser: false,
  retryable: false,
  raw: '',
  context: { tool: '', taskId: '', sessionId: '' },
  ...over,
})

describe('Phase 1 · A1 / 严重性', () => {
  it('只有 P0 / P1 算「严重」（P2/P3 是「不是故障」，不点亮角标）', () => {
    expect(isSevere('P0')).toBe(true)
    expect(isSevere('P1')).toBe(true)
    expect(isSevere('P2')).toBe(false)
    expect(isSevere('P3')).toBe(false)
  })
})

describe('Phase 1 · A1 / 未读判定', () => {
  it('只数严重 + lastSeen 晚于已读线的那几条', () => {
    const entries = [
      entry({ severity: 'P0', lastSeen: 200 }), // 新的严重 → 算
      entry({ severity: 'P1', lastSeen: 150 }), // 新的严重 → 算
      entry({ severity: 'P2', lastSeen: 200 }), // 不是严重 → 不算
      entry({ severity: 'P0', lastSeen: 100 }), // 老的 → 不算
    ]
    expect(countUnreadSevere(entries, 120)).toBe(2)
  })

  it('★ 一条老错误又发生了一次（lastSeen 变新）也算新动静', () => {
    expect(countUnreadSevere([entry({ severity: 'P1', firstSeen: 1, lastSeen: 300 })], 200)).toBe(1)
  })

  it('已读线之后没有严重错误 → 0', () => {
    expect(countUnreadSevere([entry({ severity: 'P3', lastSeen: 300 })], 200)).toBe(0)
    expect(countUnreadSevere([], 0)).toBe(0)
  })

  it('最严重一级：有 P0 就取 P0（角标颜色据此选）', () => {
    const entries = [
      entry({ severity: 'P1', lastSeen: 300 }),
      entry({ severity: 'P0', lastSeen: 400 }),
    ]
    expect(worstUnreadSeverity(entries, 200)).toBe('P0')
  })

  it('只有 P1 → 返回 P1；没有未读 → null', () => {
    expect(worstUnreadSeverity([entry({ severity: 'P1', lastSeen: 300 })], 200)).toBe('P1')
    expect(worstUnreadSeverity([entry({ severity: 'P0', lastSeen: 100 })], 200)).toBe(null)
    expect(worstUnreadSeverity([], 0)).toBe(null)
  })

  it('★ 真机形状：lastSeen 是 ISO 字符串时也要算得对（类型写的是 number，实际是字符串）', () => {
    /* 内核 error-reader 直接把记录的 ts（ISO 字符串）透传出来；按数字比会恒 false */
    const iso = '2026-10-11T15:33:00.000Z' as unknown as number
    const entries = [entry({ severity: 'P0', lastSeen: iso })]
    const before = Date.parse('2026-10-11T15:30:00.000Z')
    const after = Date.parse('2026-10-11T15:40:00.000Z')
    expect(countUnreadSevere(entries, before)).toBe(1)
    expect(worstUnreadSeverity(entries, before)).toBe('P0')
    expect(countUnreadSevere(entries, after)).toBe(0)
  })

  it('时间戳缺失 / 空串时不误判为「未读」', () => {
    expect(
      countUnreadSevere([entry({ severity: 'P0', lastSeen: '' as unknown as number })], 0),
    ).toBe(0)
    expect(
      countUnreadSevere([entry({ severity: 'P0', lastSeen: undefined as unknown as number })], 0),
    ).toBe(0)
  })
})
