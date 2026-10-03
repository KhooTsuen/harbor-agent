import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   提示词上限：**唯一真相源**（2026-10-04）

   以前 `project.cjs`（AGENT.md）12000、`project-rules.cjs`（规则目录）8000
   各写各的，而 `context-builder.cjs` 的项目层下限又把两者**相加**算出来 ——
   三处数字、两个来源。改一个另两个漂，而且不会红：症状是「文件明明在上限以内，
   进上下文还是被切」。

   这里钉两件事：
     ① 三个值都等于 `prompt-limits.cjs` 里的那一个（数值一致）；
     ② 源码里**不许再出现写死的上限**（否则「改一处」这条承诺立刻失效）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..', '..')
const require_ = createRequire(import.meta.url)
const limits = require_(join(ROOT, 'electron/core/prompt-limits.cjs')) as {
  MAX_AGENT_MD_CHARS: number
  MAX_RULES_CHARS: number
  PROJECT_FLOOR_CHARS: number
}
const project = require_(join(ROOT, 'electron/core/project.cjs')) as { MAX_CHARS: number }
const rules = require_(join(ROOT, 'electron/core/project-rules.cjs')) as { MAX_CHARS: number }
const contextBuilder = require_(join(ROOT, 'electron/core/context-builder.cjs')) as {
  PROJECT_FLOOR: number
}

describe('提示词上限 / 单一真相源', () => {
  it('三个使用点都跟着 prompt-limits 走', () => {
    expect(project.MAX_CHARS).toBe(limits.MAX_AGENT_MD_CHARS)
    expect(rules.MAX_CHARS).toBe(limits.MAX_RULES_CHARS)
    expect(contextBuilder.PROJECT_FLOOR).toBe(limits.PROJECT_FLOOR_CHARS)
  })

  it('★ 项目层下限 = 两个生产者上限之和 + 余量（不然「文件在上限内还被切」）', () => {
    expect(limits.PROJECT_FLOOR_CHARS).toBe(
      limits.MAX_AGENT_MD_CHARS + limits.MAX_RULES_CHARS + 1024,
    )
    expect(limits.PROJECT_FLOOR_CHARS).toBeGreaterThan(
      limits.MAX_AGENT_MD_CHARS + limits.MAX_RULES_CHARS,
    )
  })

  it('★ 两个生产者源码里不再出现写死的上限（改一处就该到处跟着变）', () => {
    for (const rel of ['electron/core/project.cjs', 'electron/core/project-rules.cjs']) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      /* 允许 `= MAX_AGENT_MD_CHARS` / `= MAX_RULES_CHARS`，不许 `= 12000` / `= 8000` */
      expect(/const MAX_CHARS = \d/.test(src), `${rel} 里还写着数字`).toBe(false)
      expect(/const MAX_CHARS = MAX_/.test(src), `${rel} 没从 prompt-limits 取`).toBe(true)
    }
    const cb = readFileSync(join(ROOT, 'electron/core/context-builder.cjs'), 'utf8')
    expect(/PROJECT_FLOOR\s*=\s*[\d]/.test(cb)).toBe(false)
  })

  it('数值本身守规矩（AGENT.md 比规则目录宽，两者都 > 0）', () => {
    expect(limits.MAX_AGENT_MD_CHARS).toBeGreaterThan(0)
    expect(limits.MAX_RULES_CHARS).toBeGreaterThan(0)
    expect(limits.MAX_AGENT_MD_CHARS).toBeGreaterThan(limits.MAX_RULES_CHARS)
  })
})
