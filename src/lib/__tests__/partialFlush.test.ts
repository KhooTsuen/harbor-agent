import { describe, expect, it } from 'vitest'
import { PARTIAL_MIN_GROWTH, PARTIAL_MIN_MS, shouldFlushPartial } from '../partialFlush'

/* ══════════════════════════════════════════════════════════════
   流式回复的落盘节奏

   为什么值得单独测：写太勤会把磁盘和 IPC 打满（会话文件是**追加式**的，
   每次都要写整段内容，n 次追加 × 平均半篇 ≈ n²），写太懒则进程被中断时
   最后那几分钟内容全丢。规则就是这条，测清楚它就不会被顺手改坏。
   ══════════════════════════════════════════════════════════════ */

const T = 1_000_000

describe('分段落盘 / 该不该写', () => {
  it('内容还不到最小值 → 不写（刚开头那几个字不值当单写一行）', () => {
    expect(shouldFlushPartial(20, 0, T, T - 10_000)).toBe(false)
  })

  it('长度够了但离上次太近 → 不写', () => {
    expect(shouldFlushPartial(5000, 0, T, T - 500)).toBe(false)
  })

  it('★ 长度够 + 隔够时间 → 写', () => {
    expect(shouldFlushPartial(PARTIAL_MIN_GROWTH, 0, T, T - PARTIAL_MIN_MS)).toBe(true)
  })

  it('第一次（还没写过）也守间隔规则：lastAt=0 时不看间隔', () => {
    expect(shouldFlushPartial(1000, 0, T, 0)).toBe(true)
  })

  it('★ 长文按 10% 走：只长了 5% 就先不写', () => {
    const len = 10_000
    expect(shouldFlushPartial(len, len - 500, T, T - PARTIAL_MIN_MS)).toBe(false)
    expect(shouldFlushPartial(len, len - 1_200, T, T - PARTIAL_MIN_MS)).toBe(true)
  })

  it('★ 短文看那个小下限就够（30 字以上、隔够时间就写）', () => {
    expect(shouldFlushPartial(60, 0, T, T - PARTIAL_MIN_MS)).toBe(true)
  })

  it('空内容不写（免得文件里多一行空的）', () => {
    expect(shouldFlushPartial(0, 0, T, 0)).toBe(false)
    expect(shouldFlushPartial(-1, 0, T, 0)).toBe(false)
  })

  it('内容变短（不该发生）也不写', () => {
    expect(shouldFlushPartial(500, 900, T, T - PARTIAL_MIN_MS)).toBe(false)
  })
})
