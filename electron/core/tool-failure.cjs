/**
 * 工具失败事实（errorFeature）—— **跨工具 / 跨事件 / 跨落盘的唯一形状**
 *
 * 2026-11-02 之前，「这次调用失败了」在项目里有三个互不相认的说法：`tool-runner`
 * 按文本前缀判成败 · `errors.classifyToolOutput` 再从同一段文本猜分类 · 事件带
 * `errorKind`/`errorHint` 而前端类型里根本没声明它们。于是 `run_shell` 跑一条退出码 1
 * 的命令（`npm test` 挂了、`findstr` 没匹配到），文本里只有 `[退出码 1]`、没有
 * `错误：` 前缀 —— 界面上是**绿勾**。蓝图把这条列为阶段 A 的第一个验收项。
 *
 * ── 三条设计约束 ──
 *
 * 1. **缺失就写 `null`**。`exitCode: 0` 是「进程正常结束」，`null` 是「这次根本没有
 *    退出码」（超时 / 中断 / 文件不存在）—— 混了就会把「没跑完」说成「成功」。
 * 2. **不在这里判「该怎么办」**。重试 / 提示 / 中止仍归 `errors.cjs` 的 `strategy`。
 * 3. **形状只有这一处**。`src/types/chat-events.ts` 与 `src/lib/schemas.ts` 必须与
 *    `SHAPE_KEYS` 对齐（自检 `191` 钉着）；要加字段先改这里 —— 反过来做，zod 会把
 *    生产方多出来的那个字段**静静剥掉**，重开会话就没了。
 */

const { KINDS } = require('./error-kinds.cjs')
const errors = require('./errors.cjs')

/**
 * 原因码 / 分类映射 / 领域规则搬到了 `tool-failure-reason.cjs`（**唯一一份**）。
 *
 * 为什么拆：那个文件加 `systemCode` 的形状校验时贴了 300 行红线。拆的边界是职责 ——
 * 本文件管「失败事实长什么样、怎么组装」，那边管「这一次失败算哪一种」。
 * 这里仍**原样转出** `REASON` / `CATEGORY_OF` 等：调用方（自检、事件、界面）
 * 不用改 import，形状仍然只有一处。
 */
const {
  REASON,
  FROM_KIND,
  CATEGORY_OF,
  ABORTED_TEXT,
  DENIED_TEXT,
  domainOf,
  reasonOf,
} = require('./tool-failure-reason.cjs')

/** 形状版本 —— 改字段就 +1，读的人按版本判断能不能认 */
const SCHEMA_VERSION = 1

/**
 * 工具返回算不算成功 —— **全项目只有这一处判定**（两份执行器都调它）。
 *
 * ★ 两种输入形态：
 *   · **字符串**（老契约，绝大多数工具）：看开头是不是拒绝/错误文案
 *   · **结构化 `{ text, toolOk }`**：`toolOk` 说了算，但**拒绝文案永远优先**
 *     （fail-closed：工具不能靠自己声明 true 把一个拒绝说成成功）
 *
 * 为什么需要结构化（3B-1 / B12）：项目测试「跑了但断言挂了」的正文完全正常，
 * 只看前缀会判成功 —— 活动记录里 FAIL 显示成绿勾。测试的状态与「这次调用
 * 成不成功」是两个概念，只能由工具自己结构化回报，不能靠文本前缀伪装。
 *
 * ⚠️ 这里**不看退出码**：`run_shell` 已经自己把 `toolOk` 按退出码算好了
 * （见那个文件里的 `finish({ toolOk: !error })`），否则这里就变成了
 * 「同一件事两处判」—— 退出码属于工具的事实，成败属于工具的结论。
 */
function isToolOk(output) {
  const text = String(output !== null && typeof output === 'object' ? output.text : (output ?? ''))
  if (text.startsWith('错误：') || text.startsWith('用户拒绝了')) return false
  if (output !== null && typeof output === 'object' && typeof output.toolOk === 'boolean') {
    return output.toolOk
  }
  return true
}

/** 工具返回 → 正文文本（结构化 `{ text, … }` 取 text；字符串原样） */
function outTextOf(output) {
  return String(output !== null && typeof output === 'object' ? (output.text ?? '') : (output ?? ''))
}

/**
 * 系统错误码的白名单式校验（`ENOENT` / `EACCES` / `EPERM` / `ENOTDIR`…）。
 *
 * 为什么不在这一步放开：`factsOf` 是「工具报上来的原始事实」进事件与磁盘的唯一一道口，
 * 什么字符串都放行等于让内部结构漏到前台。系统码的形状很固定（全大写字母 + 下划线，
 * ≤ 40 字），别的一律当没有 —— `systemCode` 是**加分项**，拿不到就留 null，
 * 不能因为拿不到就把整条失败事实判死。
 */
function systemCodeOf(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  return /^[A-Z][A-Z0-9_]{1,39}$/.test(raw) ? raw : null
}

/**
 * 组装一条失败事实。
 *
 * @param {{ toolName?: string, ok?: boolean, exitCode?: number|null,
 *           systemCode?: string|null,
 *           timedOut?: boolean, aborted?: boolean, denied?: boolean,
 *           kind?: string|null, hint?: string|null, output?: string }} input
 * @returns {null | {
 *   schemaVersion: number, reasonCode: string, exitCode: number|null,
 *   systemCode: string|null, kind: string, hint: string, category: string,
 *   domain: string, retryable: boolean, needsUser: boolean
 * }}  成功（ok !== false）时返回 `null` —— 没有失败就没有失败事实
 */
function of(input) {
  const data = input ?? {}
  if (data.ok !== false) return null

  const output = String(data.output ?? '')
  const exitCode = Number.isInteger(data.exitCode) ? data.exitCode : null
  /*
   * `kind` 没给就自己分一次类（规则仍归 `errors.cjs`，这里不另起一套）。
   * 不能默认成 `'unknown'`：`of()` 能被单独调用（回溯老台账、自检手搓事实），
   * 少传一个参数就静默降级成「未知错误 / 需要你处理」—— 而「文件不存在」
   * 其实换条路径就行，不该把用户叫过来。生产路径 `outcomeOf` 一直带着 kind。
   */
  const kind =
    String(data.kind ?? '').trim() ||
    errors.classifyToolOutput(output, { name: data.toolName }).kind
  const meta = KINDS[kind] ?? KINDS.unknown
  const reasonCode = reasonOf({
    timedOut: data.timedOut,
    aborted: data.aborted,
    denied: data.denied,
    exitCode,
    kind,
    output,
  })

  return {
    schemaVersion: SCHEMA_VERSION,
    reasonCode,
    /* ★ 0 与 null 是两件事，见文件头第 1 条 */
    exitCode,
    /*
     * 系统错误码（ENOENT / EACCES…）：**进程根本没起来**时那一类。
     * 与 `exitCode` 是两件事（那边只放数字退出码），也**不能拿它冒充退出码**
     * （理由见文件头第 1 条）。值只认短的大写系统码，别的一律落 null ——
     * 工具传什么都往库里塞等于让内部结构漏进事件与磁盘。
     */
    systemCode: systemCodeOf(data.systemCode),
    kind,
    hint: String(data.hint ?? meta.hint ?? ''),
    category: CATEGORY_OF[reasonCode] ?? 'tool_failure',
    domain: domainOf(data.toolName),
    retryable: meta.retryable === true,
    needsUser: meta.needsUser === true,
  }
}

/**
 * 从工具返回里取出**原始事实**，只搬这几个键。
 *
 * 为什么要有这一步：`tools/index.cjs` 是所有工具调用的唯一咽喉，它不该知道
 * 「退出码意味着失败」这种业务判断，但它必须把工具报上来的原始数字搬给上层。
 * 白名单而不是整体 spread —— 工具的返回里可能有各种中间字段，全传下去等于
 * 让内部结构漏进事件和磁盘。
 */
function factsOf(output) {
  if (output === null || typeof output !== 'object') return {}
  const facts = {}
  if (Number.isInteger(output.exitCode)) facts.exitCode = output.exitCode
  if (output.timedOut === true) facts.timedOut = true
  if (output.aborted === true) facts.aborted = true
  /* 字符串系统码（ENOENT…）与数字退出码是两件事，各走各的键 —— 见 `systemCodeOf` */
  if (typeof output.systemCode === 'string' && output.systemCode) facts.systemCode = output.systemCode
  return facts
}

/**
 * 一次调用的**结论**：成不成功 + 失败事实（成功时 `error` 为 `null`）。
 *
 * 为什么把「分类」也放在这里：`tool-runner.cjs` 与 `loop-tools.cjs` 的串行回退
 * 实现都要发同一形状的事件。以前两份各写一遍 `...(info ? {errorKind…} : {})`，
 * 串行那份还**少了** `ok` 之外的字段 —— 两边各写一套正是硬约束 9 要治的病。
 * 现在两份都调这一个函数，形状只有一处定义。
 *
 * @param {{ toolName: string, ok: boolean, text: string, facts?: object }} input
 * @returns {{ info: object|null, error: object|null }}
 */
function outcomeOf({ toolName, ok, text, facts }) {
  if (ok) return { info: null, error: null }
  const info = errors.classifyToolOutput(text, { name: toolName })
  const error = of({
    toolName,
    ok: false,
    output: text,
    kind: info.kind,
    hint: info.hint,
    ...(facts ?? {}),
  })
  return { info, error }
}

/** 形状的键（自检拿它跟前端声明逐字比对） */
const SHAPE_KEYS = [  'schemaVersion',
  'reasonCode',
  'exitCode',
  'systemCode',
  'kind',
  'hint',
  'category',
  'domain',
  'retryable',
  'needsUser',
]

module.exports = {
  SCHEMA_VERSION,
  REASON,
  FROM_KIND,
  CATEGORY_OF,
  SHAPE_KEYS,
  isToolOk,
  outTextOf,
  of,
  outcomeOf,
  domainOf,
  factsOf,
  systemCodeOf,
}
