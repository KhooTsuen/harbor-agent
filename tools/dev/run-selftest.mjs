/*
 * 跑内核自检并把 ❌ 行摘出来（终端输出太长会被截断，落盘更靠得住）。
 *
 * 用法：node tmp/run-selftest.mjs
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const REPO = 'E:\\CodexWorkbench'
const started = Date.now()
const result = spawnSync('node', ['scripts/selftest.mjs'], {
  cwd: REPO,
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
})

const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
writeFileSync(`${REPO}\\tmp\\selftest.txt`, text, 'utf8')

const lines = text.split('\n')
const bad = lines.filter((line) => line.includes('❌'))
const summary = lines.filter((line) => /✅\s*\d+|❌\s*\d+|失败\s*\d+|通过\s*\d+/.test(line))

console.log(`exit=${result.status}  用时 ${Math.round((Date.now() - started) / 1000)} 秒`)
console.log(`输出 ${lines.length} 行 → tmp/selftest.txt`)
console.log(summary.slice(-6).join('\n') || '（没找到汇总行）')
console.log('—— ❌ 行 ——')
console.log(bad.slice(0, 30).join('\n') || '（没有 ❌，全绿）')
