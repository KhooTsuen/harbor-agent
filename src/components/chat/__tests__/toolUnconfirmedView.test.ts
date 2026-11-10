import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ══════════════════════════════════════════════════════════════
   「结果未确认」在界面上必须和「成功」分开（2026-11-09）

   ── 为什么读源码而不是渲染 ────────────────────────────────────
   `ToolLine` 依赖滚动守卫与手册展开状态，整棵树渲染代价大。
   这里钉的是**判据本身**：`pendingCount` 只认 `pending`，
   状态文字的四个分支顺序是 进行中 > 失败 > 未确认 > 成功。

   ★ 最要紧的一条：**不许把 pending 算进成功**。
     `ok: true` 是 started 时乐观填的，它不构成「结果确认」。
   ══════════════════════════════════════════════════════════════ */

const SRC = readFileSync(join(process.cwd(), 'src/components/chat/message/ToolLine.tsx'), 'utf8')

/** 去掉注释，避免把说明文字当成代码判据 */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('未确认工具 / 界面判据', () => {
  it('★★★ pendingCount 只认「未确认」态，不认 ok', () => {
    const code = strip(SRC)
    /* 判据来自 stateOfRun 的四态；只有 unconfirmed 才算「结果未确认」 */
    expect(code).toMatch(
      /pendingCount\s*=\s*states\.filter\(\(state\)\s*=>\s*state\s*===\s*'unconfirmed'\)/,
    )
    /* 反例：不许写成 !run.ok（那是失败判据，不是未确认） */
    expect(code).not.toMatch(/pendingCount\s*=\s*runs\.filter\(\(run\)\s*=>\s*!run\.ok/)
  })

  it('★★★ 状态文字有「结果未确认」这一档（不能只显示成功/失败）', () => {
    expect(strip(SRC)).toContain('结果未确认')
  })

  it('★★ 四档顺序：进行中 > 失败 > 未确认 > 成功', () => {
    const code = strip(SRC)
    const running = code.indexOf("'进行中'")
    const failed = code.indexOf("failedCount + ' 项失败'")
    const pending = code.indexOf("pendingCount + ' 项结果未确认'")
    const done = code.indexOf("'成功'")
    expect(running).toBeGreaterThan(-1)
    expect(failed).toBeGreaterThan(running)
    expect(pending).toBeGreaterThan(failed)
    expect(done).toBeGreaterThan(pending)
  })

  it('★★ data-tool-status 也要有 unconfirmed（脚本/测试按它认状态）', () => {
    expect(strip(SRC)).toContain("'unconfirmed'")
  })

  it('★★ 未确认用 warning 色，不是成功色', () => {
    const code = strip(SRC)
    /* 判据按**结构**取，不按字符窗口（prettier 折行会让窗口失效 —— 已经踩过一次）：
       colorOf 的三元链里，pendingCount 那一档必须给 warning，兜底才是 completed。 */
    const chain =
      /colorOf\(\s*failedCount\s*\?\s*'failed'\s*:\s*pendingCount\s*\?\s*'warning'\s*:\s*'completed'/.exec(
        code.replace(/\s+/g, ' '),
      )
    expect(chain, '未找到 colorOf 的失败/未确认/成功三档链').toBeTruthy()
  })
})
