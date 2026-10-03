import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Message } from '@/types'
import { adviseCompact, DEFAULT_AUTO_RATIO, DEFAULT_WARN_RATIO } from '../compact'

/* ══════════════════════════════════════════════════════════════
   压缩的两条线：配置与默认值不许漂（2026-10-04）

   以前渲染层写死 0.4 / 0.6，内核 `config-defaults.cjs` 里另有一份 ——
   用户在设置页改百分比，界面上照旧按 0.4/0.6 判，**改了不生效**。

   现在：调用方把配置值传进来；这里的默认值必须与内核一致（下面直接读内核那份比）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const require_ = createRequire(import.meta.url)
const defaults = require_(join(ROOT, 'electron/core/config-defaults.cjs')) as {
  defaults?: { context?: { compactAt?: number; autoCompactAt?: number } }
  DEFAULTS?: { context?: { compactAt?: number; autoCompactAt?: number } }
  context?: { compactAt?: number; autoCompactAt?: number }
}
const kernelContext =
  defaults.defaults?.context ?? defaults.DEFAULTS?.context ?? defaults.context ?? {}

/** 造一批消息，凑到指定的估算用量（每条约 3 字符 = 1 token） */
function messagesOf(tokens: number): Message[] {
  const per = 300
  const count = Math.max(1, Math.ceil(tokens / per))
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    threadId: 't',
    role: 'user',
    content: 'x'.repeat(per * 3),
    kind: 'text',
    status: 'sent',
    timestamp: 0,
  })) as Message[]
}

describe('压缩的两条线', () => {
  it('★ 默认值与内核 config-defaults 一致（改了一边另一边必须跟着）', () => {
    expect(kernelContext.compactAt).toBe(DEFAULT_WARN_RATIO)
    expect(kernelContext.autoCompactAt).toBe(DEFAULT_AUTO_RATIO)
  })

  it('★ 传了配置值就按配置判（改设置必须生效）', () => {
    const messages = messagesOf(5000)
    /* 用极限值把两条线拉开：限制 20000 →用量约 25% */
    const base = adviseCompact(messages, 20000)
    expect(base.warn).toBe(false)
    expect(base.auto).toBe(false)

    const strict = adviseCompact(messages, 20000, { warn: 0.2, auto: 0.24 })
    expect(strict.warn).toBe(true)
    expect(strict.auto).toBe(true)

    const loose = adviseCompact(messages, 20000, { warn: 0.9, auto: 0.95 })
    expect(loose.warn).toBe(false)
    expect(loose.auto).toBe(false)
  })

  it('缺字段 / NaN / undefined 一律退回默认值（脏配置不能让判定失效）', () => {
    const messages = messagesOf(20000)
    const a = adviseCompact(messages, 20000, {})
    expect(a.warn).toBe(true)
    expect(a.auto).toBe(true)
    const b = adviseCompact(messages, 20000, { warn: undefined, auto: undefined })
    expect(b.warn).toBe(true)
    const c = adviseCompact(messages, 20000, { warn: Number.NaN, auto: Number.NaN })
    expect(c.auto).toBe(true)
  })

  it('0 / 没填 maxTokens → 用上下文基准（与内核同一个数）', () => {
    const advice = adviseCompact(messagesOf(100), 0)
    expect(advice.limit).toBeGreaterThan(2000)
  })
})
