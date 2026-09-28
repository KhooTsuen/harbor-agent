/* 「关于检查清单本身」的测试（元测试）：
 *   ① 清单结构合法 + 必需项都在（不数数量）
 *   ② 第 7 项：约束机制（git 钩子）在位
 *
 * 单独一个文件的原因：主测试文件已经贴着 300 行红线，再加就顶线
 * —— 查行数的工具先被自己的规矩卡住，这个项目已经发生过一次；
 * 2026-09-29 又发生一次（加了几行后 301 行，被 pre-commit 钩子拦下）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { CHECKS, checkHooksInstalled } from './check-rules.mjs'
import { REPO, gitRepo, tempRoot } from './check-rules/test-kit.mjs'

const HOOK_NAMES = ['pre-commit', 'pre-push']

test('清单：每一项都是 [名字, 函数]，不重名，必需项都在（**不数数量**）', () => {
  /* 为什么不断言 length === N：条目本来就会越加越多，写死就一定漂
     —— `.github/copilot-instructions.md` 里那句「六条硬约束」就是这么漂掉的。 */
  for (const entry of CHECKS) {
    assert.ok(Array.isArray(entry) && entry.length === 2, `清单项应该是 [名字, 函数]：${JSON.stringify(entry)}`)
    const [name, fn] = entry
    assert.ok(typeof name === 'string' && name.length > 0, '名字不能为空')
    assert.equal(typeof fn, 'function', `${name} 的第二项应该是函数`)
  }

  const names = CHECKS.map(([name]) => name)
  assert.equal(new Set(names).size, names.length, `清单里有重名：${names.join('、')}`)

  /* 这几项少一个，硬约束就有一块没人管 */
  for (const required of ['行数 ≤ 300', '依赖两侧一致', 'config 无明文密钥', 'AGENT.md 在且非空']) {
    assert.ok(names.includes(required), `必需项「${required}」不在清单里（实际：${names.join('、')}）`)
  }
})

test('第 7 项：真实仓库里钩子已装 → 无警告', () => {
  const result = checkHooksInstalled(REPO)
  assert.deepEqual(result.errors, [], '这一项只警告不报错（新克隆还没装时不该红）')
  assert.deepEqual(result.warnings, [], `真实仓库应该有警告为空，实际：${result.warnings.join('；')}`)
  assert.equal(result.summary, '钩子已装')
})

test('第 7 项：钩子文件缺失 → 警告点名缺哪个', () => {
  const { root, done } = tempRoot({})
  try {
    const result = checkHooksInstalled(root)
    for (const name of HOOK_NAMES) {
      assert.ok(
        result.warnings.some((w) => w.includes(name)),
        `警告里应该点名缺 ${name}，实际：${result.warnings.join('｜')}`,
      )
    }
  } finally {
    done()
  }
})

test('第 7 项：钩子文件在、但 git 配置没指过去 → 警告给出安装命令', () => {
  const { root, done } = gitRepo(0)
  try {
    for (const name of HOOK_NAMES) {
      fs.mkdirSync(path.join(root, '.github', 'hooks'), { recursive: true })
      fs.writeFileSync(path.join(root, '.github', 'hooks', name), '#!/bin/sh\nexit 0\n')
    }
    const result = checkHooksInstalled(root)
    assert.ok(
      result.warnings.some((w) => w.includes('core.hooksPath') && w.includes('install.mjs')),
      `应该提示跑安装脚本，实际：${result.warnings.join('｜')}`,
    )
  } finally {
    done()
  }
})

test('第 7 项：配置指向别的目录也算没装（不能只看存在）', () => {
  const { root, done } = gitRepo(0)
  try {
    fs.mkdirSync(path.join(root, '.github', 'hooks'), { recursive: true })
    for (const name of HOOK_NAMES) {
      fs.writeFileSync(path.join(root, '.github', 'hooks', name), '#!/bin/sh\nexit 0\n')
    }
    execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: root })
    const result = checkHooksInstalled(root)
    assert.ok(
      result.warnings.some((w) => w.includes('.git/hooks')),
      `应该指出实际值不对，实际：${result.warnings.join('｜')}`,
    )
  } finally {
    done()
  }
})
