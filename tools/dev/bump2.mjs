/*
 * 只改版本号（package.json + package-lock.json 两处）。
 *
 * 为什么不复用 tmp/bump.mjs：那份把 CHANGELOG 文案也写死在脚本里，改一次文案就得动脚本，
 * 而模板里的反引号转义很容易写错（已经踩过一次）。CHANGELOG 用编辑工具改更稳。
 *
 * 用法：node tmp/bump2.mjs 1.30.0-beta.2
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'E:\\CodexWorkbench'
const NEXT = process.argv[2]
if (!NEXT) {
  console.error('用法：node tmp/bump2.mjs <新版本号>')
  process.exit(1)
}

const pkgPath = join(REPO, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const prev = pkg.version
pkg.version = NEXT
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

const lockPath = join(REPO, 'package-lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
lock.version = NEXT
if (lock.packages?.['']) lock.packages[''].version = NEXT
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')

console.log(`${prev} → ${NEXT}（package.json + package-lock.json 两处）`)
