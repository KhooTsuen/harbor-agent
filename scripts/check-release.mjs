/**
 * 发版体检：当前 package.json 那个版本号，tag 建了吗？
 *
 *   node scripts/check-release.mjs             # 本地 tag + 远端 tag（联网；走 git 自己的代理）
 *   node scripts/check-release.mjs --offline   # 不联网，只看本地 tag
 *
 * ── 为什么要有它 ──
 * `1.30.0-beta.4` … `beta.10` 七个版本：代码提交了、版本号升了、CHANGELOG 写了，
 * 但 **Release 和 tag 一个都没建**（内容最后全并进 beta.11）。漏在哪一步很清楚 ——
 * `docs/发布检查.md` 的「提交 + tag + push」是纯手工步骤，漏掉 tag 不会有任何动静：
 * 版本号照升、CI 照绿、自检照过。这条补的就是那个缺口。
 *
 * ── 为什么只盯「当前版本」 ──
 * Release 保留策略要求只留 **最新 1 个 beta + 1 个正式版**，老版本的 tag 本来就是
 * 被主动删掉的（`npm run release:prune -- --tags`）。所以**扫历史必然误报** ——
 * 只问一句：package.json 现在这个版本，tag 到位了没有。
 *
 * ── 为什么**不**进 check-rules 清单（CHECKS）──
 * CHECKS 会被 pre-commit 和 CI 跑。而「刚升完版本号、还没打 tag」在提交那一刻**是正常状态**
 * —— 放进去必然把每一次升版本的提交都拦下。它是**发版前的门**（`docs/发布检查.md` 第 3 步后），
 * 不是每次提交的门。
 *
 * ── 退出码 ──
 * 齐了 0；缺了 1（能直接串进发布流程：`npm run check:release && npm run release:upload`）。
 * 远端查不到（没网 / 没 origin）**不算失败**，降级成 warning —— 离线时它就是本地体检。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 跑一条 git，成功返回分行结果；失败返回 null（不抛 —— 让调用方区分「没有」和「查不了」） */
function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return null
  }
}

/** `git ls-remote` 的一行是不是这个 tag（形如 `<sha>\trefs/tags/<tag>`，附注 tag 还会多一条 `^{}`） */
const isTagLine = (line, tag) => line.endsWith(`refs/tags/${tag}`) || line.endsWith(`refs/tags/${tag}^{}`)

/**
 * 体检本体（**不打印、不退出** —— CLI 与测试共用这一份口径）。
 *
 * @param {{ root?: string, remote?: boolean }} options
 *   `remote: false` 等价于 CLI 的 `--offline`。
 * @returns {{ version: string, tag: string, local: boolean|null, remote: boolean|null,
 *            errors: string[], warnings: string[] }}
 *   `local` / `remote` 为 `null` 表示**判不了**（不在 git 仓库 / 查不到远端），不是「没有」。
 */
export function checkRelease({ root = ROOT, remote = true } = {}) {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const tag = `v${version}`
  const errors = []
  const warnings = []

  const tags = git(root, ['tag', '-l', tag])
  const local = tags === null ? null : tags.includes(tag)
  if (local === null) {
    warnings.push('不在 git 仓库里（或读不到 git）—— 这项跳过')
  } else if (!local) {
    errors.push(`本地没有 tag ${tag} —— 建：git tag -a ${tag} -m "Harbor ${version}"`)
  }

  let remoteHas = null
  if (remote && local !== null) {
    /* 探远端：`git ls-remote` 认 git 自己的 http.proxy，和 push 走同一条路 */
    const lines = git(root, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
    if (lines === null) {
      warnings.push(`查不到远端 tag（没网 / 没 origin？）—— 跳过。发布前确认：git push origin ${tag}`)
    } else {
      remoteHas = lines.some((line) => isTagLine(line, tag))
      if (!remoteHas) errors.push(`远端没有 tag ${tag} —— 推：git push origin ${tag}`)
    }
  }

  return { version, tag, local, remote: remoteHas, errors, warnings }
}

/** CLI：打印体检结果，缺 tag 就退出码 1 */
function main() {
  const remote = !process.argv.slice(2).includes('--offline')
  const { version, tag, local, remote: remoteHas, errors, warnings } = checkRelease({ remote })

  if (local) console.log(`✓ 本地有 tag：${tag}`)
  /* ★ 只有**真查过**远端才敢说这句：`--offline` 或查不到时 `remoteHas` 是 null */
  if (remoteHas === true) console.log(`✓ 远端有 tag：origin/${tag}`)

  console.log(`\n版本：${version}（tag ${tag}）`)
  warnings.forEach((item) => console.log(`! ${item}`))

  if (errors.length === 0) {
    console.log(`\n✓ 发版入口齐了（${remoteHas === true ? '本地 + 远端' : '只查了本地，见上'}）。下一步：npm run package && npm run release:zip && npm run release:upload`)
    return 0
  }

  console.log('')
  errors.forEach((item) => console.log(`✗ ${item}`))
  console.log('\n✗ 版本号升了却没 tag —— 这正是 beta.4~beta.10 丢掉的那一步（见 CHANGELOG）。')
  return 1
}

/* 只有直接跑才执行 —— 测试要 import 上面那个 checkRelease */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
