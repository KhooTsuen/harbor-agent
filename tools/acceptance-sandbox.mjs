/**
 * 真机验收：**沙箱里放什么**（夹具）
 *
 * 从 `acceptance-cases.mjs` 拆出来的 —— 那边加完「判据证据」到 323 行（硬约束 #2 = 300）。
 * 分口子就按那个文件头自己写的两件事切：**这里管夹具**（写哪些文件、怎么重置），
 * `acceptance-cases.mjs` 管「跑哪几类任务、怎么判」，`acceptance.mjs` 管驱动。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CALC = `export function add(a, b) {
  return a + b
}

/* BUG（故意留的）：应该返回 a * b */
export function multiply(a, b) {
  return a + b
}
`

export const CALC_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, multiply } from './calc.mjs'

test('add', () => assert.equal(add(2, 3), 5))
test('multiply', () => assert.equal(multiply(2, 3), 6))
`

/** 「multiply 改对了没有」的判据正则（多条用例共用） */
export const FIXED = /multiply[\s\S]{0,100}return\s+a\s*\*\s*b/

/* T7 用：一份中文文件名的说明，要求照抄一行到另一个中文文件名里 */
export const GUIDE_MD = `# 验收说明

请在工作目录新建一个文件「读取结果.txt」，里面**只写这一行**（一字不差）：

验收通过-中文文件名-4172
`

/* T8 用：300 行日志，第 137 行处藏着唯一线索 */
export const LOG_SAMPLE = (() => {
  const lines = []
  for (let i = 1; i <= 300; i += 1) {
    if (i === 137) lines.push('批处理编号：ZX-7783（本行是唯一线索）')
    lines.push(`2026-09-25T00:${String(i % 60).padStart(2, '0')}:00 心跳 #${i} ok`)
  }
  return lines.join('\n') + '\n'
})()

/**
 * 每次重置要删掉的文件。
 * 两处用它：prepareSandbox 的清理、T5 判「有没有多建文件」。
 */
export const MINE = ['calc.mjs', 'calc.test.mjs', 'greet.mjs', 'nosuch.test.mjs', '读取结果.txt', 'math.mjs']

/** 把沙箱恢复成初始状态（每个任务、每一轮都调） */
export function prepareSandbox(sandbox) {
  mkdirSync(sandbox, { recursive: true })
  for (const name of MINE) rmSync(join(sandbox, name), { force: true })
  writeFileSync(join(sandbox, 'calc.mjs'), CALC)
  writeFileSync(join(sandbox, 'calc.test.mjs'), CALC_TEST)
  writeFileSync(join(sandbox, '说明.md'), GUIDE_MD)
  writeFileSync(join(sandbox, '日志样本.txt'), LOG_SAMPLE)
}
