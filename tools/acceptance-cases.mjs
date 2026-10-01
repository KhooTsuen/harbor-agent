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

/**
 * T9–T11（AG-053）：**三类含糊需求** —— 验的是「开工前会不会先问一句」。
 *
 * 为什么不写成「必须弹卡」：那是模型判断，不是硬闸（硬闸会把正常任务也卡住）。
 * 所以判据分两层：
 *   · 每条任务自己的**产物**照例行判定（改对了吗 / 测试过不过）；
 *   · 三条里**至少 2 条**触发了澄清卡（次数由驱动脚本记 —— 它顺手把卡答掉，
 *     否则没人点的卡会把这一轮拖到超时）。
 * 不到 2/3 就去改提示词（`CLARIFY_RULE`），**不加硬闸**。
 */
const CLARIFY_PROMPTS = {
  /* ① 改法多种：同一个“整理”有好几种合理解法，而且会动到现有调用方 */
  multi:
    'calc.mjs 里现在两个函数摆着，看着有点散。帮我把它整理成一个像样的工具模块，' +
    '现有的测试要能接着跑过。（自己拿主意也行，但先说清你打算怎么做）',
  /* ② 不可逆：让他「处理一下」一份文档 —— 重写还是只调格式，后果差很多 */
  irreversible: '工作目录里的「说明.md」写得有点乱，你帮我处理一下。',
  /* ③ 影响面说不清：补测试这件事能没有边界地一直做下去 */
  scope:
    '给这个项目把测试补一补，覆盖得更全一点；跑 node --test 要全过。' +
    '补到什么程度你定，但要先告诉我你的起止范围。',
}

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

    /* ── AG-053：三类含糊需求（判据 2/3 触发澄清卡，见 CLARIFY_PROMPTS 上面那段） ── */
    {
      id: 'T9-含糊-改法多种',
      prompt: CLARIFY_PROMPTS.multi,
      vague: true,
      needShell: true,
      verify: () => {
        /* 产物判据：不能把现有的两个导出改没（测试直接 import 它们），且测试要过 */
        const calc = read(f('calc.mjs'))
        const test = read(f('calc.test.mjs'))
        const keepsExports = /export\s+(async\s+)?function\s+add\b/.test(calc) && /multiply\b/.test(calc)
        const testUntouched = test === CALC_TEST
        return {
          pass: keepsExports && testUntouched && calc !== CALC,
          detail: keepsExports
            ? testUntouched
              ? '整理过了，两个导出还在、测试没被改'
              : '动了测试文件（那是判定基准）'
            : '把 add / multiply 的导出弄没了（现有测试会直接挂）',
        }
      },
    },
    {
      id: 'T10-含糊-不可逆',
      prompt: CLARIFY_PROMPTS.irreversible,
      vague: true,
      verify: () => {
        /* 产物判据：确实动过那份文档（「处理一下」不能什么都不做），且它还读得出来 */
        const now = read(f('说明.md'))
        const changed = now !== GUIDE_MD && now.trim().length > 0
        const keepsKey = /验收通过-中文文件名-4172/.test(now)
        return {
          pass: changed,
          detail: changed
            ? keepsKey
              ? '改过了，关键那行还在'
              : '改过了，但把要照抄的关键行弄没了'
            : '一个字都没动（「处理一下」没落地）',
        }
      },
    },
    {
      id: 'T11-含糊-范围不清',
      prompt: CLARIFY_PROMPTS.scope,
      vague: true,
      needShell: true,
      verify: () => {
        /* 产物判据：测试文件确实补过；至于「补到什么程度」不判（那是他自己定的范围） */
        const test = read(f('calc.test.mjs'))
        const added = test !== CALC_TEST && /test\s*\(/.test(test)
        return {
          pass: added,
          detail: added ? '测试补过了' : '测试文件没变化',
        }
      },
    },
  ]
}
