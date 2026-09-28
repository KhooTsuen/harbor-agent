/**
 * `check-rules` 测试用的夹具（临时目录 / 临时 git 仓库）
 *
 * 抽出来是因为主测试文件顶着 300 行红线（**它自己那条检查报的**）。
 * 缝很清楚：这里只有「怎么造环境」，测试写「断言什么」。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const REPO = path.resolve(import.meta.dirname, '..', '..')

/** 生成 n 行合法的 TS 源码 */
export const lines = (n) => Array.from({ length: n }, (_, i) => `const a${i} = ${i}`).join('\n')

/** 建一个临时根目录 + 若干文件；用完调 done() 删掉 */
export function tempRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-rules-'))
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(root, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text)
  }
  return { root, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** 建一个临时 git 仓库 + n 个未跟踪文件（放在系统临时目录，不污染仓库） */
export function gitRepo(fileCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-rules-git-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (let i = 0; i < fileCount; i += 1) {
    fs.writeFileSync(path.join(root, `f${i}.ts`), 'const a = 1\n')
  }
  return { root, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** 读仓库里的一份真实文件（行数检查要复用 tools/line-limit.mjs 的副本） */
export const readRepoFile = (name) => fs.readFileSync(path.join(REPO, name), 'utf8')

/** 未完成标记（TODO / FIXME 那类）**在运行时拼出来**，
 *  免得检查脚本把测试文件里的字样当成了真标记 */
export const marker = (kind, note) => `// ${kind}: ${note}`
