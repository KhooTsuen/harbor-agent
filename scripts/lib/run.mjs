/* 通用的「跑 npm 脚本 / 跑 node 命令」小工具
 *
 * 从 `scripts/hooks/lib.mjs` 挪上来的：钩子只需要它，preflight 也需要它 ——
 * 让它住在 hooks/ 里会变成「通用工具藏在某个具体功能目录下」。
 * 钩子那份现在只做转发（re-export），调用方一行没改。
 *
 * 为什么不直接调 `npm`：这台机器上 `npm.ps1` 被策略挡住过（npx.ps1 同）。
 * 用 node 直接跑 npm-cli.js，就不再依赖 shell 是什么、PATH 怎么写的。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ROOT = join(import.meta.dirname, '..', '..')

function npmCli() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** 跑 package.json 里的某个脚本；返回是否成功 */
export function runScript(name, { stdio = 'inherit' } = {}) {
  const cli = npmCli()
  const result = cli
    ? spawnSync(process.execPath, [cli, 'run', name], { cwd: ROOT, stdio })
    : spawnSync('npm', ['run', name], { cwd: ROOT, stdio, shell: true })
  return result.status === 0
}

/** 跑一条 node 命令（用当前解释器，避开 PATH 差异） */
export function runNode(args, { stdio = 'inherit' } = {}) {
  return spawnSync(process.execPath, args, { cwd: ROOT, stdio }).status === 0
}

export function step(title) {
  console.log(`\n── ${title} ──`)
}

export function fail(title, hint) {
  console.log(`\n✗ ${title}`)
  console.log('  改动没丢；修完再提交/推送。')
  if (hint) console.log(`  ${hint}`)
  console.log('  紧急绕过（**不要习惯性用**）：git commit --no-verify / git push --no-verify')
}
