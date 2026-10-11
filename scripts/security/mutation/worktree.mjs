/**
 * 变异工作树（隔离副本）
 *
 * `node scripts/security/mutation/worktree.mjs` —— 建 `data/mutation/wt`：robocopy 复制
 * 项目（排除 node_modules/data/dist/.git 等），对 node_modules 与构建产物建 junction。
 *
 * **安全护栏**：副本整体在 `data/`（gitignore）下，变异只写副本；主工作区与用户真数据不被触碰。
 * 不用 node 的 cpSync：实测在本仓库上会卡住（>120s）；robocopy 秒级完成。
 * 不用 git worktree：worktree 没有 node_modules，vitest / require 跑不起来。
 */
import { spawnSync } from 'node:child_process'
import { rmSync, symlinkSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..', '..', '..')
export const WT = resolve(ROOT, 'data', 'mutation', 'wt')

const EX = ['node_modules', '.git', 'data', 'dist', 'dist-portable', '.venv', 'tmp', '.chrome-profile-9336', '.chrome-profile-9339'].map((n) => join(ROOT, n))

export function makeWorktree() {
  rmSync(WT, { recursive: true, force: true })
  const r = spawnSync('robocopy', [ROOT, WT, '/E', '/XD', ...EX, '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:0', '/W:0'], { encoding: 'utf8' })
  if (r.status > 7) throw new Error(`robocopy 失败：exit ${r.status}`)
  symlinkSync(join(ROOT, 'node_modules'), join(WT, 'node_modules'), 'junction')
  /* 构建产物只读被 SEC-080 / SEC-010 读，变异不写它们 → 指回真产物 */
  for (const d of ['dist', 'dist-portable']) {
    if (existsSync(join(ROOT, d))) symlinkSync(join(ROOT, d), join(WT, d), 'junction')
  }
  return WT
}

if (import.meta.filename === process.argv[1]) {
  const wt = makeWorktree()
  console.log('工作树：', wt)
  console.log('就绪：', existsSync(join(wt, 'electron', 'main.cjs')), existsSync(join(wt, 'node_modules', '.bin')))
}
