/**
 * 项目测试失败的**规则诊断表**（2026-10-17 · 3B-1）
 *
 * 这里只有「什么样算哪类失败」和「怎么把它说成人话」，没有任何 I/O。
 * 拆出来的理由：`project-test-analyze.cjs` 要留着放数据构造与 diff 预览，
 * 两者都是纯数据，合成一个文件会贴 300 行红线。
 *
 * ── ★ 规则诊断 ≠ 模型推理 ────────────────────────────────────
 *
 * 本文件**一行模型调用都没有**。`confidence` 表达的是「这条关键词有多明确」，
 * 不是模型判断。所以对外只能说「规则诊断」，不能说「AI 已完成根因分析」。
 *
 * ⚠️ 不 require electron。
 */

const { STATUS } = require('./project-test-status.cjs')

/** 只有 FAIL 进常规代码修复分析 */
const FIXABLE = new Set([STATUS.FAIL])

/** 非 FAIL 的说明（**不许改标成 FAIL**） */
const GATE_NOTES = {
  [STATUS.PASS]: '测试已通过 —— 没有失败可分析，也不需要修复。',
  [STATUS.TIMEOUT]:
    '这次是**超时**，不是断言失败。先查耗时、死循环、外部依赖等待、资源不足；**不要**当成代码缺陷去改断言。',
  [STATUS.CANCELLED]: '用户或系统中途取消了这次执行，没有可分析的失败结果。',
  [STATUS.DENIED]:
    '权限 / 审批拒绝了这次执行。**不提供任何绕过权限的建议** —— 要跑请用户在设置里授权后重跑。',
  [STATUS.ERROR]:
    '执行器 / 配置出错。先分清是工具错误、配置错误还是项目代码错误，再谈修复；当前证据不足以给代码级建议。',
}

/**
 * 状态门控（**唯一判据**）。
 * @param {unknown} status 六态之一
 * @returns {{ fixable: boolean, status: string, known: boolean, note: string }}
 */
function gate(status) {
  const s = String(status ?? '')
  const known = Object.prototype.hasOwnProperty.call(GATE_NOTES, s)
  return {
    fixable: FIXABLE.has(s),
    status: s,
    known,
    note: known ? GATE_NOTES[s] : `不认识的状态「${s || '(空)'}」—— 不分析`,
  }
}

/** 输出里的「文件:行[:列]」—— 跨 node:test / vitest / jest / mocha / pytest 的常见写法 */
const FILE_REF = /(?:^|[\s("'`])([\w./\\@-]+\.(?:[cm]?[jt]sx?|py)):(\d+)(?::(\d+))?/g

/** 按错误类型给的**规则诊断**（每条都是推测，必须带 confidence） */
const ERROR_KINDS = [
  {
    re: /AssertionError|expected\s+.+\s+to\s+(?:be|equal|deeply|have|match)|Values not equal/is,
    label: '断言不符',
    confidence: 'high',
    advice: [
      '对照断言里的 expected / actual：哪一侧「对不上」，就在哪一侧找根因（被测代码 vs 期望值本身写错）。',
      '若是浮点 / 日期 / 序列化比较，先确认是否精度或时区问题。',
    ],
  },
  {
    re: /TypeError|is not a function|Cannot read propert|undefined is not/is,
    label: '类型 / 空值错误',
    confidence: 'medium',
    advice: [
      '定位报错那一行的取值来源：是入参没传、返回值是 undefined，还是异步没 await。',
      '先补一次「取不到时怎么办」的判空，再决定要不要改调用方。',
    ],
  },
  {
    re: /ENOENT|no such file or directory|cannot find module/is,
    label: '路径 / 模块找不到',
    confidence: 'high',
    advice: [
      '核对路径拼法与运行目录（cwd）：相对路径是相对项目根算的，不是相对测试文件。',
      '确认文件真的存在（大小写敏感、是否被 .gitignore 排除未提交）。',
    ],
  },
  {
    re: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed? ?out|Timeout of \d+ ?ms/is,
    label: '网络 / 超时',
    confidence: 'medium',
    advice: ['先确认这类测试是否依赖外部服务；能本地化就本地化，别把网络抖动当代码缺陷。'],
  },
  {
    re: /SyntaxError|Unexpected token|Unexpected end of/is,
    label: '语法错误',
    confidence: 'high',
    advice: ['多半是最近那次改动引入的：看报错文件与行号附近的括号 / 引号 / 逗号。'],
  },
]

/** 从输出里抽「文件:行」，去重保序，最多留 n 个 */
function pickFileRefs(text, n = 8) {
  const out = []
  const re = new RegExp(FILE_REF.source, 'g')
  const s = String(text ?? '')
  let m = re.exec(s)
  while (m !== null && out.length < n) {
    const rel = String(m[1]).replace(/\\/g, '/').replace(/^\.\//, '')
    const line = Number(m[2]) || 0
    if (rel && !out.some((x) => x.rel === rel && x.line === line)) out.push({ rel, line })
    if (re.lastIndex <= m.index) re.lastIndex = m.index + 1
    m = re.exec(s)
  }
  return out
}

/** 认错误类型（可能命中多条，全留） */
function pickKinds(text, n = 3) {
  const s = String(text ?? '')
  return ERROR_KINDS.filter((k) => k.re.test(s)).slice(0, n)
}

module.exports = { FIXABLE, GATE_NOTES, ERROR_KINDS, gate, pickFileRefs, pickKinds }
