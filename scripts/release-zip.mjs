/**
 * 打发布包（便携版 zip）
 *
 *   node scripts/release-zip.mjs
 *
 * 产物：`dist-portable/harbor-<版本>-win-x64.zip`（和往期 Release 的资产名一致）
 *
 * ★ 两条必须守住的：
 *
 * ① **绝不能把 `data/` 打进包**。
 *    它是**用户数据**：会话、任务台账、日志，还有 `credentials.json`（API Key）。
 *    开发机上那份就有 30 多 MB 的测试残留 + 一把真的 key —— 曾经差点直接发出去。
 *    用户在首次启动时自己会建 data/（`ensureDirs()`）。
 *
 * ② **包内版本要和 package.json 一致**。
 *    否则用户装完看到的版本号和 Release 对不上（打包前忘了 build 就会这样）。
 *
 * 用 Windows 自带的 bsdtar（`C:\Windows\System32\tar.exe`）—— 它能做 zip，
 * 而 git-bash 里那个 GNU tar 不能。不引任何 npm 依赖。
 */

import { existsSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_DIR = join(ROOT, 'dist-portable', 'Harbor')

function fail(message) {
  console.error(`打包失败：${message}`)
  process.exit(1)
}

if (!existsSync(APP_DIR)) fail('还没有 dist-portable/Harbor，先跑 npm run package')

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const packaged = join(APP_DIR, 'resources', 'app', 'package.json')
if (!existsSync(packaged)) fail('包内没有 resources/app/package.json，先跑 npm run package')
const packagedVersion = JSON.parse(readFileSync(packaged, 'utf8')).version
if (packagedVersion !== version) {
  fail(`包内版本 ${packagedVersion} 和 package.json 的 ${version} 不一致 —— 先 npm run package`)
}

const out = join(ROOT, 'dist-portable', `harbor-${version}-win-x64.zip`)

/** Windows 自带的 bsdtar；找不到就退回 PATH 上的 tar（并要求它是 bsdtar） */
function tarBin() {
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(system32) ? system32 : 'tar'
}

const bin = tarBin()
const args = [
  '-a',
  '-c',
  '-f',
  out,
  /* ★ data/ 是用户数据（含密钥），发布包里绝不能有 */
  '--exclude=data',
  '--exclude=data/*',
  '-C',
  APP_DIR,
  '.',
]
console.log(`打包 ${version} → ${out}`)
const res = spawnSync(bin, args, { stdio: 'inherit' })
if (res.status !== 0) fail(`tar 退出码 ${res.status}`)

const mb = statSync(out).size / 1048576
console.log(`完成：${(mb).toFixed(0)}MB`)

/* 用 tar 列一遍，确认包里**没有** data/（比"相信 --exclude 生效"强） */
const list = spawnSync(bin, ['-tf', out], { encoding: 'utf8' })
const names = (list.stdout ?? '').split('\n')
const leaked = names.filter((n) => /^\.?\/?data(\/|$)/.test(n.trim()))
if (leaked.length > 0) fail(`包里混进了 data/：${leaked.slice(0, 3).join(', ')}`)
if (!names.some((n) => n.includes('Harbor.exe'))) fail('包里没有 Harbor.exe，检查 dist-portable/Harbor')
console.log(`校验：${names.length} 个条目，没有 data/，Harbor.exe 在`)
