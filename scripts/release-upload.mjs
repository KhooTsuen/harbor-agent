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
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const IS_BETA = argv.includes('--beta')
const DRY = argv.includes('--dry')

function fail(message) {
  console.error(`发布失败：${message}`)
  process.exit(1)
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const tag = `v${version}`
const zipName = `harbor-${version}-win-x64.zip`
const zipPath = join(ROOT, 'dist-portable', zipName)
if (!existsSync(zipPath)) fail(`${zipName} 不存在 —— 先跑 npm run package && npm run release:zip`)
const sizeMb = Math.round(statSync(zipPath).size / 1048576)

/* origin 推 owner/repo —— https 与 ssh 两种写法都认 */
const remote = (run('git', ['remote', 'get-url', 'origin']).stdout ?? '').trim()
const found = /github\.com[:/]([^/]+)\/([^/.\s]+)/.exec(remote)
if (!found) fail(`认不出 origin 是哪个 GitHub 仓库：${remote || '（空）'}`)
const [, owner, repo] = found

/** 凭据走 git 自己的 helper（和 push 用同一份），拿不到就让人先去 push 一次 */
function readToken() {
  const filled = run('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
  })
  const row = (filled.stdout ?? '').split('\n').find((line) => line.startsWith('password='))
  if (!row) fail('git credential fill 没给出 token —— 先 git push 一次把凭据存好')
  return row.slice('password='.length)
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

const key = DRY ? '' : readToken()

async function api(path, options = {}) {
  const upload = path.startsWith('UPLOAD')
  const url = upload
    ? `https://uploads.github.com${path.slice('UPLOAD'.length)}`
    : `https://api.github.com${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'harbor-release-upload',
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 就只留文本 */
  }
  return { ok: response.ok, status: response.status, json, text }
}

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
