/* 安装 git 钩子：把 core.hooksPath 指向 .github/hooks（仓库里，跟着 git 走，可分享）
 *
 * 为什么不放 .git/hooks：那目录不提交，换台机器就没了 —— 而且 .git 不该被当配置住的地方。
 * 为什么不用 husky：不引新依赖（硬约束第 6 条）。
 *
 * 跑法：node scripts/hooks/install.mjs
 *       node scripts/hooks/install.mjs --check   —— 只看状态，不改
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib.mjs'

const WANT = '.github/hooks'
const CHECK_ONLY = process.argv.includes('--check')

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const now = (() => {
  try {
    return git(['config', '--get', 'core.hooksPath']) || '（没设）'
  } catch {
    return '（没设）'
  }
})()

const missing = ['pre-commit', 'pre-push'].filter((f) => !existsSync(join(ROOT, WANT, f)))

console.log(`仓库：${ROOT}`)
console.log(`core.hooksPath 现在：${now}`)
console.log(`钩子文件缺失：${missing.length ? missing.join('、') : '无'}`)

if (CHECK_ONLY) {
  process.exit(now === WANT && missing.length === 0 ? 0 : 1)
}

if (missing.length) {
  console.log('\n✗ 钩子文件不在，无法安装（先确认 .github/hooks/pre-commit、pre-push 在）')
  process.exit(1)
}

if (now === WANT) {
  console.log('\n✓ 已经装好了，不用动')
  process.exit(0)
}

git(['config', 'core.hooksPath', WANT])
console.log(`\n✓ 已设置 core.hooksPath = ${WANT}`)
console.log('  说明：这是**本地** git 配置（不进仓库）。换台机器跑一次本脚本即可。')
console.log('  验证：随意改一行代码后 git commit，应看到 "[钩子] ── 提交前快闸门 ──"。')
