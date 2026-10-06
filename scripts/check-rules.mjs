#!/usr/bin/env node
/**
 * 规范检查 —— 把「能机械查的规矩」跑一遍
 *
 *   node scripts/check-rules.mjs        # 通过 → 退出码 0；发现违规 → 1；只有警告 → 0
 *
 * 为什么要有它：`AGENT.md` 里的规矩靠"记得"是靠不住的 —— 这个项目里
 * 「测试全绿但功能废」发生过两次，「本地全绿但 CI 连红 13 次没人发现」也有过一次。
 * **能机械查的就不许靠自觉**；查不了的（比如「没顺手重构」）留人工 review。
 *
 * 检查项的实现都在 `check-rules/` 下，这里只负责「怎么跑、怎么报」。
 * 拆开的原因很具体：**这一条检查第一次跑就红在自己身上** —— 单个文件 358 行 > 300；
 * 后来加第 7 项（钩子在位）时 `checks.mjs` 又到了 291 行，于是再拆一个 `checks-hooks.mjs`。
 * **清单本身才是权威**：下面 `CHECKS` 数组有几项就是几项，别在文档里写死数量。
 *
 * 不引新依赖（只用 node 内置）—— 检查「不许新增依赖」的脚本自己先不引。
 */

import path from 'node:path'
import {
  checkAgentMd,
  checkDiffSize,
  checkLineLimits,
  checkNoNewDeps,
  checkNoSecretsInConfig,
  checkTodos,
} from './check-rules/checks.mjs'
import { checkHooksInstalled } from './check-rules/checks-hooks.mjs'
import { checkHygiene, LIMITS } from './check-rules/checks-hygiene.mjs'
import { checkDriftingNumbers } from './check-rules/checks-drift.mjs'
import { checkChangelogChange } from './check-rules/checks-changelog.mjs'

/* 门面照旧再导出一次：`import { checkLineLimits } from './check-rules.mjs'` 仍然可用
   （测试就是这么用的 —— 拆文件不该改调用方，见 docs/踩坑记录.md）
   LIMITS 也一起导出：阈值只准有一处定义，测试要能拿到同一份。 */
export {
  checkAgentMd,
  checkChangelogChange,
  checkDiffSize,
  checkDriftingNumbers,
  checkHooksInstalled,
  checkHygiene,
  checkLineLimits,
  checkNoNewDeps,
  checkNoSecretsInConfig,
  checkTodos,
  LIMITS,
}

export const ROOT = path.resolve(import.meta.dirname, '..')

/** 检查清单（顺序就是输出顺序）；主流程和测试共用这一份 */
export const CHECKS = [
  ['行数 ≤ 300', checkLineLimits],
  ['依赖两侧一致', checkNoNewDeps],
  ['config 无明文密钥', checkNoSecretsInConfig],
  ['无 TODO 残留（警告）', checkTodos],
  ['AGENT.md 在且非空', checkAgentMd],
  ['改动文件数（警告）', checkDiffSize],
  /* 用户当初的要求是「每次修复或更新都要升小版本」，落成检查后版本号成了**提交计数器**：
     CHANGELOG 攒到 234 个版本段、一天 16 个 beta，其中 beta.4…beta.10 连 tag 都没建
     （2026-10-07 改口径）。现在拦的是「改了代码没写 CHANGELOG」，
     版本号只在发布时升 —— 粒度保住了，版本号回到发布事件的频率。 */
  ['改了代码必须写 CHANGELOG', checkChangelogChange],
  ['约束机制在位（警告）', checkHooksInstalled],
  ['仓库卫生（警告）', checkHygiene],
  ['易漂数字（警告）', checkDriftingNumbers],
]

/** 跑全部检查；**不改退出码**，只返回汇总（测试直接断言这个） */
export function runAll(root = ROOT) {
  const errors = []
  const warnings = []
  const lines = []
  for (const [name, fn] of CHECKS) {
    const result = fn(root) ?? {}
    errors.push(...(result.errors ?? []))
    warnings.push(...(result.warnings ?? []))
    const bad = (result.errors ?? []).length
    lines.push(`${bad === 0 ? '✓' : '✗'} ${name}${result.summary ? `　${result.summary}` : ''}`)
  }
  return { errors, warnings, lines }
}

/** 主流程：打印 + 返回退出码。只有「直接运行本文件」时才调它 */
export function main(root = ROOT) {
  const { errors, warnings, lines } = runAll(root)
  console.log(lines.join('\n'))

  if (warnings.length > 0) {
    console.warn('\n警告：')
    for (const w of warnings) console.warn(`  ⚠ ${w}`)
  }
  if (errors.length > 0) {
    console.error('\n发现违规：')
    for (const e of errors) console.error(`  ✗ ${e}`)
    console.error('\n（觉得某条是误报？先改代码，别改检查 —— 见 AGENT.md 第 2 节）')
    return 1
  }
  console.log('\n✓ 规范检查通过')
  return 0
}

/* 只有「直接运行」才执行主流程 —— 被 import 时不跑（测试要用上面那些函数） */
const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (entry === path.join(import.meta.dirname, 'check-rules.mjs')) {
  process.exitCode = main()
}
