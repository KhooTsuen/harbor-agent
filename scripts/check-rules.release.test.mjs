/* `scripts/check-release.mjs` 的测试。
 *
 * 文件名以 `check-rules.` 开头是**故意的**：`scripts/test-rules.mjs` 按
 * `^check-rules.*\.test\.mjs$` 自己发现并跑这一批（防「检查脚本自己坏了没人报」）。
 * 这里守的正是这套「检查机器」里的一员 —— 发布体检。
 *
 * 为什么必须有：`beta.4` … `beta.10` 七版丢掉 tag，就是因为**没有任何东西问过这一句**。
 * 一个只在人记得跑时才跑的体检，等于没有 —— 所以它自己也得有钉子。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { checkRelease } from './check-release.mjs'
import { REPO } from './check-rules/test-kit.mjs'

/** 建一个临时 git 仓库：带 package.json（version）+ 一个提交；tag 可选 */
function repo(version, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-release-'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version }))
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
  if (tag) git('tag', '-a', tag, '-m', tag)
  return { root, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('★ 本地有 tag → 没有 error（这条正是「升了版本还漏 tag」的对照面）', () => {
  const { root, done } = repo('1.2.3', 'v1.2.3')
  try {
    const r = checkRelease({ root, remote: false })
    assert.equal(r.local, true)
    assert.deepEqual(r.errors, [])
  } finally {
    done()
  }
})

test('★ 本地没 tag → 报 error，且给出**可直接粘贴**的建 tag 命令', () => {
  const { root, done } = repo('1.2.3')
  try {
    const r = checkRelease({ root, remote: false })
    assert.equal(r.local, false)
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /本地没有 tag v1\.2\.3/)
    assert.match(r.errors[0], /git tag -a v1\.2\.3 -m "Harbor 1\.2\.3"/)
  } finally {
    done()
  }
})

test('★ 只认「当前版本」那个 tag：别的 tag 再多也不算数', () => {
  const { root, done } = repo('1.2.4', 'v1.2.3')
  try {
    const r = checkRelease({ root, remote: false })
    assert.equal(r.local, false, 'v1.2.3 在，但不是 v1.2.4 —— 不能算通过')
    assert.equal(r.errors.length, 1)
  } finally {
    done()
  }
})

test('不在 git 仓库里 → 降级成 warning（判不了 ≠ 没有），不误报 error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-release-nogit-'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  try {
    const r = checkRelease({ root, remote: false })
    assert.equal(r.local, null)
    assert.deepEqual(r.errors, [])
    assert.equal(r.warnings.length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('要查远端却没 origin / 没网 → warning 跳过，不误报 error', () => {
  const { root, done } = repo('1.2.3', 'v1.2.3')
  try {
    /* 没有 origin 远程 —— `git ls-remote origin` 会失败，应被当成「查不了」 */
    const r = checkRelease({ root, remote: true })
    assert.equal(r.remote, null)
    assert.deepEqual(r.errors, [])
    assert.ok(r.warnings.some((item) => item.includes('远端')))
  } finally {
    done()
  }
})

test('★ CLI 在 --offline 下不许声称「远端有 tag」（输出未核对的东西 = 说假话）', () => {
  /* 用**假仓库状态无关**的写法：只看 stdout，不管退出码（升版本没 tag 时它本就该退 1） */
  const r = spawnSync(process.execPath, ['scripts/check-release.mjs', '--offline'], { cwd: REPO, encoding: 'utf8' })
  assert.ok(!/远端有 tag/.test(r.stdout ?? ''), '--offline 没查远端，却打印了「远端有 tag」')
})
