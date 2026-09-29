/**
 * 自检 / AG-040 预算：默认值 · 迁移 · 三层来源（41-budget 的零件）
 *
 * 拆出来的原因就是行数：主文件加完「默认全不限 + 旧盘上的旧默认值要迁移」这几条之后
 * 顶破了 300 行红线（硬约束 #2）。这里全是**纯函数断言**，搬走不影响接线 ——
 * 「循环里真的查账」与「真跑一遍」那些留在主文件里。
 *
 * 单独跑：
 *   node -e "import('./scripts/selftest/groups/41-budget-parts.mjs').then(m=>m.runDefaultChecks())"
 */

import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const budget = require(join(ROOT, 'electron/core/budget.cjs'))

/** 老盘上会出现的整份预算（老内置默认值）—— 迁移要认的就是这几个数 */
const LEGACY_RAW = {
  maxSteps: 50,
  maxToolCalls: 100,
  maxRuntime: 1800,
  maxRetries: 3,
  maxTokens: 100000,
  softRatio: 0.8,
}

export function runDefaultChecks() {
  group('AG-040 / 预算从哪来')
  check(
    '★ 默认全部不限（0）—— 只有自动重试是 3（它不是上限，见 budget.cjs）',
    budget.DEFAULTS.maxSteps === 0 &&
      budget.DEFAULTS.maxToolCalls === 0 &&
      budget.DEFAULTS.maxRuntime === 0 &&
      budget.DEFAULTS.maxTokens === 0 &&
      budget.DEFAULTS.maxRetries === 3,
    JSON.stringify(budget.DEFAULTS),
  )

  /* 迁移：老盘上写着的就是老内置默认值，必须当成「没设过」*/
  const legacy = budget.legacyUnlimited(LEGACY_RAW)
  check(
    '★ 旧盘上的内置默认值被当成「没设过」→ 不限（不迁移这版对老用户等于没改）',
    legacy.migrated === 4 &&
      legacy.value.maxSteps === 0 &&
      legacy.value.maxTokens === 0 &&
      legacy.value.maxRetries === 3,
    JSON.stringify(legacy),
  )
  const own = budget.legacyUnlimited({ maxSteps: 7, maxTokens: 0 })
  check(
    '用户自己填的数字一个不动',
    own.migrated === 0 && own.value.maxSteps === 7 && own.value.maxTokens === 0,
    JSON.stringify(own),
  )

  check(
    '软阈值默认 0.8（提醒不阻断），且 resolve 会把它夹在 0–1',
    budget.DEFAULTS.softRatio === 0.8 &&
      budget.resolve({ budget: { softRatio: 5 } }, null).softRatio === 1 &&
      budget.resolve({ budget: { softRatio: -1 } }, null).softRatio === 0,
    JSON.stringify(budget.DEFAULTS),
  )

  const withConfig = budget.resolve({ budget: { maxSteps: 10 } }, null)
  check('设置能改默认', withConfig.maxSteps === 10 && withConfig.maxToolCalls === 0)
  const withTask = budget.resolve(
    { agent: { budget: { maxSteps: 10 } } },
    { budget: { maxSteps: 3, maxRuntime: 60 } },
  )
  check(
    '★ 任务自己的覆盖优先（只覆盖填了的那些）',
    withTask.maxSteps === 3 && withTask.maxRuntime === 60,
  )
  check('没填的还是设置里的值', withTask.maxToolCalls === budget.DEFAULTS.maxToolCalls)
  check(
    '乱七八糟的值退回默认（不吃 NaN / 负数）',
    budget.resolve({}, { budget: { maxSteps: 'x', maxTokens: -5 } }).maxSteps === 0,
  )
  check('0 = 不限（原样保留）', budget.resolve({}, { budget: { maxSteps: 0 } }).maxSteps === 0)
}
