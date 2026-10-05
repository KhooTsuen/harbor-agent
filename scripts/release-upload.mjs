/**
 * 把发布包传到 GitHub Release（建 Release + 传 zip）
 *
 *   npm run release:upload            # 正式版（prerelease: false）
 *   npm run release:upload -- --beta  # Pre-release（prerelease: true）
 *   npm run release:upload -- --dry   # 只打印打算做什么，不发请求
 *
 * ── 为什么放在 `scripts/` 而不是 `tmp/`（2026-10-06）──
 * 这套流程原来靠 `tmp/gh-release-beta3.cjs` 这类**一次性脚本**，而 `tmp/` 有自己的
 * 卫生检查（条数 / 体积超限会被清）——结果就是 `docs/发布检查.md` 里那一串命令
 * 全部指向**已经不存在的文件**，照文档发版第一步就报「找不到文件」。
 * 发版是**反复要跑**的事，所以它进仓库、有名字、有 npm script。
 *
 * ── 凭据 ──
 * 不读环境变量、不落盘：走 `git credential fill`（和 `git push` 同一份凭据）。
 * token 只进内存，**任何情况下都不打印**。
 *
 * ── 幂等 ──
 * Release 已存在就用它；同名资产已存在就跳过上传。重跑安全。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
/* 认仓库 / 拿凭据 / 发请求只有一份实现（清理脚本用的是同一份） */
import { ghApi, readToken, repoOf } from './lib/github-release.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const IS_BETA = argv.includes('--beta')
const DRY = argv.includes('--dry')

function fail(message) {
  console.error(`发布失败：${message}`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const tag = `v${version}`
const zipName = `harbor-${version}-win-x64.zip`
const zipPath = join(ROOT, 'dist-portable', zipName)
if (!existsSync(zipPath)) fail(`${zipName} 不存在 —— 先跑 npm run package && npm run release:zip`)
const sizeMb = Math.round(statSync(zipPath).size / 1048576)

/* origin 推 owner/repo —— 两种写法都认（实现见 lib/github-release.mjs） */
let owner = ''
let repo = ''
try {
  ;({ owner, repo } = repoOf())
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

/** Release 正文直接取 CHANGELOG 里这一节 —— 正文只写一份，别在这儿再抄一遍 */
function releaseBody() {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const at = changelog.indexOf(`## [${version}]`)
  if (at < 0) return `Harbor ${version}`
  const rest = changelog.slice(at)
  const next = rest.indexOf('\n## [', 1)
  return (next > 0 ? rest.slice(0, next) : rest).trim()
}

let key = ''
if (!DRY) {
  try {
    key = readToken()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

/** 只在 tool 里包一层：把 token 补上（真正的实现在 lib/github-release.mjs） */
const api = (path, options = {}) => ghApi(path, { token: key, ...options })

console.log(`准备发布 ${tag}（${IS_BETA ? 'Pre-release' : '正式版'}）`)
console.log(`  仓库：${owner}/${repo}`)
console.log(`  资产：${zipName}（${sizeMb}MB）`)

if (DRY) {
  console.log('  --dry：到此为止，没有发任何请求')
  process.exit(0)
}

/* ① Release：有就用，没有就建 */
let release = await api(`/repos/${owner}/${repo}/releases/tags/${tag}`)
if (release.status === 404) {
  release = await api(`/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `Harbor ${version}`,
      body: releaseBody(),
      prerelease: IS_BETA,
      draft: false,
    }),
  })
  if (!release.ok) fail(`建 Release 失败（${release.status}）：${release.text.slice(0, 400)}`)
  console.log(`① 建好 Release：${release.json.html_url}`)
} else if (release.ok) {
  console.log(`① Release 已存在，直接用：${release.json.html_url}`)
} else {
  fail(`查 Release 失败（${release.status}）：${release.text.slice(0, 400)}`)
}

/* ② 资产：同名已存在就跳过（重跑安全） */
const assets = await api(`/repos/${owner}/${repo}/releases/${release.json.id}/assets`)
const already = Array.isArray(assets.json) ? assets.json.find((item) => item.name === zipName) : null
if (already) {
  console.log(`② 资产已存在（${Math.round(already.size / 1048576)}MB），跳过上传`)
} else {
  console.log('② 正在上传 zip（一百多 MB，要几分钟）……')
  const uploaded = await api(
    `UPLOAD/repos/${owner}/${repo}/releases/${release.json.id}/assets?name=${encodeURIComponent(zipName)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'Content-Length': String(statSync(zipPath).size) },
      body: readFileSync(zipPath),
    },
  )
  if (!uploaded.ok) fail(`上传失败（${uploaded.status}）：${uploaded.text.slice(0, 400)}`)
  console.log(`② 上传完成：${uploaded.json.browser_download_url}`)
}

console.log(`完成：${release.json.html_url}`)
