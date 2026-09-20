/**
 * 破坏性测试 E 组 · 定位「C 盘放行、E 盘拒绝」
 *
 * capability.check 的判定链是：
 *   realpath(target) → currentScope() → sensitiveReason() → isInside(realpath(workdir))
 *
 * 这里把每一步的中间值都打出来，看是哪一步对 C 盘给了「在工作目录里」的结论。
 *
 *   node tools/break-test-capability2.mjs
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cap = require(join(ROOT, 'electron/core/capability.cjs'))

const wd = join(ROOT, 'test-env', 'PersonalAgent', 'data', 'workspace')

/* capability 内部函数没导出，这里靠 check 的返回值反推 */
const probes = [
  String.raw`C:\Windows\win.ini`,
  String.raw`D:\nothing-here.txt`,
  String.raw`Z:\whatever.txt`,
  String.raw`${process.cwd()}\package.json`,
]

for (const p of probes) {
  const r = cap.check(p, { workdir: wd, sessionId: 'break-test' })
  console.log(
    `${r.ok ? '⚠️ 放行' : '🛡 拒绝'} | ${p}` +
      `\n     absolute=${r.absolute}` +
      `\n     reason=${String(r.reason ?? '(无)').slice(0, 70)}` +
      `\n     needGrant=${r.needGrant ?? false} sensitive=${r.sensitive ?? '-'}`,
  )
}

console.log('\n── 对照：直接看 realpath / canon 对这两个盘的处理 ──')
/* 从 capability 内部行为反推：传一个不存在的路径看它落到哪 */
for (const p of [
  String.raw`C:\definitely\not\here\x.txt`,
  String.raw`E:\definitely\not\here\x.txt`,
]) {
  const r = cap.check(p, { workdir: wd, sessionId: 'break-test' })
  console.log(`${r.ok ? '⚠️ 放行' : '🛡 拒绝'} | ${p} → absolute=${r.absolute}`)
}
