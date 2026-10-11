/**
 * security:downloads —— 下载管理器（SEC-047 ~ 056）
 *
 * 首批 20 项里没有下载项，本轮全部标记待实现（如实，不伪装通过）。
 * 下载相关的基础断言已在 `scripts/selftest/groups/119-download.mjs` 里，
 * 下一批把它们按 SEC 编号接进本套件。
 */

import { CASES } from '../cases.mjs'
import { mark } from '../harness.mjs'

export async function run() {
  const mine = CASES.filter((c) => c.suite === 'downloads')
  console.log(`  本套件负责 ${mine.length} 项`)
  for (const c of mine) mark(c.id, 'NOT_RUN', '待实现（下一批）')
}
