import { describe, expect, it } from 'vitest'
import { runningOf } from '../agentActivity'
import type { ToolRunRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════
   「正在跑」不许把「上次中断的」算进去（2026-11-09 真机逮到）

   ── 病 ────────────────────────────────────────────────────────
   `runningOf` 的判据是「没有 output、也没有 ms」= 还在跑。
   而从磁盘读回的 pending 记录（结果未确认）**恰好也是** output='' 且 ms=undefined ——
   于是重启后界面上写着「正在读取 b.js · 进行中」，可那个进程早就没了。

   真机证据：种子会话里那条 pending 工具，修复前显示 `进行中`，
   修复后显示 `1 项结果未确认`（data-tool-status=unconfirmed）。

   ── 修法 ──────────────────────────────────────────────────────
   `runningOf` 排除 `pending === true`。判据仍是同一处（这个函数），不另写一份。
   ══════════════════════════════════════════════════════════════ */

const run = (patch: Partial<ToolRunRecord>): ToolRunRecord => ({
  id: 'tc1',
  name: 'read_file',
  ok: true,
  output: '',
  ...patch,
})

describe('未确认工具 / 不算「正在跑」', () => {
  it('★★★ pending 的记录不能被当成正在跑', () => {
    expect(runningOf([run({ pending: true })])).toBeUndefined()
  })

  it('★★ 真在跑（无 output 无 ms、也没有 pending）→ 仍被认出来', () => {
    const r = run({})
    expect(runningOf([r])).toBe(r)
  })

  it('★★ 已完成（有 ms）→ 不是正在跑', () => {
    expect(runningOf([run({ ms: 30 })])).toBeUndefined()
  })

  it('★★ 有输出但没 ms（老记录）→ 不是正在跑', () => {
    expect(runningOf([run({ output: 'ok' })])).toBeUndefined()
  })

  it('★★★ 混合：pending 在前、真在跑在后 → 找到真在跑的那条', () => {
    const pending = run({ id: 'a', pending: true })
    const live = run({ id: 'b' })
    expect(runningOf([pending, live])).toBe(live)
  })
})
