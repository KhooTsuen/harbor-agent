/**
 * 稳定性指标（命令行入口）
 *
 * 内核那份在 `electron/core/run-stats.cjs` —— 口径（分母怎么算、没样本怎么办）
 * 全写在那里，这里只负责挑目录、打印、可选落 JSON。
 *
 * 用法：
 *   npm run stats                       # 算本仓库 data/ 的台账
 *   npm run stats -- E:/Harbor          # 算另一份安装（只读）
 *   npm run stats -- --json=tmp/stats.json
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = resolve(import.meta.dirname, '..')
const stats = require(join(ROOT, 'electron/core/run-stats.cjs'))
const paths = require(join(ROOT, 'electron/core/paths.cjs'))

const argv = process.argv.slice(2)
const target = argv.find((a) => !a.startsWith('--'))
const jsonOut = argv.find((a) => a.startsWith('--json='))?.split('=')[1] ?? ''

/* 便携版的 data 就在 exe 同级；传目录时自动补 `data`（也可以直接传 data 本身） */
const dataDir = target
  ? /[\\/]data$/.test(target)
    ? target
    : join(target, 'data')
  : paths.DIRS.data

const { tasks, broken } = stats.readTasks(dataDir)
const report = stats.summarize(tasks, { broken })

/*
 * 真机任务集（`npm run acceptance` 的产物）**只对本仓库显示**：
 * 那份 acc-report.json 在仓库根，和「另一份安装的台账」根本不是一回事 ——
 * 算 E:\Harbor 的指标时把它挂上去，会让人以为那台机器跑过 8 个真机任务。
 */
if (!target) {
  try {
    const battery = stats.fromBattery(JSON.parse(readFileSync(join(ROOT, 'acc-report.json'), 'utf8')))
    if (battery) report.battery = battery
  } catch {
    /* 没跑过 / 读不动 —— 只是少一段，不影响指标 */
  }
}

console.log(stats.format(report))

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n（明细已写到 ${jsonOut}）`)
}
