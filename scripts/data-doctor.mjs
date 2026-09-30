/**
 * 数据体检（命令行入口）
 *
 * 内核那份在 `electron/core/data-doctor.cjs`（**只读**，不修任何东西）。
 * 这里只负责：挑目录、打印、可选落一份 JSON。
 *
 * 用法：
 *   npm run doctor                        # 体检本仓库的 data/
 *   npm run doctor -- E:/Harbor           # 体检另一份安装（便携版的 data 在 exe 同级）
 *   npm run doctor -- E:/Harbor --json=tmp/doctor.json
 *   npm run doctor -- --strict            # 有问题就退出码 1（给脚本用）
 */

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = resolve(import.meta.dirname, '..')
const doctor = require(join(ROOT, 'electron/core/data-doctor.cjs'))
const paths = require(join(ROOT, 'electron/core/paths.cjs'))

const argv = process.argv.slice(2)
const target = argv.find((a) => !a.startsWith('--'))
const jsonOut = argv.find((a) => a.startsWith('--json='))?.split('=')[1] ?? ''
const strict = argv.includes('--strict')

/* 便携版的 data 就在 exe 同级；传目录时自动补 `data`（也可以直接传 data 本身） */
const dataDir = target
  ? /[\\/]data$/.test(target)
    ? target
    : join(target, 'data')
  : paths.DIRS.data

const report = doctor.run({ root: dataDir })
console.log(doctor.format(report))

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n（明细已写到 ${jsonOut}）`)
}

process.exit(strict && report.problems.length > 0 ? 1 : 0)
