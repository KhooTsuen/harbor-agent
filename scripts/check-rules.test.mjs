/**
 * `scripts/check-rules.mjs` 自己的测试
 *
 *   node --test scripts/check-rules.test.mjs
 *
 * 为什么检查脚本也要有测试：它是「拦违规」的那道闸。闸自己坏了（错报、漏报、
 * 一跑就崩）比没有闸更糟 —— 人会以为「检查通过了 = 没问题」。
 * 每个检查项都要有**一个通过的用例 + 一个失败的用例**：只测"通过"容易写出
 * 一个永远通过的假检查。
 *
 * 约定：临时目录建环境（不碰真实仓库）、直接调导出函数（不 spawn）、测完清理。
 * 夹具（`tempRoot` / `gitRepo` / `lines`）在 `./check-rules/test-kit.mjs` ——
 * 抽出去是因为这份文件顶着 300 行红线（它自己那条检查报的）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gitRepo, lines, marker, readRepoFile, REPO, tempRoot } from './check-rules/test-kit.mjs'
import {
  checkAgentMd,
  checkDiffSize,
  checkLineLimits,
  checkNoNewDeps,
  checkNoSecretsInConfig,
  checkTodos,
  runAll,
} from './check-rules.mjs'

/* 行数检查复用 tools/line-limit.mjs —— 临时根里也要放一份它的副本 */
const withTool = (files) => tempRoot({ 'tools/line-limit.mjs': readRepoFile('tools/line-limit.mjs'), ...files })

test('行数：全在 300 行以内就通过', () => {
  const { root, done } = withTool({ 'src/small.ts': lines(10) })
  try {
    const r = checkLineLimits(root)
    assert.deepEqual(r.errors, [])
    assert.match(r.summary, /文件/)
  } finally {
    done()
  }
})

test('行数：301 行就报出来（含文件名和行数）', () => {
  const { root, done } = withTool({ 'src/big.ts': `${lines(301)}\n` })
  try {
    const r = checkLineLimits(root)
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /src\/big\.ts/)
    assert.match(r.errors[0], /301/)
  } finally {
    done()
  }
})

test('行数：找不到 line-limit 就报错（不许静默通过）', () => {
  const { root, done } = tempRoot({ 'src/a.ts': lines(3) })
  try {
    const r = checkLineLimits(root)
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /line-limit/)
  } finally {
    done()
  }
})

const pkgWith = (deps) => JSON.stringify({ name: 'x', version: '1.0.0', dependencies: deps })
const lockWith = (deps) => JSON.stringify({ name: 'x', version: '1.0.0', packages: { '': { dependencies: deps } } })

test('依赖：两侧一致（含版本）就通过', () => {
  const { root, done } = tempRoot({
    'package.json': pkgWith({ react: '^18.0.0' }),
    'package-lock.json': lockWith({ react: '^18.0.0' }),
  })
  try {
    assert.deepEqual(checkNoNewDeps(root).errors, [])
  } finally {
    done()
  }
})

test('依赖：只在一侧出现 / 版本不一致都要报', () => {
  const { root, done } = tempRoot({
    'package.json': pkgWith({ react: '^18.0.0', 'left-pad': '^1.0.0' }),
    'package-lock.json': lockWith({ react: '^17.0.0', lodash: '^4.0.0' }),
  })
  try {
    const r = checkNoNewDeps(root)
    assert.equal(r.errors.length, 3, r.errors.join(' / '))
    assert.ok(r.errors.some((e) => e.includes('left-pad')))
    assert.ok(r.errors.some((e) => e.includes('lodash')))
    assert.ok(r.errors.some((e) => e.includes('版本两侧不一致')))
  } finally {
    done()
  }
})

test('依赖：读不到 package.json 就报错（不是抛异常）', () => {
  const { root, done } = tempRoot()
  try {
    const r = checkNoNewDeps(root)
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /读不到/)
  } finally {
    done()
  }
})

test('密钥：没有 data/config.json 时跳过（不算错）', () => {
  const { root, done } = tempRoot()
  try {
    const r = checkNoSecretsInConfig(root)
    assert.deepEqual(r.errors, [])
    assert.match(r.summary, /跳过/)
  } finally {
    done()
  }
})

test('密钥：只留 credentialRef 的配置通过', () => {
  const { root, done } = tempRoot({
    'data/config.json': JSON.stringify({
      providers: [{ id: 'p1', apiKey: '', credentialRef: 'provider:p1' }],
      search: { apiKey: '' },
    }),
  })
  try {
    assert.deepEqual(checkNoSecretsInConfig(root).errors, [])
  } finally {
    done()
  }
})

test('★ 密钥：sk- 开头的串会被抓到，而且**不回显密钥**', () => {
  const secret = 'sk-abcdefghijklmnop1234'
  const { root, done } = tempRoot({
    'data/config.json': JSON.stringify({ general: { note: secret } }),
  })
  try {
    const r = checkNoSecretsInConfig(root)
    assert.equal(r.errors.length, 1)
    assert.ok(!r.errors[0].includes(secret), '报错里不许出现完整密钥')
    assert.match(r.errors[0], /共 \d+ 字符/)
  } finally {
    done()
  }
})

test('密钥：落盘的 apiKey 非空也报（只允许空串 / 掩码）', () => {
  const { root, done } = tempRoot({
    'data/config.json': JSON.stringify({
      providers: [{ id: 'p1', apiKey: 'real-key-here' }],
      search: { apiKey: '••••••••' },
    }),
  })
  try {
    const r = checkNoSecretsInConfig(root)
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /providers\[p1\]/)
    /* 掩码是允许的（那是给界面看的那份） */
    assert.ok(!r.errors[0].includes('search'))
  } finally {
    done()
  }
})

test('TODO：没有标记就什么都不报', () => {
  const { root, done } = tempRoot({ 'src/a.ts': 'const a = 1\n' })
  try {
    const r = checkTodos(root)
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.warnings, [])
  } finally {
    done()
  }
})

test('★ TODO：有标记只警告、不失败（带文件与行号）', () => {
  const { root, done } = tempRoot({ 'src/a.ts': `const a = 1\n${marker('TODO', '以后再说')}\n` })
  try {
    const r = checkTodos(root)
    assert.deepEqual(r.errors, [], 'TODO 不许算失败')
    assert.equal(r.warnings.length, 2, r.warnings.join(' / '))
    assert.match(r.warnings[1], /src\/a\.ts:2/)
  } finally {
    done()
  }
})

test('TODO：检查脚本自己不会被自己的正则误伤', () => {
  assert.deepEqual(checkTodos(REPO).errors, [])
})

test('AGENT.md：有章节结构就通过', () => {
  const text = '# AGENT.md\n\n## 1. 第一铁律\n## 2. 硬约束\n## 3. 硬禁区\n## 4. 收工前必须跑\n'
  const { root, done } = tempRoot({ 'AGENT.md': text })
  try {
    const r = checkAgentMd(root)
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.warnings, [])
  } finally {
    done()
  }
})

test('★ AGENT.md：整段被覆盖（章节没了）要警告', () => {
  const { root, done } = tempRoot({ 'AGENT.md': '# AGENT.md\n\n随便写了点别的。\n' })
  try {
    const r = checkAgentMd(root)
    assert.deepEqual(r.errors, [])
    assert.equal(r.warnings.length, 4, r.warnings.join(' / '))
    assert.match(r.warnings[0], /第一铁律/)
  } finally {
    done()
  }
})

test('AGENT.md：不在 / 是空的都要报错', () => {
  const missing = tempRoot()
  const blank = tempRoot({ 'AGENT.md': '   \n\n' })
  try {
    assert.equal(checkAgentMd(missing.root).errors.length, 1)
    assert.equal(checkAgentMd(blank.root).errors.length, 1)
  } finally {
    missing.done()
    blank.done()
  }
})

test('改动数：≤ 5 个文件不警告', () => {
  const { root, done } = gitRepo(3)
  try {
    const r = checkDiffSize(root)
    assert.deepEqual(r.warnings, [])
    assert.match(r.summary, /3 个/)
  } finally {
    done()
  }
})

test('★ 改动数：> 5 个文件只警告（把文件列出来）', () => {
  const { root, done } = gitRepo(7)
  try {
    const r = checkDiffSize(root)
    assert.deepEqual(r.errors, [], '范围大不许算失败')
    assert.ok(r.warnings.length > 1)
    assert.match(r.warnings[0], /> 5/)
    assert.ok(r.warnings.some((w) => w.includes('f0.ts')))
  } finally {
    done()
  }
})

test('改动数：不是 git 仓库时给警告、不抛异常', () => {
  const { root, done } = tempRoot()
  try {
    const r = checkDiffSize(root)
    assert.deepEqual(r.errors, [])
    assert.match(r.summary, /跳过/)
  } finally {
    done()
  }
})


test('★ runAll：在"故意造违规"的临时根里必须红，而且指名道姓', () => {
  const { root, done } = tempRoot({
    'src/big.ts': `${lines(400)}\n`,
    'data/config.json': JSON.stringify({ general: { note: 'sk-abcdefghijkl' } }),
  })
  try {
    const { errors, lines: summary } = runAll(root)
    assert.ok(errors.length >= 2, errors.join(' / '))
    assert.ok(errors.some((e) => e.includes('AGENT.md')), '缺 AGENT.md 应该报（见错误清单）')
    assert.ok(summary.some((l) => l.startsWith('✗')))
    assert.ok(summary.some((l) => l.startsWith('✓')))
  } finally {
    done()
  }
})

/* 清单结构（条目形状 / 必需项在不在）挪去了 check-rules.meta.test.mjs ——
   那类断言写在这里会把本文件顶过 300 行（2026-09-29 实测 301 行，被行数检查抓住）。 */
