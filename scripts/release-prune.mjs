/**
 * Release 保留策略：只留「最新 1 个正式版 + 最新 1 个 beta」，其余删掉。
 *
 *   npm run release:prune -- --keep=v1.29.0,v1.20.0-beta.40            # 默认 dry-run：只说会删谁
 *   npm run release:prune -- --keep=v1.29.0,v1.20.0-beta.40 --apply    # 真删
 *   ... --tags   额外把对应 tag 也删掉（远端走 API，本地走 `git tag -d`）
 *
 * ── 为什么有它 ──
 * 这条规矩写在 `docs/发布检查.md` 的《Release 保留策略》里（2026-09-26 一天发过 16 个
 * beta，攒到 31 个版本）。原来靠 `tmp/gh-clean-releases.cjs`，那个文件**已经不在仓库里**
 * —— 于是「规矩还在、工具没了」。删东西的操作更要能重复跑、能先预演，所以它进仓库。
 *
 * ── 两条安全线 ──
 * ① **默认 dry-run**：不给 `--apply` 只打印打算删什么，一个请求都不发。
 * ② `--keep` 是必填的：不给就什么都不删（避免「一个手滑把 Releases 清空」）。
 */

import { spawnSync } from 'node:child_process'
import { ghApi, listReleases, readToken, repoOf } from './lib/github-release.mjs'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const WITH_TAGS = argv.includes('--tags')
const keepArg = argv.find((item) => item.startsWith('--keep='))
const keep = (keepArg?.slice('--keep='.length) ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

if (keep.length === 0) {
  console.error('没给 --keep=v<要留的>,v<要留的> —— 什么都不删（这是故意的）')
  process.exit(1)
}

const { owner, repo } = repoOf()
const token = readToken()
const releases = await listReleases({ token, owner, repo })

const doomed = releases.filter((item) => !keep.includes(item.tag_name))
console.log(`仓库 ${owner}/${repo} 共 ${releases.length} 个 Release`)
for (const item of releases) {
  const kept = keep.includes(item.tag_name)
  console.log(`  ${kept ? '保留' : '删除'} ${item.tag_name}（${item.prerelease ? 'beta' : '正式版'}）${item.name ? ` · ${item.name}` : ''}`)
}
/*
 * ★ 结束分支**不调 `process.exit()`**（2026-10-11）：
 * `fetch()` 发过请求之后再 `process.exit()`，Node 24 在 Windows 上会撞 libuv 断言
 * —— `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94`，
 * 退出码 0xC0000409。表现是**输出全对、进程崩着退**，最容易误判成「没事」。
 * 最小复现已确认：fetch 后 `process.exit(0)` 必崩，`dispatcher.close()` 也救不了；
 * 改成让控制流走完、进程**自然退出**就干净。`--keep` 缺失那处 exit(1) 留在原地没动
 * —— 它在第一个 fetch 之前，没有未决 handle，是安全的。
 */
if (doomed.length === 0) {
  console.log('没有要删的 —— 已经是「最新 1 个正式版 + 1 个 beta」了')
} else if (!APPLY) {
  console.log(`\n--dry：上面这 ${doomed.length} 个会被删。真删加 --apply${WITH_TAGS ? '（含 tag）' : ''}`)
} else {
  for (const item of doomed) {
    const removed = await ghApi(`/repos/${owner}/${repo}/releases/${item.id}`, {
      token,
      method: 'DELETE',
    })
    console.log(`${removed.ok ? '已删 Release' : `删 Release 失败（${removed.status}）`} ${item.tag_name}`)

    if (!WITH_TAGS) continue
    /* 远端 tag 走 API；本地那份也要删，否则下次 push --follow-tags 会把它复活 */
    const gone = await ghApi(`/repos/${owner}/${repo}/git/refs/tags/${item.tag_name}`, {
      token,
      method: 'DELETE',
    })
    const local = spawnSync('git', ['tag', '-d', item.tag_name], { cwd: process.cwd(), encoding: 'utf8' })
    console.log(
      `  远端 tag：${gone.ok || gone.status === 404 ? '已删' : `失败（${gone.status}）`}` +
        `；本地 tag：${local.status === 0 ? '已删' : '本来就没有'}`,
    )
  }
  console.log(`\n完成。留下的：${keep.join('、')}`)
}
