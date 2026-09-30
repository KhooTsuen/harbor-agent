import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   检查点回退的桥包装（AG-052）

   界面侧最容易写错的两件事，这里各钉一条：
     · **预览必须走 dryRun**（写成真撤的话，用户还没点确认盘上就已经被改了）
     · **回执形状要收拢**（内核失败时也给空数组，界面不必到处判空）

   桥是在模块加载时抓的（`window.workbench`），所以这里用 `vi.hoisted` 抢在
   导入之前把它摆好。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => {
  const calls: Array<Record<string, unknown>> = []
  let reply: unknown = { ok: true, restored: [], removed: [], failed: [], skipped: [] }
  let throwIt = false
  ;(globalThis as unknown as { window: Window }).window.workbench = {
    changesetRollbackTo: async (payload: Record<string, unknown>) => {
      calls.push(payload)
      if (throwIt) throw new Error('桥炸了')
      return reply
    },
  } as unknown as Window['workbench']
  return {
    calls,
    setReply: (value: unknown) => {
      reply = value
    },
    setThrow: (value: boolean) => {
      throwIt = value
    },
  }
})

import {
  describeRollback,
  rollbackApply,
  rollbackBridgeReady,
  rollbackImpact,
  rollbackPreview,
  shortPath,
  type RollbackResult,
} from '@/lib/checkpointRollbackApi'

const result = (patch: Partial<RollbackResult> = {}): RollbackResult => ({
  ok: true,
  restored: [],
  removed: [],
  failed: [],
  skipped: [],
  changesets: [],
  ...patch,
})

beforeEach(() => {
  h.calls.length = 0
  h.setReply({ ok: true, restored: [], removed: [], failed: [], skipped: [] })
  h.setThrow(false)
})

describe('桥包装', () => {
  it('桥在（桌面版）', () => {
    expect(rollbackBridgeReady()).toBe(true)
  })

  it('★ 预览走 dryRun: true —— 还没点确认，盘上一个字都不该动', async () => {
    await rollbackPreview('task_1', 1790795487542)
    expect(h.calls[0]?.dryRun).toBe(true)
    expect(h.calls[0]?.taskId).toBe('task_1')
    expect(h.calls[0]?.checkpointId).toBe(1790795487542)
  })

  it('★ 真撤走 dryRun: false', async () => {
    await rollbackApply('task_1', '1790795487542')
    expect(h.calls[0]?.dryRun).toBe(false)
  })

  it('回执收成确定的形状（缺字段给空数组，界面不必判空）', async () => {
    h.setReply({ ok: true, restored: ['E:/demo/a.txt'] })
    const got = await rollbackPreview('task_1', 1)
    expect(got.ok).toBe(true)
    expect(got.restored).toEqual(['E:/demo/a.txt'])
    expect(got.removed).toEqual([])
    expect(got.failed).toEqual([])
    expect(got.skipped).toEqual([])
  })

  it('桥抛异常 → 变成 ok:false（不让整个界面白屏）', async () => {
    h.setThrow(true)
    const got = await rollbackPreview('task_1', 1)
    expect(got.ok).toBe(false)
    expect(String(got.error)).toContain('桥炸了')
  })
})

describe('措辞', () => {
  it('★ 影响预览把四类都说清：恢复 / 删除 / 留着 / 撤不回去', () => {
    const lines = rollbackImpact(
      result({
        restored: ['E:/demo/a.txt', 'E:/demo/b.txt'],
        removed: ['E:/demo/new.txt'],
        skipped: [{ path: 'E:/demo/old.txt', reason: '在检查点之前' }],
        failed: [{ path: 'E:/demo/broken.txt', reason: '快照文件不见了' }],
      }),
    )
    expect(lines.join('\n')).toContain('恢复 2 个')
    expect(lines.join('\n')).toContain('删掉 1 个')
    expect(lines.join('\n')).toContain('留着 1 个')
    expect(lines.join('\n')).toContain('1 个撤不回去')
    /* 失败原因要露出中文那句（不然用户不知道为什么没撤成） */
    expect(lines.join('\n')).toContain('快照文件不见了')
  })

  it('没可撤的改动 → 明说「撤了也不会变」，不留空白', () => {
    expect(rollbackImpact(result()).join()).toContain('没有可撤的改动')
  })

  it('结果说成一句话（恢复 / 删除 / 留着 / 没成功）', () => {
    expect(
      describeRollback(
        result({
          restored: ['a'],
          removed: ['b'],
          skipped: [{ path: 'c' }],
          failed: [{ path: 'd', reason: 'x' }],
        }),
      ),
    ).toBe('恢复 1 个 · 删除 1 个 · 1 个撤不动、原样留着 · 1 个没成功')
  })

  it('路径只显示末两段（完整路径太长会把一行挤爆）', () => {
    expect(shortPath('E:/CodexWorkbench/tmp/tok/verify/a.txt')).toBe('verify/a.txt')
    expect(shortPath('a.txt')).toBe('a.txt')
  })
})
