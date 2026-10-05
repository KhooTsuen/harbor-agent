/**
 * `checkVersionBump` 的行为测试
 *
 * 怎么跑：`node --test scripts/check-rules*.test.mjs`（与其他 check-rules 测试同一套）
 *
 * 为什么每条都造一个**真的 git 仓库**：这条检查的输入就是 git 历史
 * （谁改了什么、上一版版本号是多少），拿假对象替身测不出「浅克隆 / 没有历史」那类边界 ——
 * 而那正是最容易误报、一误报就会拦住所有人提交的地方。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

import { checkVersionBump } from './check-rules/checks-version.mjs'

/** 造一个临时 git 仓库（自带 commit / 写文件两个小工具） */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-rules-ver-'))
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

test('改了代码并升了版本 → 过', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    r.commit('init')

    r.write('package.json', pkg('1.0.1'))
    r.write('src/a.ts', 'const a = 2\n')
    r.commit('fix')

    const out = checkVersionBump(r.root)
    assert.deepEqual(out.errors, [])
    assert.equal(out.summary, '1.0.0 → 1.0.1')
  } finally {
    r.done()
  }
})

test('★ 改了代码却没升版本 → 报错（这就是这次要拦的那件事）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    r.commit('init')

    r.write('src/a.ts', 'const a = 2\n')
    r.commit('改了代码没升版本')

    const out = checkVersionBump(r.root)
    /* 3 行 = 主因 + 「按通道规矩怎么升」 + 「CHANGELOG 也要动」 */
    assert.equal(out.errors.length, 3)
    assert.match(out.errors[0], /改了代码却没升版本号/)
    /* 报错要说清「怎么办」：通道规矩 + CHANGELOG 也要动 */
    assert.match(out.errors[1], /补丁号/)
    assert.match(out.errors[2], /CHANGELOG/)
  } finally {
    r.done()
  }
})

test('★ 版本降级也算漏（不能拿更低的版本顶）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.1'))
    r.write('src/a.ts', 'const a = 1\n')
    r.commit('init')

    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 2\n')
    r.commit('降级')

    assert.ok(checkVersionBump(r.root).errors.length > 0)
  } finally {
    r.done()
  }
})

/*
 * 预发布号（2026-10-06 修的盲点）
 *
 * 原来只取 `x.y.z` 三段，`1.30.0-beta.1` 和 `1.30.0-beta.2` 都被解析成同一组数字
 * → beta 之间的升级被判成「没升版本」。这条把 beta 通道整条路堵死了，
 * 而本项目真的用过 beta.1…beta.40（见 CHANGELOG 的 1.20.0 那一段）。
 * 按原意修：**预发布号也算数** —— 标准不降（还是「必须更新」），只是能看见它了。
 */
test('★ beta 之间也算升（beta.1 → beta.2）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.30.0-beta.1'))
    r.write('src/a.ts', 'const a = 1\n')
    r.commit('init')

    r.write('package.json', pkg('1.30.0-beta.2'))
    r.write('src/a.ts', 'const a = 2\n')
    r.commit('feat batch 2')

    const out = checkVersionBump(r.root)
    assert.deepEqual(out.errors, [])
    assert.equal(out.summary, '1.30.0-beta.1 → 1.30.0-beta.2')
  } finally {
    r.done()
  }
})

test('★ beta 号往后退也算漏（beta.2 → beta.1）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.30.0-beta.2'))
    r.write('src/a.ts', 'const a = 1\n')
    r.commit('init')

    r.write('package.json', pkg('1.30.0-beta.1'))
    r.write('src/a.ts', 'const a = 2\n')
    r.commit('往回退')

    assert.ok(checkVersionBump(r.root).errors.length > 0)
  } finally {
    r.done()
  }
})

test('★ 正式版比任何同号 beta 都新（beta.9 → 正式版）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.30.0-beta.9'))
    r.write('src/a.ts', 'const a = 1\n')
    r.commit('init')

    r.write('package.json', pkg('1.30.0'))
    r.write('src/a.ts', 'const a = 2\n')
    r.commit('正式版')

    assert.deepEqual(checkVersionBump(r.root).errors, [])
  } finally {
    r.done()
  }
})

test('只动文档 / 脚本 → 不要求升版本（改文档也要升只会制造噪音）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('docs/x.md', '一\n')
    r.commit('init')

    r.write('docs/x.md', '二\n')
    r.commit('只有文档')

    const out = checkVersionBump(r.root)
    assert.deepEqual(out.errors, [])
    assert.match(out.summary, /不要求升版本/)
  } finally {
    r.done()
  }
})

test('electron/** 也算代码（内核改了同样要升）', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('electron/core/x.cjs', '// a\n')
    r.commit('init')

    r.write('electron/core/x.cjs', '// b\n')
    r.commit('改内核没升')

    assert.ok(checkVersionBump(r.root).errors.length > 0)
  } finally {
    r.done()
  }
})

test('★ 待提交状态（pre-commit）：改了代码没升 → 报错', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    r.commit('init')

    /* 只改工作区，不提交 —— 钩子跑的那一刻就是这个状态 */
    r.write('src/a.ts', 'const a = 2\n')

    assert.ok(checkVersionBump(r.root).errors.length > 0)
  } finally {
    r.done()
  }
})

test('★ 待提交状态：代码与版本一起改 → 过', () => {
  const r = repo()
  try {
    r.write('package.json', pkg('1.0.0'))
    r.write('src/a.ts', 'const a = 1\n')
    r.commit('init')

    r.write('package.json', pkg('1.1.0'))
    r.write('src/a.ts', 'const a = 2\n')

    const out = checkVersionBump(r.root)
    assert.deepEqual(out.errors, [])
    assert.equal(out.summary, '1.0.0 → 1.1.0')
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

    const out = checkVersionBump(r.root)
    assert.deepEqual(out.errors, [])
    assert.equal(out.warnings.length, 1)
    assert.equal(out.summary, '跳过')
  } finally {
    r.done()
  }
})
