/**
 * security:release —— 依赖 / 构建 / 发布供应链（SEC-077 ~ 084）
 *
 * 首批 20 项里没有发布项，本轮全部标记待实现（如实）。
 * 现有 `scripts/check-rules.mjs` / `check-release.mjs` 已覆盖一部分（密钥扫描、
 * 依赖两侧一致），下一批按 SEC 编号接进来。
 */

import { CASES } from '../cases.mjs'
import { mark } from '../harness.mjs'

export async function run() {
  const mine = CASES.filter((c) => c.suite === 'release')
  console.log(`  本套件负责 ${mine.length} 项`)
  for (const c of mine) mark(c.id, 'NOT_RUN', '待实现（下一批）')
}
