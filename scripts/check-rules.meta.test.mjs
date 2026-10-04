/* 「关于检查清单本身」的测试（元测试）：
 *   ① 清单结构合法 + 必需项都在（不数数量）
 *   ② 第 7 项：约束机制（git 钩子）在位
 *   ③ 提交标题的前缀闸门（`scripts/hooks/commit-msg.mjs`）
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
import { PREFIXES, checkSubject, subjectOf } from './hooks/commit-msg.mjs'

/* 这份名单故意**不** import `checks-hooks.mjs` 的 `HOOKS`：测试手里得有一份自己的名单，
   才验得出「检查脚本看漏了一个钩子」—— 跟着被测对象走，就永远验不出它错。 */
const HOOK_NAMES = ['pre-commit', 'pre-push', 'commit-msg']

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

test('第 7 项：真实仓库里跑一遍 —— 装了就闭嘴，没装就点名', () => {
  const result = checkHooksInstalled(REPO)
  assert.deepEqual(result.errors, [], '这一项只警告不报错（新克隆还没装时不该红）')

  /* ★ 这里原本写的是「真实仓库的 warnings 必须为空」—— **只在装过钩子的机器上成立**：
     `core.hooksPath` 是本地 git 配置，克隆不出来（本文档第 3 节就写着「换台机器要重跑一次」），
     所以 CI 上必然落在「没装」那一支，那笔提交一推上去就红了（Run 198）。
     两条路都合法，但都得把话说清楚：装了就别再啰嗦，没装必须点名缺什么 + 给出安装命令。 */
  const said = result.warnings.join('｜')
  if (result.summary === '钩子已装') {
    assert.deepEqual(result.warnings, [], `说了「钩子已装」就不能同时有警告：${said}`)
  } else {
    assert.ok(
      said.includes('core.hooksPath') && said.includes('install.mjs'),
      `没装钩子就得点名 core.hooksPath 和安装命令，实际：${said}`,
    )
  }
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

/* ── ③ 提交标题的前缀闸门 ─────────────────────────────────────────
   规矩在 CONTRIBUTING.md 的「提交标题的格式」，词表在 hooks/commit-msg.mjs。
   这里钉住**判定本身**，别让词表和判定各自跑偏。 */

test('词表：不重名，每项都是 [前缀, 用在]（**不数数量** —— 词表以后会加）', () => {
  assert.ok(PREFIXES.length > 0, '词表不能是空的')
  for (const entry of PREFIXES) {
    assert.ok(Array.isArray(entry) && entry.length === 2, `应该是 [前缀, 用在]：${JSON.stringify(entry)}`)
    assert.ok(typeof entry[0] === 'string' && entry[0].length > 0, '前缀不能为空')
    assert.ok(typeof entry[1] === 'string' && entry[1].length > 0, `${entry[0]} 的「用在」不能为空`)
  }
  const names = PREFIXES.map(([prefix]) => prefix)
  assert.equal(new Set(names).size, names.length, `词表里有重名：${names.join('、')}`)
})

test('提交标题：词表里每个前缀都放行（前缀后是全角冒号）', () => {
  for (const [prefix] of PREFIXES) {
    const verdict = checkSubject(`${prefix}：随便一句为什么`)
    assert.equal(verdict.ok, true, `${prefix}：应该放行，却报了 ${verdict.reason}`)
  }
})

test('★ 提交标题：没前缀 / 前缀不在词表里 → 拦下，并说清为什么', () => {
  for (const line of ['update stuff', '优化：自己发明的词', '修复:半角冒号也不在表里']) {
    const verdict = checkSubject(line)
    assert.equal(verdict.ok, false, `${line} 应该被拦下`)
    assert.ok(verdict.reason, '拦下时必须给出原因（不能只是 false）')
  }
  assert.match(checkSubject('update stuff').reason, /没有前缀|不在词表/)
})

test('★ 提交标题：半角冒号拦下，并点名要全角（最常见的手滑）', () => {
  const verdict = checkSubject('修: 用了半角冒号')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /全角/)
})

test('提交标题：git 自己造的放行（Merge / Revert / fixup! / squash!）', () => {
  for (const line of ["Merge branch 'x' into y", 'Revert "修：xxx"', 'fixup! 修：xxx', 'squash! 文档：xxx']) {
    assert.equal(checkSubject(line).ok, true, `${line} 应该放行`)
  }
})

test('提交标题：取第一条非空、非注释行（git 会往提交信息文件里塞注释）', () => {
  const text = '# Please enter the commit message\n\n修：标题在这\n\n正文\n# 注释'
  assert.equal(subjectOf(text), '修：标题在这')
  assert.equal(subjectOf('# 只有注释\n'), '')
})
