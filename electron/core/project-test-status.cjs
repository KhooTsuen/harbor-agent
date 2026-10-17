/**
 * 项目测试的**结果状态分类**（2026-10-17 · 3A）
 *
 * ── 为什么单列一个文件 ────────────────────────────────────────
 *
 * 用户 A5 要求把 PASS / FAIL / TIMEOUT / CANCELLED / DENIED / ERROR 六种**分开**。
 * 这是一组纯字符串判据，跟配置、跟 MCP 桥都没关系 —— 单独放能把
 * 「状态到底怎么定」这一处代码交给自检直接喂字符串跑，不必起整个桥。
 *
 * ── ★ 为什么不能直接用 `isToolFailure` ────────────────────────
 *
 * Harbor 的 `run_shell` 只要**进程起来了**就算工具成功：输出末尾附一行
 * `[退出码 N]`，但**不以「错误：」开头**。所以：
 *
 *   · 测试跑了、断言挂了（退出码 1）→ 工具层 `ok:true`，但对用户是**失败**
 *   · 超时被 kill → 输出是 `[进程被超时杀掉（60s）：…]`，**没有**退出码
 *   · 用户点了停止 → 输出是 `[已被用户中断，…]`，也**没有**退出码
 *
 * 三种都判不出「谁是谁」。这里按 `run_shell` 实际会吐出的**原文标记**逐条认。
 * ⚠️ 这些标记是 `run_shell.cjs` 里写死的字面量（`[退出码 N]` /
 *    `[进程被超时杀掉` / `[已被用户中断`）—— 那边改字，这里必须同步
 *    （`34-outcome` 自检里也钉着同一组标记）。
 *
 * ⚠️ 不 require electron。
 */

/**
 * 六种状态。
 * - `PASS` 退出码 0
 * - `FAIL` 退出码非 0（测试真的跑了，是测试挂了）
 * - `TIMEOUT` 超过时限，进程已被杀
 * - `CANCELLED` 用户主动中断
 * - `DENIED` 用户拒绝了这次执行（审批没通过）
 * - `ERROR` 没跑起来 / 执行器异常 / 读不到结果
 */
const STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  DENIED: 'DENIED',
  ERROR: 'ERROR',
}

/** 每行摘要最长多少字（失败摘要只给人看个大概，不是完整输出） */
const SUMMARY_LINE_MAX = 200
/** 失败摘要最多留几行 */
const SUMMARY_LINES_MAX = 8

/** 失败线索的关键词（跨 node:test / vitest / jest / pytest 几家的常见写法） */
const FAIL_HINT = /(✖|×|✗|FAIL|fail|Error|error|AssertionError|not ok|expected|actual)/

/**
 * 从 `run_shell` 的输出里认状态。
 *
 * 判据顺序**不能换**：用户拒绝 / 执行前拒绝 / 超时 / 中断这四种都**不带**退出码，
 * 先认它们，再认退出码。
 *
 * @param {unknown} text `run_shell` 的返回原文
 * @returns {{ status: string, exitCode: number|null, reason: string }}
 */
function classifyRun(text) {
  const s = String(text ?? '')
  if (!s.trim()) {
    return { status: STATUS.ERROR, exitCode: null, reason: '没有拿到任何输出（命令可能没跑起来）' }
  }
  /* ① 审批没通过（tools/index.cjs 的拒绝文案） */
  if (/用户拒绝了这个操作/.test(s)) {
    return { status: STATUS.DENIED, exitCode: null, reason: '用户拒绝了这次测试执行' }
  }
  /* ② Harbor 在执行前就拒了（危险命令 / 网络策略 / 权限档 / 参数不合法） */
  if (/(^|\n)错误：/.test(s)) {
    return { status: STATUS.ERROR, exitCode: null, reason: 'Harbor 在执行前拒绝了这条命令' }
  }
  /* ③ 超时（run_shell 的固定标记，注意它**不带退出码**） */
  if (/\[进程被超时杀掉/.test(s)) {
    return { status: STATUS.TIMEOUT, exitCode: null, reason: '执行超时，进程已被终止' }
  }
  /* ④ 用户中断（同上，也不带退出码） */
  if (/\[已被用户中断/.test(s)) {
    return { status: STATUS.CANCELLED, exitCode: null, reason: '用户中断了这次执行' }
  }
  /* ⑤ 真的跑完了 —— 看退出码 */
  const m = /\[退出码 (\d+)\]/.exec(s)
  if (!m) {
    return { status: STATUS.ERROR, exitCode: null, reason: '读不到退出码（执行器可能异常退出）' }
  }
  const exitCode = Number(m[1])
  if (exitCode === 0) return { status: STATUS.PASS, exitCode, reason: '' }
  return { status: STATUS.FAIL, exitCode, reason: `测试失败（退出码 ${exitCode}）` }
}

/**
 * 抽一段「失败摘要」给人和模型看（完整输出可能几千行）。
 *
 * 只挑含失败线索的行；一行都没有就返回空串（**不编造摘要**）。
 *
 * @param {unknown} text
 * @returns {string[]}
 */
function summarizeFailure(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && FAIL_HINT.test(line))
  const out = []
  for (const line of lines) {
    if (out.length >= SUMMARY_LINES_MAX) break
    /* 去掉标记行的干扰（`[退出码 1]` 这种自己会说，不必进摘要） */
    if (/^\[(退出码|进程被超时杀掉|已被用户中断)/.test(line)) continue
    out.push(line.trim().slice(0, SUMMARY_LINE_MAX))
  }
  return out
}

module.exports = { STATUS, FAIL_HINT, classifyRun, summarizeFailure }
