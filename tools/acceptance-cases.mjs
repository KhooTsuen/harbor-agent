/**
 * 真机验收：任务集与沙箱
 *
 * 从 acceptance.mjs 拆出来的 —— 那边加完新场景就顶到 300 行红线（硬约束 #2）。
 * 这里只回答两件事：**沙箱里放什么**、**跑哪几类任务、怎么判**；
 * 驱动（起应用、发消息、等结束、统计）在 acceptance.mjs。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CALC = `export function add(a, b) {
  return a + b
}

/* BUG（故意留的）：应该返回 a * b */
export function multiply(a, b) {
  return a + b
}
`

const CALC_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, multiply } from './calc.mjs'

test('add', () => assert.equal(add(2, 3), 5))
test('multiply', () => assert.equal(multiply(2, 3), 6))
`

const FIXED = /multiply[\s\S]{0,100}return\s+a\s*\*\s*b/

/* T7 用：一份中文文件名的说明，要求照抄一行到另一个中文文件名里 */
const GUIDE_MD = `# 验收说明

请在工作目录新建一个文件「读取结果.txt」，里面**只写这一行**（一字不差）：

验收通过-中文文件名-4172
`

/* T8 用：300 行日志，第 137 行处藏着唯一线索 */
const LOG_SAMPLE = (() => {
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
const MINE = ['calc.mjs', 'calc.test.mjs', 'greet.mjs', 'nosuch.test.mjs', '读取结果.txt', 'math.mjs']

/** 把沙箱恢复成初始状态（每个任务、每一轮都调） */
export function prepareSandbox(sandbox) {
  mkdirSync(sandbox, { recursive: true })
  for (const name of MINE) rmSync(join(sandbox, name), { force: true })
  writeFileSync(join(sandbox, 'calc.mjs'), CALC)
  writeFileSync(join(sandbox, 'calc.test.mjs'), CALC_TEST)
  writeFileSync(join(sandbox, '说明.md'), GUIDE_MD)
  writeFileSync(join(sandbox, '日志样本.txt'), LOG_SAMPLE)
}

/**
 * 任务集：每类一档能力，verify 只看**磁盘产物**（或本轮新会话的最后一条回答）。
 *
 * @param {object} ctx { sandbox: string, newestSession: () => string }
 */
export function buildCases(ctx) {
  const sandbox = ctx.sandbox
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  const f = (...parts) => join(sandbox, ...parts)

  /* 本轮会话里最后一条**完整**的助手回答（T8 判「答案里有没有那根针」） */
  const lastAnswer = () => {
    const file = ctx.newestSession()
    if (!file || !existsSync(file)) return ''
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const rec = JSON.parse(lines[i])
        if (rec.type === 'message' && rec.role === 'assistant' && rec.partial !== true) {
          return String(rec.content ?? '')
        }
      } catch {
        /* 坏行跳过 */
      }
    }
    return ''
  }

  return [
    {
      id: 'T1-只读答疑',
      prompt:
        '读一下工作目录里的 calc.mjs 和 calc.test.mjs，用一句话说清这个模块导出什么、测试测了什么。不要修改任何文件。',
      verify: () => {
        const ok = read(f('calc.mjs')) === CALC && read(f('calc.test.mjs')) === CALC_TEST
        return { pass: ok, detail: ok ? '只读任务，两个文件都没被动' : '只读任务却改了文件' }
      },
    },
    {
      id: 'T2-单文件修改',
      prompt:
        '工作目录里 calc.mjs 的 multiply 函数是错的（现在返回 a+b，应该是 a*b）。请把它改对，改完不要跑测试。',
      verify: () => {
        const ok = FIXED.test(read(f('calc.mjs')))
        return { pass: ok, detail: ok ? 'multiply 已改成 a*b' : '没改对' }
      },
    },
    {
      id: 'T3-改完跑测试',
      prompt:
        'calc.mjs 的 multiply 是错的（返回 a+b，应为 a*b）。先改对，然后运行 node --test calc.test.mjs 验证，把测试结果告诉我。',
      verify: () => {
        const ok = FIXED.test(read(f('calc.mjs')))
        return { pass: ok, detail: ok ? 'multiply 已改对（有没有真跑测试看台账）' : '没改对' }
      },
      needShell: true,
    },
    {
      id: 'T4-新建文件',
      prompt:
        '在工作目录新建 greet.mjs，导出一个函数 greet(name)，返回字符串「你好，」拼上 name（注意是中文逗号）。只建这一个文件。',
      verify: () => {
        const src = read(f('greet.mjs'))
        const ok = /greet/.test(src) && /你好，|你好,/.test(src)
        return { pass: ok, detail: ok ? 'greet.mjs 已建且内容正确' : src ? '内容不对' : '文件没建' }
      },
    },
    {
      id: 'T5-失败处理',
      prompt:
        '运行 node --test 这个目录里不存在的文件 nosuch.test.mjs，然后用一句话说明失败原因。不要新建任何文件。',
      verify: () => {
        const extra = MINE.filter(
          (name) => !['calc.mjs', 'calc.test.mjs'].includes(name) && existsSync(f(name)),
        )
        return {
          pass: extra.length === 0,
          detail: extra.length === 0 ? '失败被正确报告、没多建文件' : `多建了：${extra.join(', ')}`,
        }
      },
    },
    {
      id: 'T6-多文件重构',
      prompt:
        '重构一下：把 calc.mjs 里的两个函数挪到新文件 math.mjs（add 与 multiply 都导出）；顺手修掉 multiply 的 bug（应该是 a*b）；' +
        'calc.mjs 改成只从 math.mjs 转发；calc.test.mjs 的 import 也改成从 math.mjs 导入。最后运行 node --test calc.test.mjs 确认通过，把结果告诉我。',
      verify: () => {
        const math = read(f('math.mjs'))
        const calc = read(f('calc.mjs'))
        const test = read(f('calc.test.mjs'))
        const fixes = FIXED.test(math) && /['"]\.\/math\.mjs['"]/.test(calc) && /['"]\.\/math\.mjs['"]/.test(test)
        return {
          pass: fixes,
          detail: fixes
            ? '拆到 math.mjs、两处 import 都改了'
            : `math=${math ? '有' : '无'} 修对=${FIXED.test(math)} calc转发=${/['"]\.\/math\.mjs['"]/.test(calc)} test指向=${/['"]\.\/math\.mjs['"]/.test(test)}`,
        }
      },
      needShell: true,
    },
    {
      id: 'T7-中文文件名',
      prompt: '读一下工作目录里的「说明.md」，按里面的要求做。',
      verify: () => {
        const out = read(f('读取结果.txt'))
        const ok = out.includes('验收通过-中文文件名-4172')
        return {
          pass: ok,
          detail: ok ? '按说明写出了结果文件' : out ? '结果文件内容不对' : '没有建结果文件',
        }
      },
    },
    {
      id: 'T8-长文件找针',
      prompt:
        '在 日志样本.txt 里找出「批处理编号」（ZX- 开头那串），只把编号本身回给我。不要修改任何文件。',
      verify: () => {
        const answer = lastAnswer()
        const untouched = read(f('日志样本.txt')) === LOG_SAMPLE
        const hit = /ZX-7783/.test(answer)
        return {
          pass: hit && untouched,
          detail: hit
            ? `回答里有编号，文件${untouched ? '没动' : '被动过'}`
            : `回答里没找到编号${untouched ? '' : '，且文件被动过'}`,
        }
      },
    },
  ]
}
