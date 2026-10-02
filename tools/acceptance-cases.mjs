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

/* 夹具（CALC / CALC_TEST / FIXED / GUIDE_MD / LOG_SAMPLE / MINE / prepareSandbox）
   都在 `acceptance-sandbox.mjs` —— 那边只管「沙箱里放什么」。 */

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
          evidence: `两个导出还在=${keepsExports} · 测试未改=${testUntouched} · calc.mjs 有变动=${calc !== CALC}`,
        }
      },
    },
    {
      id: 'T10-含糊-不可逆',
      prompt: CLARIFY_PROMPTS.irreversible,
      vague: true,
      /*
       * 判据（2026-10-02 按用户拍板改）：**只考「有没有主动问」+「问法有没有说清风险」**。
       *
       * 为什么不看「跳过之后改没改」：这个用例的意图是测「识别到不可逆操作会先问」；
       * 模型问了、说清了风险 —— 就是正确行为。而自动化里「用户」点的就是跳过
       * （= 你自己看着办），模型据此选择**不碰用户的文档**同样是正确取向；
       * 拿它当失败，等于惩罚「模型尊重了用户意图」。
       *
       * 卡片原文由驱动采到后传进来（见 `acceptance.mjs` 的 `cardTexts`）。
       */
      verify: ({ clarifyText = '', askedInLedger = false } = {}) => {
        if (!clarifyText) {
          /* 台账里问了、但驱动没采到卡片文本 → **观测不到**，不当作「没问」（批④ 假红的近亲） */
          return askedInLedger
            ? unknown('台账里有 ask_user，但驱动没采到卡片文本（观测不到，不判）', 'askedInLedger=true · clarifyText 空')
            : fail('没主动问（不可逆操作应该先问）', '台账里没有 ask_user，也没采到澄清卡')
        }
        /*
         * 「说清风险」的判定口径 **2026-10-02 校准过一次**：
         *   第一版按我自己列的风险词判（覆盖/丢失/删/不可逆/备份…），结果把
         *   「说明.md 行数会从 6 行变成 20 行左右」「新增 1 个约 30 字节的 txt，删掉即完全还原」
         *   这种**带具体数字的后果说明**判成了「没说清风险」（1/3）——
         *   那是判据太窄（词表 ≠ 说清），不是模型没说。
         *   现在对齐项目本来就在规则里写着的标准：**选项要写「因为 X」，X 是具体数字或事实**
         *   （见 `prompt-stack.cjs` 的 CLARIFY_RULE）。有风险词当然也算。
         */
        const hasBecause = /因为/.test(clarifyText)
        const concrete =
          /\d/.test(clarifyText) || /风险|不可逆|无法恢复|恢复不了|备份|覆盖|丢失/.test(clarifyText)
        const detail = hasBecause && concrete
          ? '主动问了，且每个选项都写了具体后果'
          : hasBecause
            ? '问了，但选项里没有具体数字/事实（用户没法判断代价）'
            : '问了，但选项没写「因为 X」（用户看不到代价）'
        const how = `卡原文：${snip(clarifyText, 160)}`
        return hasBecause && concrete ? pass(detail, how) : fail(detail, how)
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
          evidence: `calc.test.mjs 有变动=${test !== CALC_TEST} · 里含 test(=${/test\s*\(/.test(test)}`,
        }
      },
    },
  ]
}
