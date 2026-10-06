/**
 * `checkChangelogChange` 的行为测试（原 `check-rules.version.test.mjs`）
 *
 * 怎么跑：`npm run test:rules`（与其他 check-rules 测试同一套，按 `check-rules*.test.mjs` 自动发现）
 *
 * ── 为什么这条规矩换了口径（2026-10-07）──
 * 原来是「改了代码必须升版本号」。它把版本号变成了提交计数器：CHANGELOG 234 个版本段、
 * 一天 16 个 beta，其中七版连 tag 都没建。现在改拦「改了代码必须写 CHANGELOG」，
 * 版本号只在发布时升。这些测试跟着口径改 —— 旧口径那 10 条已经不再对应任何规矩。
 *
 * 为什么每条都造一个**真的 git 仓库**：这条检查的输入就是 git 历史
 * （谁改了什么），拿假对象替身测不出「浅克隆 / 没有历史」那类边界 ——
 * 而那正是最容易误报、一误报就会拦住所有人提交的地方。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

import { checkChangelogChange } from './check-rules/checks-changelog.mjs'

/** 造一个临时 git 仓库（自带 commit / 写文件两个小工具） */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-rules-cg-'))
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  run(['init', '-q'])
  const write = (rel, text) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text)
  }
  const commit = (message) => {
    execFileSync('git', ['add', '-A'], { cwd: root })
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message])
  }
  return { root, write, commit, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const pkg = (version) => JSON.stringify({ name: 'x', version }, null, 2)
const CL = (title) => `# 更新日志\n\n## [${title}]\n\n- 一笔\n`

test('★ 改了代码 + 动了 CHANGELOG → 过（发布时的正常形态）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    r.write('CHANGELOG.md', CL('未发布'))
    r.commit('init')

    r.write('src/a.ts', 'const a = 2\n')
    r.write('CHANGELOG.md', CL('未发布') + '\n- 又一笔\n')
    r.commit('fix')

    const out = checkChangelogChange(r.root)
    assert.deepEqual(out.errors, [])
    assert.equal(out.summary, '1 个源文件 + CHANGELOG')
  } finally {
    r.done()
  }
})

test('★ 改了代码却没动 CHANGELOG → 报错（这就是这条要拦的那件事）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    r.write('CHANGELOG.md', CL('未发布'))
    r.commit('init')

    r.write('src/a.ts', 'const a = 2\n')
    r.commit('改了代码没记账')

    const out = checkChangelogChange(r.root)
    /* 3 行 = 主因 + 「写进 [未发布] 段、要写什么」 + 「版本号不用动」 */
    assert.equal(out.errors.length, 3)
    assert.match(out.errors[0], /改了代码却没动 CHANGELOG/)
    assert.match(out.errors[1], /\[未发布\]/)
    assert.match(out.errors[2], /版本号不用动/)
  } finally {
    r.done()
  }
})

test('只动文档 / 脚本 → 不要求写 CHANGELOG（改文档也要记账只会制造噪音）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('docs/x.md', '一\n')
    r.commit('init')

    r.write('docs/x.md', '二\n')
    r.write('scripts/y.mjs', '// x\n')
    r.commit('只有文档与脚本')

    const out = checkChangelogChange(r.root)
    assert.deepEqual(out.errors, [])
    assert.match(out.summary, /不要求写 CHANGELOG/)
  } finally {
    r.done()
  }
})

test('electron/** 也算代码（内核改了同样要写 CHANGELOG）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('electron/core/x.cjs', '// a\n')
    r.commit('init')

    r.write('electron/core/x.cjs', '// b\n')
    r.commit('改内核没记账')

    assert.ok(checkChangelogChange(r.root).errors.length > 0)
  } finally {
    r.done()
  }
})

test('★ 发布提交（只动 package.json + CHANGELOG，没动代码）→ 跳过，不误报', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    r.write('CHANGELOG.md', CL('未发布'))
    r.commit('init')

    /* 发布：把 [未发布] 改名成版本号 + 升 package.json —— 一个源文件都没碰 */
    r.write('package.json', pkg('1.0.1'))
    r.write('CHANGELOG.md', CL('1.0.1 — 2026-10-07'))
    r.commit('发布 1.0.1')

    const out = checkChangelogChange(r.root)
    assert.deepEqual(out.errors, [])
    assert.match(out.summary, /不要求写 CHANGELOG/)
  } finally {
    r.done()
  }
})

test('★ 待提交状态（pre-commit）：改了代码没记账 → 报错', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    r.write('CHANGELOG.md', CL('未发布'))
    r.commit('init')

    /* 只改工作区，不提交 —— 钩子跑的那一刻就是这个状态 */
    r.write('src/a.ts', 'const a = 2\n')

    assert.ok(checkChangelogChange(r.root).errors.length > 0)
  } finally {
    r.done()
  }
})

test('★ 待提交状态：代码与 CHANGELOG 一起改 → 过', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    r.write('CHANGELOG.md', CL('未发布'))
    r.commit('init')

    r.write('src/a.ts', 'const a = 2\n')
    r.write('CHANGELOG.md', CL('未发布') + '\n- 一笔新的\n')

    assert.deepEqual(checkChangelogChange(r.root).errors, [])
  } finally {
    r.done()
  }
})

test('★ 没有历史（还没有提交 / 浅克隆）→ 跳过，绝不误报', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    /* 故意不提交 */

    const out = checkChangelogChange(r.root)
    assert.deepEqual(out.errors, [])
    assert.equal(out.warnings.length, 1)
    assert.equal(out.summary, '跳过')
  } finally {
    r.done()
  }
})
