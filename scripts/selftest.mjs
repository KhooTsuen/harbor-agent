/**
 * 内核单元测试
 *
 * 直接 require core/ 下的模块，不需要 Electron、不联网。  node scripts/selftest.mjs
 *
 * 结构：**分组清单在 `selftest/groups.mjs`**（一组一行，文件都在 `selftest/groups/`）；
 * 公共环境在 `selftest/env.mjs`，记分在 `selftest/harness.mjs`。各组干什么读各组的文件头。
 * **组与组之间不共享状态** —— 加新组改 `groups.mjs` 那一个文件。
 * ⚠️ 测试全绿 ≠ 能用：UI / 会话 / 发送 / 权限这些必须真的走一遍（见 AGENT.md 的验证纪律）。
 *
 * 为什么清单搬走了：这里以前自己扛着 140+ 行 import + GROUPS，顶到 300 行红线，
 * 而那段**只增不减**（加组就加行）—— 等于把红线焊死。搬走之后本文件只剩「跑 + 收尾」。
 */

import { report } from './selftest/harness.mjs'
import { prepareSelftest, cleanupSelftest } from './selftest/env.mjs'
import { GROUPS } from './selftest/groups.mjs'

async function main() {
  /* 数据目录隔离（自检绝不碰用户真凭证）+ 建沙箱 —— 细节见 env.mjs 的 prepareSelftest */
  prepareSelftest()

  for (const run of GROUPS) await run()

  cleanupSelftest()

  process.exit(report())
}

main().catch((error) => {
  console.error('\n测试自己崩了：', error)
  process.exit(1)
})
