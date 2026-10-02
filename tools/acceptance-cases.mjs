/**
 * 真机验收：**任务集与判据**
 *
 * 拆过两次，每次都是因为顶到 300 行（硬约束 #2）：
 *   · 夹具（沙箱里写哪些文件、怎么重置）→ `acceptance-sandbox.mjs`；
 *   · 驱动（起应用 / 发消息 / 等结束 / 前置检查 / 汇总）→ `acceptance.mjs` + `acceptance-report.mjs`；
 *   这里只回答一件事：**跑哪几类任务、每类怎么判** ——
 *   判据必须带**证据**（`acceptance-verdict.mjs`），观测不到就判 `unknown`。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, pass, unknown } from './acceptance-verdict.mjs'
import { CALC, CALC_TEST, FIXED, GUIDE_MD, LOG_SAMPLE, MINE } from './acceptance-sandbox.mjs'
import { buildClarifyCases } from './acceptance-cases-clarify.mjs'

/* 夹具（CALC / CALC_TEST / FIXED / GUIDE_MD / LOG_SAMPLE / MINE / prepareSandbox）
   都在 `acceptance-sandbox.mjs` —— 那边只管「沙箱里放什么」。 */

/* 「含糊需求」那一组（T9–T12）的原文与判据搬去了 `acceptance-cases-clarify.mjs` ——
   那边只管「该不该先问」这一类；这边管产物类。 */

/* `prepareSandbox` 也迁到 `acceptance-sandbox.mjs`（它属于「沙箱里放什么」那一半） */

/**
 * 任务集：每类一档能力，verify 只看**磁盘产物**（或本轮新会话的最后一条回答）。
 *
 * @param {object} ctx { sandbox: string, newestSession: () => string }
 */
export function buildCases(ctx) {
  const sandbox = ctx.sandbox
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  const f = (...parts) => join(sandbox, ...parts)
  /** 判据的「证据」：压掉空白、截断 —— 要能进报告，又要能一眼看出问题出在哪 */
  const snip = (s, n = 140) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n) || '（空）'

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
        const calc = read(f('calc.mjs'))
        const test = read(f('calc.test.mjs'))
        const ok = calc === CALC && test === CALC_TEST
        return {
          pass: ok,
          detail: ok ? '只读任务，两个文件都没被动' : '只读任务却改了文件',
          evidence: `calc.mjs 未变=${calc === CALC} · calc.test.mjs 未变=${test === CALC_TEST}`,
        }
      },
    },
    {
      id: 'T2-单文件修改',
      prompt:
        '工作目录里 calc.mjs 的 multiply 函数是错的（现在返回 a+b，应该是 a*b）。请把它改对，改完不要跑测试。',
      verify: () => {
        const src = read(f('calc.mjs'))
        const ok = FIXED.test(src)
        return { pass: ok, detail: ok ? 'multiply 已改成 a*b' : '没改对', evidence: `calc.mjs：${snip(src)}` }
      },
    },
    {
      id: 'T3-改完跑测试',
      prompt:
        'calc.mjs 的 multiply 是错的（返回 a+b，应为 a*b）。先改对，然后运行 node --test calc.test.mjs 验证，把测试结果告诉我。',
      verify: () => {
        const src = read(f('calc.mjs'))
        const ok = FIXED.test(src)
        return {
          pass: ok,
          detail: ok ? 'multiply 已改对（有没有真跑测试看台账）' : '没改对',
          evidence: `calc.mjs：${snip(src)}`,
        }
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
        return {
          pass: ok,
          detail: ok ? 'greet.mjs 已建且内容正确' : src ? '内容不对' : '文件没建',
          evidence: src ? `greet.mjs：${snip(src)}` : 'greet.mjs 不存在',
        }
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
          evidence: extra.length === 0 ? '沙箱里没有多余文件' : `多余文件：${extra.join(', ')}`,
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
          evidence: `math.mjs=${math ? `${math.length} 字节` : '无'} · calc 转发到 math=${/['"]\.\/math\.mjs['"]/.test(calc)} · test 指向 math=${/['"]\.\/math\.mjs['"]/.test(test)}`,
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
          evidence: out ? `读取结果.txt：${snip(out)}` : '读取结果.txt 不存在',
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
          evidence: `回答片段：${snip(answer, 80)} · 日志样本未变=${untouched}`,
        }
      },
    },

    /*
     * AG-053 / A2：**含糊需求与重操作那一组**（T9–T12）—— 判据在
     * `acceptance-cases-clarify.mjs`（那边只管「该不该先问」这一类）。
     * 这一组共同的考点：**开工前会不会先问一句**，而不是「必须弹卡」
     * （那是模型判断，不是硬闸 —— 硬闸会把正常任务也卡住）。
     */
    ...buildClarifyCases({ sandbox, read, f, snip }),
  ]
}
