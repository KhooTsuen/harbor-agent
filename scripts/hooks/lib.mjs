/* 钩子共用的两件小事：跑 npm 脚本、打印小节标题
 *
 * 为什么要「跑 npm 脚本」而不是把命令抄一遍：抄一遍就会漂 ——
 * package.json 里的 verify 改了，钩子里的那份不会跟着改。
 * 所以钩子只认**脚本名**，实际命令始终来自 package.json。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ROOT = join(import.meta.dirname, '..', '..')

/** 找到真正的 npm-cli.js：这样在墙内 / PowerShell / git-bash 里都不怕 npm/npm.ps1 被挡 */
function npmCli() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** 跑 package.json 里的某个脚本；返回是否成功 */
export function runScript(name, { quiet = false } = {}) {
  const cli = npmCli()
  const args = ['run', name]
  const result = cli
    ? spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit', shell: true })
  if (!quiet) console.log(`[钩子] npm run ${name} 完成`)
  return result.status === 0
}

/** 跑一条 node 命令（用当前解释器，避免 PATH 差异） */
export function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  return result.status === 0
}

export function step(title) {
  console.log(`\n[钩子] ── ${title} ──`)
}

export function fail(title, hint) {
  console.log(`\n[钩子] ✗ ${title}`)
  console.log(`[钩子]   改动没丢；修完再提交/推送。`)
  if (hint) console.log(`[钩子]   ${hint}`)
  console.log(`[钩子]   紧急绕过（**不要习惯性用**）：git commit --no-verify / git push --no-verify`)
}
