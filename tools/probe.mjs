/**
 * 临时验证脚本的骨架（探针）
 *
 * ── 为什么要有它 ──
 * `tools/acceptance-verdict.mjs` 那套（三态判据 + 证据必填 + 观测护栏）只服务**正式验收脚本**，
 * 而临时脚本（`tmp/*.cjs`、随手写的 `node -e`）**没有任何护栏**，它的结论却照样被当成事实
 * 写进报告。这个月 10+ 次假结论（判据恒 `undefined` 判成 ✅、采样点选错、按 `.json` 找 `.jsonl`、
 * 对照时没剥 markdown 记号…）**全部出自这一层**。
 *
 * 所以这里不重写判据，只做三件「不这么做就一定会再犯」的事：
 *   ① **证据为空 → 自动降级 `unknown`**：`undefined` / 空串 / 忘了传证据，都不会变成 ✅；
 *   ② **前置不成立就拒绝开跑**（`ready` + `requireReady`）：白跑一趟事小，拿假绿换 ✅ 事大；
 *   ③ **崩溃与漏 await 不再静默**：未捕获异常 / 未处理的 promise 都会让退出码非 0 ——
 *      「promise 忘了 await → 判据恒 undefined」就是这么骗过人的。
 *
 * 判据形状直接复用 `acceptance-verdict.mjs`（那里是**唯一**的真相源，别在这儿抄第二份）。
 *
 * ── 用法（临时脚本是 `.mjs`，因为 `tools/*.mjs` 是 ESM）──
 *
 *   import { probe } from '../tools/probe.mjs'
 *   const p = probe('核对「关于页」版本号')
 *   p.ready('安装版存在', existsSync(EXE), '先跑 npm run package')
 *   p.requireReady()                     // 不成立就直接退出 2，不产出任何结论
 *   p.check('版本是 1.21.0', text.includes('1.21.0'), `页面文本=${text.slice(0, 120)}`)
 *   p.check('能读到渲染层', p.unknown('页面没连上', 'cdp 超时 5s'))
 *   p.finish()                           // 汇总 + 退出码（fail / unknown 都非 0）；放在最后一行
 *
 * ── 上限 ──
 * 这个文件只做「记账 + 三态 + 前置」，**不碰浏览器、不碰应用**。要连 CDP 就用 `p.js(fn)`
 * 生成注入代码（见下），别在这个文件里加驱动 —— 它一胖，人就不用了。
 */

import { normalize, pass, fail, unknown } from './acceptance-verdict.mjs'

/**
 * 退出码：**有 fail 或 unknown 都不是 0**（沿用验收链的规矩，见 `acceptance-report.mjs`）。
 * 单独抽出来是为了让自测能断言同一条规则 —— 两边各写一份就一定会漂。
 */
export function exitCodeOf(rows) {
  return rows.some((r) => r.outcome !== 'pass') ? 1 : 0
}

/**
 * 把**真函数**序列化成一段可以交给别处执行的代码（CDP 的 `Runtime.evaluate`、`new Function`…）。
 *
 * 为什么不手写字符串：手写那段代码要过三层转义，真实踩过的三个坑全在这儿 ——
 *   · 模板串漏 `return` → 注入的代码返回 `undefined`，判据恒假/恒真都看不出来
 *   · 字符串里的 `\n` 变成真换行 → `SyntaxError: Invalid or unexpected token`
 *   · 注释里带反引号 → 提前截断模板串，后半段变成代码
 * 写成函数就没有这些问题：转义由 `JSON.stringify` 干，注释和换行都在函数体里。
 *
 * @param {Function} fn 要执行的函数（箭头函数最省事）
 * @param {...unknown} args 参数（按 JSON 序列化传进去）
 */
export function jsSource(fn, ...args) {
  const argv = args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ')
  return `(${fn.toString()})(${argv})`
}

/** 一次运行的记账本 */
function makeSink(title) {
  const rows = []
  const gates = []
  const faults = []
  let finished = false

  const row = (name, v) => {
    const n = normalize(v)
    /*
     * ★ 这栏是核心：没有证据的结论**不许**通过。
     * 真实案例：模板字符串漏了 `return`，判据恒 `undefined`，
     * 脚本报「全部 ✅」—— 而它其实什么都没看见。
     */
    const evidence = String(n.evidence ?? '').trim()
    if (n.outcome !== 'unknown' && !evidence) {
      rows.push({
        name,
        outcome: 'unknown',
        detail: `${n.detail}｜判据没交证据，按 unknown 算（不确定就别写 ✅）`,
        evidence: '',
      })
      return
    }
    rows.push({ name, outcome: n.outcome, detail: n.detail, evidence })
  }

  return {
    title,
    rows,
    gates,
    /**
     * 运行期「故障」：漏 await、未捕获异常、忘了 finish()。
     * ★ 必须记账而不是直接写退出码 —— 否则后面一句 `finish()` 会把退出码盖成 0（假绿）。
     */
    faults,
    /** 前置条件：不成立时**不跑、不判**（理由写清怎么补） */
    ready(name, ok, how = '') {
      gates.push({ name, ok: ok === true, how })
      return ok === true
    },
    /** 前置有任何一条不成立：打印补法并退出 2（退出码 2 专门表示「没跑」） */
    requireReady() {
      const bad = gates.filter((g) => !g.ok)
      if (bad.length === 0) {
        console.log(`✓ 前置成立（${gates.length} 条）`)
        return true
      }
      console.log('⛔ 前置不成立，拒绝开始（否则多半白跑，或者拿假绿换一个 ✅）：')
      for (const g of bad) console.log(`   · ${g.name}${g.how ? ` —— 补法：${g.how}` : ''}`)
      process.exit(2)
    },
    /**
     * 判一条。两种写法都认：
     *   `check('名字', 条件, '证据')` —— 最常见的
     *   `check('名字', p.unknown('观测不到', 'cdp 超时'))` —— 观测不到时别硬判
     */
    check(name, condition, evidence = '') {
      if (condition && typeof condition === 'object' && typeof condition.outcome === 'string') {
        row(name, condition)
        return
      }
      /*
       * ⚠️ 这里**不许**给 `evidence` 填默认值。
       * 第一版写的 `evidence || '条件成立'` —— 自测当场拓红：没交证据的判据被洗成了 pass，
       * 而那正是本文件要拦的东西。没写就是没写，交给 `row()` 降级。
       */
      row(name, condition === true ? pass('判据自己没写说明', evidence) : fail('不成立', evidence))
    },
    /**
     * 把真函数序列化后交给别处执行 —— 见 `jsSource`。
     * 手写字符串的三个坑（漏 return / `\n` 变真换行 / 注释里的反引号）这里都不存在。
     */
    js(fn, ...args) {
      return jsSource(fn, ...args)
    },
    pass,
    fail,
    unknown,
    /** 汇总并打印；返回退出码。脚本最后一行调它 */
    finish() {
      finished = true
      const count = { pass: 0, fail: 0, unknown: 0 }
      for (const r of rows) count[r.outcome] += 1
      const icon = { pass: '✅', fail: '❌', unknown: '⚠️' }
      console.log(`\n══ ${title} ══`)
      for (const r of rows) {
        console.log(`${icon[r.outcome]} ${r.name}`)
        if (r.detail) console.log(`     ${r.detail}`)
        if (r.evidence) console.log(`     证据：${r.evidence}`)
      }
      for (const f of faults) console.log(`❌ ${f}`)
      console.log(`\n通过 ${count.pass}｜不成立 ${count.fail}｜观测不到 ${count.unknown}｜故障 ${faults.length}`)
      if (count.unknown > 0) {
        console.log('⚠️ 「观测不到」既不算过也不算不过 —— 别把它当 ✅ 用，退出码仍非 0（沿用验收链的规矩）')
      }
      const code = faults.length > 0 ? 1 : exitCodeOf(rows)
      process.exitCode = code
      return code
    },
    isFinished: () => finished,
  }
}

/** 起一个探针（一个脚本一个就够） */
export function probe(title) {
  const sink = makeSink(title)
  /*
   * 两道兜底。都是真实踩过的：
   *   · `await` 漏了 → 判据在异步结果回来之前就算完了，恒 undefined（以前静默 → 假绿）
   *   · 中途抛异常被吞掉 → 脚本「跑完了」，但其实只跑了前三条
   */
  process.on('unhandledRejection', (e) => {
    sink.faults.push(`有 promise 没被处理（多半是漏了 await）：${e instanceof Error ? e.message : e}`)
  })
  process.on('beforeExit', () => {
    if (!sink.isFinished() && sink.rows.length > 0) {
      /* 光记账不够 —— 这里要真打出来，否则脚本一句话不说就退出了（自测拓到过） */
      console.log(`❌ 脚本没调 finish() —— ${sink.rows.length} 条判据没被汇总过（结论不完整）`)
      sink.faults.push('没调 finish()')
      process.exitCode = 1
    }
  })
  return sink
}

/**
 * 框架自测：拿**肯定的输入**喂它，断言它会红。
 *
 * 本项目老话：能通过不算测试，能失败才算。这里测的是「探针自己会不会交出假绿」，
 * 所以四条断言全部围绕**该红的时候必须红**。自检组 `112-probe` 直接调它（进 CI 链）。
 *
 * @returns {{ ok: boolean, 项: Array<{ 名称: string, 期望: string, 实际: string, ok: boolean }> }}
 */
export function selfTest() {
  const 项 = []
  /** 跑一条：期望的结局 vs 实际得到的结局 */
  const t = (名称, 期望, build) => {
    const sink = makeSink('selftest')
    build(sink)
    const 实际 = sink.rows[0]?.outcome ?? '（一条都没记上）'
    项.push({ 名称, 期望, 实际, ok: 实际 === 期望 })
  }

  /* ① 肯定的判据：必须 pass（不能把「会过的」判红） */
  t('肯定的判据', 'pass', (s) => s.check('真判据', 1 + 1 === 2, '1+1=2'))
  /* ② 否定的判据：必须 fail —— 判据能红，才算测试 */
  t('否定的判据', 'fail', (s) => s.check('假判据', 1 + 1 === 3, '1+1=2 ≠ 3'))
  /* ③ ★ 没交证据：必须是 unknown，**不是 pass**（这是本文件存在的理由） */
  t('没交证据的真判据', 'unknown', (s) => s.check('没证据的判据', true))
  /* ④ 恒 undefined（漏 return / 漏 await 的样子）：绝不能是 pass */
  t('恒 undefined 的判据', 'fail', (s) => s.check('恒 undefined 的判据', undefined, '模板串漏了 return'))
  /* ⑤ 观测不到的场合：原样是 unknown，不折算成 pass */
  t('观测不到的判据', 'unknown', (s) => s.check('观测不到', unknown('页面没连上', 'cdp 超时')))

  /* ⑥ 退出码：有 unknown 也非 0（不许拿它当 ✅）—— 断言的就是 finish 用的那份实现 */
  const rows = [
    { outcome: 'pass', name: 'a', detail: '', evidence: 'e' },
    { outcome: 'unknown', name: 'b', detail: '', evidence: 'e' },
  ]
  项.push({ 名称: '有 unknown 时退出码', 期望: '1', 实际: String(exitCodeOf(rows)), ok: exitCodeOf(rows) === 1 })

  return { ok: 项.every((i) => i.ok), 项 }
}
