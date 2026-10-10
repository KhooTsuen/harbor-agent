import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTEXT_BASE_TOKENS } from '@/constants'

/* ══════════════════════════════════════════════════════════════
   上下文基准：`min(模型窗口 × 80%, 用户上限)`（2026-10-11 起跟随窗口）

   更早：`context-builder` 的「上下文基准」直接拿设置里的 `assistant.maxTokens`
   （输出上限）—— 把回复写长的同时把系统提示 / 项目文件 / 记忆的额度也顶大了。
   2026-10-04：拆成 `context.baseTokens`（默认 16384），但它是**死值**，
   与模型窗口脱钩 —— 换成 1M 窗口的模型也没用（对话层照旧 14745 字符）。
   2026-10-11：基准跟随窗口，`context.baseTokens` 变成用户在设置里给的**上限/刹车**。

   这一组钉：
     ① 和输出上限仍拆开（填 assistant.maxTokens 不动上下文基准）；
     ② `context.baseTokens`：0 / 不填 = 跟随窗口；显式值 = 上限；坏值被夹（0–1000000）；
     ③ 接线没接错：内核提示层用 `context-window.effectiveBaseTokens`，渲染层也读它。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const require_ = createRequire(import.meta.url)
const { normalize } = require_(join(ROOT, 'electron/core/config-normalize.cjs')) as {
  normalize: (raw: unknown) => {
    assistant: { maxTokens: number }
    context: { baseTokens: number; compactAt: number; autoCompactAt: number }
  }
}

/** 只给最小输入，其余全走默认（跟真机上「用户只改了一个字段」一样） */
function normalized(raw: Record<string, unknown>) {
  return normalize(raw)
}

describe('上下文基准 / 和输出上限拆开了', () => {
  it('★ 把输出上限填成 20000，上下文基准**不动**（还是默认 0）', () => {
    const cfg = normalized({ assistant: { maxTokens: 20000 } })
    expect(cfg.assistant.maxTokens).toBe(20000)
    expect(cfg.context.baseTokens).toBe(0)
  })

  it('★ 输出上限填 0（不限）也是同一个默认（老用户零影响）', () => {
    expect(normalized({ assistant: { maxTokens: 0 } }).context.baseTokens).toBe(0)
    expect(normalized({}).context.baseTokens).toBe(0)
  })

  it('反方向也成立：改上下文基准不会碰到输出上限', () => {
    const cfg = normalized({ assistant: { maxTokens: 0 }, context: { baseTokens: 32000 } })
    expect(cfg.context.baseTokens).toBe(32000)
    expect(cfg.assistant.maxTokens).toBe(0)
  })
})

describe('上下文基准 / 新字段自己的行为', () => {
  it('显式填的值生效', () => {
    expect(normalized({ context: { baseTokens: 24000 } }).context.baseTokens).toBe(24000)
  })

  it('填 0 = 没设置 = 跟随窗口（不是被夹成某个下限）', () => {
    expect(normalized({ context: { baseTokens: 0 } }).context.baseTokens).toBe(0)
    expect(normalized({}).context.baseTokens).toBe(0)
  })

  it('填了垃圾值（字符串/空/缺失）→ 回默认 0；越界值 → 夹到 0–1000000', () => {
    const cases: [unknown, number][] = [
      ['abc', 0],
      [null, 0],
      [undefined, 0],
      [-5, 0],
      [100, 100],
      [9999999, 1000000],
    ]
    for (const [input, want] of cases) {
      expect(normalized({ context: { baseTokens: input } }).context.baseTokens).toBe(want)
    }
  })

  it('★ 旧盘上落盘的死值默认 16384 → 迁移成 0（否则老用户跟随窗口永远不生效）', () => {
    expect(normalized({ context: { baseTokens: 16384 } }).context.baseTokens).toBe(0)
  })

  it('★ 默认值为 0（跟随窗口），而 16384 只是「窗口未知」时的死值兜底', () => {
    expect(normalized({}).context.baseTokens).toBe(0)
    /* 兜底死值在渲染层常量里，且它现在**不等于**配置默认值 —— 两者语义已分开 */
    expect(CONTEXT_BASE_TOKENS).toBe(16384)
  })
})

describe('上下文基准 / 接线没接错（源码级）', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

  it('★ 提示层用 context-window 的算法算基准，且**不再**读 assistant.maxTokens', () => {
    const src = read('electron/core/loop-prompt.cjs')
    expect(src).toContain('contextWindow.effectiveBaseTokens(')
    expect(src).not.toContain('config.assistant.maxTokens')
  })

  it('★ 算法只在 context-window.cjs 一处（内核侧唯一真相源）', () => {
    const src = read('electron/core/context-window.cjs')
    expect(src).toContain('Math.min(fromWindow, userCap)')
  })

  it('★ 输出层读的还是 assistant.maxTokens（这条不能跟着改）', () => {
    const src = read('electron/core/loop-model.cjs')
    expect(src).toContain('config.assistant.maxTokens')
  })

  it('★ 渲染层的压缩提示线仍读 context.baseTokens（作为窗口未知时的兜底）', () => {
    const src = read('src/stores/useThreadStore.ts')
    expect(src).toContain('cfg?.context?.baseTokens')
  })

  it('设置页那个输入框仍然是「输出上限」（写 assistant.maxTokens）', () => {
    const src = read('src/components/settings/ProviderPanel.tsx')
    expect(src).toContain('patchAssistant({ maxTokens')
  })
})
