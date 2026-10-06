import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   单测不得写应用的**真 data**（2026-10-07）

   内核 `.cjs`（日志 / 配置 / 规模预检 / 导航策略…）内部直接写 `DIRS.*`。
   单测 require 它们时若不知道「我在测试里」，就写用户真 `data/logs` ——
   跑一次 `test:unit` 主日志 +15 行假数据（受控实测），排查时被它带偏。
   （只污染日志、不碰 config/credentials；后者由自检那条 safeStorage 隔离管。）

   这里钉两件事：
     ① 运行期：`paths` 确实被切进了隔离目录；
     ② 源码层面：`vitest.config.ts` 注入的信号名与 `paths.cjs` 认的名字**是同一个**
        （AGENT.md #9：跨模块约定只留一处真相源；两边各写一套会静默漂移）。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)
const paths = require_(join(ROOT, 'electron/core/paths.cjs')) as {
  DIRS: { data: string; logs: string; sessions: string }
  isUnitTestRun: () => boolean
}

describe('单测数据隔离', () => {
  it('★ data 目录被切到 unit-test-data（不碰应用真 data）', () => {
    expect(paths.isUnitTestRun()).toBe(true)
    expect(paths.DIRS.data.replace(/\\/g, '/')).toMatch(/\/data\/unit-test-data$/)
    /* 派生子目录也跟着走 —— 否则会出现「一半隔离一半不隔离」的分裂 */
    expect(paths.DIRS.logs).toBe(join(paths.DIRS.data, 'logs'))
    expect(paths.DIRS.sessions).toBe(join(paths.DIRS.data, 'sessions'))
  })

  it('★ 信号名两边一致：vitest.config.ts 注入的 = paths.cjs 认的', () => {
    const cfg = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
    const src = readFileSync(join(ROOT, 'electron/core/paths.cjs'), 'utf8')
    expect(cfg).toContain("HARBOR_UNIT_TEST: '1'")
    expect(src).toContain("process.env.HARBOR_UNIT_TEST === '1'")
  })
})
