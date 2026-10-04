/**
 * 跑 `check-rules` **自己的**测试（`scripts/check-rules*.test.mjs`）
 *
 * ── 为什么要有这个文件 ──
 * `docs/约束机制说明.md` 里这些测试写的是「人 / CI」，但实际**谁都没跑** ——
 * pre-commit 只跑 `check-rules.mjs` 本身，CI 那一步也只跑它本身。
 * 也就是说：**检查脚本自己坏了、检查的清单漏了一项，不会有任何东西报出来**。
 * 这些测试就是专门用来防这件事的（它们拿肯定不过的输入喂检查，断言检查会红）。
 *
 * ── 为什么不用 `node --test "scripts/check-rules*.test.mjs"` ──
 * 实测（node 24）：那个通配对 node 不展开，一个文件都没匹配到时
 * **退出码仍是 0**，输出是 `tests 0 / pass 0 / fail 0` ——
 * 接进 CI 就是「看起来在跑测试，其实什么都没跑」。**假绿比不跑更糟**。
 * 所以这里自己找、自己数：一个都没找到就直接红。
 *
 * ── 为什么不让调用方写死文件列表 ──
 * 每从 `checks.mjs` 拆出一个新检查，就会多一份 `check-rules.<名字>.test.mjs`；
 * 写死列表必然漏（漏了还是静默的）。这里按命名约定自己发现。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const scriptsDir = path.resolve(import.meta.dirname)
const root = path.dirname(scriptsDir)

const files = fs
  .readdirSync(scriptsDir)
  .filter((name) => /^check-rules.*\.test\.mjs$/.test(name))
  .sort()
  .map((name) => path.join('scripts', name))

if (files.length === 0) {
  console.error('✗ 一份 check-rules 测试都没找到（命名约定 `scripts/check-rules*.test.mjs`）——')
  console.error('  这项**不许空着通过**：找不到测试和测试全过是两回事。')
  process.exit(1)
}

console.log(`跑 ${files.length} 份检查自测：${files.map((f) => path.basename(f)).join('、')}`)

try {
  execFileSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
} catch (error) {
  /* 把 node --test 的退出码原样带出去，别吞成 0 */
  process.exit(typeof error.status === 'number' ? error.status : 1)
}
