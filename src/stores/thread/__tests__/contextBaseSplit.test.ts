import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTEXT_BASE_TOKENS } from '@/constants'

/* ══════════════════════════════════════════════════════════════
   上下文基准 vs 输出上限：这两件事必须分开（2026-10-04 收尾第三步）

   以前：`context-builder` 的「上下文基准」直接拿设置里的 `assistant.maxTokens`
   （输出上限）。后果 —— 用户想把回复写长一点，把输出上限从 0 改成 20000，
   系统提示 / 项目文件 / 记忆的额度**全都跟着涨**，没人会预料到；
   反过来想省上下文，就得把输出上限压小，回复也跟着变短。两件事互相掐。

   现在：内核新增 `context.baseTokens`（默认 16384），上下文那一路只认它；
   输出那一路（`loop.cjs` / `loop-model.cjs` → `llm-body` 的 `max_tokens`）**一个字没动**。

   这一组钉四件事：
     ① 解耦成立：填了 `assistant.maxTokens` 不会再动上下文基准；
     ② 新字段自己生效，且 0 / 不填当「没设置」→ 回默认（不是压成下限）；
     ③ 坏值被夹住（2000–128000）；
     ④ 接线没接错：内核提示层读的是 `context.baseTokens`，输出层读的还是 `assistant.maxTokens`。
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
  it('★ 把输出上限填成 20000，上下文基准**不动**（还是 16384）', () => {
    const cfg = normalized({ assistant: { maxTokens: 20000 } })
    expect(cfg.assistant.maxTokens).toBe(20000)
    expect(cfg.context.baseTokens).toBe(16384)
  })

  it('★ 输出上限填 0（不限）也是同一个基准（老用户零影响）', () => {
    expect(normalized({ assistant: { maxTokens: 0 } }).context.baseTokens).toBe(16384)
    expect(normalized({}).context.baseTokens).toBe(16384)
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

  it('填 0 = 没设置 → 回默认（不是被夹成下限 2000）', () => {
    expect(normalized({ context: { baseTokens: 0 } }).context.baseTokens).toBe(16384)
  })

  it('填了垃圾值（字符串/空/缺失）→ 回默认；越界值 → 夹到区间内', () => {
    const cases: [unknown, number][] = [
      ['abc', 16384],
      [null, 16384],
      [undefined, 16384],
      [-5, 2000],
      [100, 2000],
      [9999999, 128000],
    ]
    for (const [input, want] of cases) {
      expect(normalized({ context: { baseTokens: input } }).context.baseTokens).toBe(want)
    }
  })

  it('基准数字本身是「1.5 万量级」：渲染层默认值与内核默认值必须相同', () => {
    /* 跨进程没法共享常量，只能靠这条盯着（同 contextBaseDrift.test.ts 的做法） */
    expect(CONTEXT_BASE_TOKENS).toBe(normalized({}).context.baseTokens)
  })
})

describe('上下文基准 / 接线没接错（源码级）', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

  it('★ 提示层读 context.baseTokens，且**不再**读 assistant.maxTokens', () => {
    const src = read('electron/core/loop-prompt.cjs')
    expect(src).toContain('config.context?.baseTokens')
    expect(src).not.toContain('config.assistant.maxTokens')
  })

  it('★ 输出层读的还是 assistant.maxTokens（这条不能跟着改）', () => {
    const src = read('electron/core/loop-model.cjs')
    expect(src).toContain('config.assistant.maxTokens')
  })

  it('★ 渲染层的压缩提示线也读 context.baseTokens', () => {
    const src = read('src/stores/useThreadStore.ts')
    expect(src).toContain('cfg?.context?.baseTokens')
    expect(src).not.toContain('cfg?.assistant.maxTokens')
  })

  it('设置页那个输入框仍然是「输出上限」（写 assistant.maxTokens）', () => {
    const src = read('src/components/settings/ProviderPanel.tsx')
    expect(src).toContain('patchAssistant({ maxTokens')
  })
})
