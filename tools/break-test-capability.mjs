/**
 * 破坏性测试 E 组 · 直接问 capability：哪些路径能过
 *
 * 上一轮「读 C 盘放行」的结果不可靠 —— 当时 ctx 里没带 config，
 * 而 capability.check 是**自己读 config** 决定 scope 的。所以这里绕开工具层，
 * 直接调它，把「能不能过闸门」这件事单独问清楚。
 *
 *   node tools/break-test-capability.mjs
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cap = require(join(ROOT, 'electron/core/capability.cjs'))
const config = require(join(ROOT, 'electron/core/config.cjs'))

const wd = join(ROOT, 'test-env', 'PersonalAgent', 'data', 'workspace')

console.log('当前 fileScope =', config.get().tools.fileScope)
console.log('工作目录 =', wd)
console.log('')

const cases = [
  [String.raw`C:\Windows\win.ini`, 'C 盘系统文件'],
  ['C:' + '\\', 'C 盘根目录'],
  [join(wd, 'ok.txt'), '工作目录内'],
  [join(wd, '..', '..', 'outside.txt'), '工作目录外（算出来的绝对路径）'],
  [join(ROOT, 'data', 'config.json'), '项目 data/config.json'],
  [join(ROOT, 'data', 'credentials.json'), '凭证库'],
  ['..', '相对路径 ..'],
  [String.raw`\\?\C:\Windows`, '长路径前缀绕过尝试'],
  [String.raw`C:\Windows\..\Windows\win.ini`, '中间夹 .. 的绝对路径'],
]

for (const [p, label] of cases) {
  let ok = false
  let reason = ''
  try {
    const r = cap.check(p, { workdir: wd, sessionId: 'break-test' })
    ok = r.ok
    reason = String(r.reason ?? '')
  } catch (error) {
    reason = `抛错：${error?.message ?? error}`
  }
  console.log(`${ok ? '⚠️ 放行' : '🛡 拒绝'} | ${label.padEnd(28)} | ${reason.slice(0, 60)}`)
}
