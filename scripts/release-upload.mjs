/**
 * 把发布包传到 GitHub Release（建 Release + 传 zip）
 *
 *   npm run release:upload            # 正式版（prerelease: false）
 *   npm run release:upload -- --beta  # Pre-release（prerelease: true）
 *   npm run release:upload -- --dry   # 只打印打算做什么，不发请求
 *   npm run release:upload -- --tag   # 本地缺 tag 时，代建 + 推到 origin（默认缺 tag 就停）
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

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
/* 认仓库 / 拿凭据 / 发请求只有一份实现（清理脚本用的是同一份） */
import { ghApi, readToken, repoOf } from './lib/github-release.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const IS_BETA = argv.includes('--beta')
const DRY = argv.includes('--dry')
/* `--tag`：本地缺 tag 时由本工具代建并推（git tag + git push 是写 + 外发，默认不动手） */
const MAKE_TAG = argv.includes('--tag')

function fail(message) {
  console.error(`发布失败：${message}`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const tag = `v${version}`

/**
 * 本地有没有这个 tag（判不了返回 null）。
 * ★ tag 守卫（2026-10-07 加）：原来全靠 GitHub API 的 `tag_name` **隐式**建 tag ——
 * 本地没 tag 时，远端那个 tag 会指向**默认分支 HEAD**（代码还没 push 的话就是错的提交），
 * 而且本地漏了 tag **不会有任何提示**：`beta.4` … `beta.10` 七版就是这么丢的
 * （版本号升了、代码提交了，Release 与 tag 一个没建，见 `scripts/check-release.mjs`）。
 * 现在：缺 tag 默认停；`--tag` 才由本工具代建 —— 要下笔写 git / 往远端推，得你点。
 * 排在 zip 检查之前：缺 tag 是 git 侧的先决条件，不该等打完包才发现。
 */
function hasLocalTag(name) {
  const res = spawnSync('git', ['tag', '-l', name], { cwd: ROOT, encoding: 'utf8' })
  return res.status === 0 ? (res.stdout ?? '').trim() === name : null
}

const localTag = hasLocalTag(tag)
if (localTag === false) {
  const hint = `本地没有 tag ${tag}：git tag -a ${tag} -m "Harbor ${version}" && git push origin ${tag}`
  if (DRY) {
    console.log(`! ${hint}`)
  } else if (!MAKE_TAG) {
    fail(`${hint}\n  （或加 --tag 让本工具代建。不建就发，远端 tag 会指向默认分支 HEAD —— 可能不是这次提交）`)
  } else {
    for (const args of [
      ['tag', '-a', tag, '-m', `Harbor ${version}`],
      ['push', 'origin', tag],
    ]) {
      const res = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' })
      if (res.status !== 0) fail(`git ${args.join(' ')} 退出码 ${res.status}`)
    }
    console.log(`[tag] 已建并推：${tag}`)
  }
}

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

/** 发布正文的取材处：主文件（`[未发布]` + 当前发布周期）+ 归档文件（更早的版本） */
const CHANGELOG_FILES = ['CHANGELOG.md', join('docs', 'CHANGELOG-归档.md')]

/** 从某份 CHANGELOG 文本里切出这一版那一节（找不到返回 null） */
function sectionOf(text, ver) {
  const at = text.indexOf(`## [${ver}]`)
  if (at < 0) return null
  const rest = text.slice(at)
  const next = rest.indexOf('\n## [', 1)
  return (next > 0 ? rest.slice(0, next) : rest).trim()
}

/** Release 正文直接取 CHANGELOG 里这一节 —— 正文只写一份，别在这儿再抄一遍。
 *  两份都翻：更早的版本归档在 `docs/CHANGELOG-归档.md`，重发老版本时也能取到正文。 */
function releaseBody() {
  for (const rel of CHANGELOG_FILES) {
    try {
      const body = sectionOf(readFileSync(join(ROOT, rel), 'utf8'), version)
      if (body) return body
    } catch {
      /* 这份没了就翻下一份 */
    }
  }
  return `Harbor ${version}`
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
