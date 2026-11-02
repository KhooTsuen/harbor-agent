/**
 * 「这次失败算哪一种」—— 原因码 / 分类映射 / 领域规则（**唯一一份**）
 *
 * 从 `tool-failure.cjs` 拆出来的（那个文件贴 300 行红线，加 `systemCode` 校验时超了）。
 * 拆的边界是职责，不是行数：
 *   · 本文件回答「这一次失败**是什么原因**」——纯查表 + 优先级，不认识任何形状；
 *   · `tool-failure.cjs` 回答「失败事实**长什么样、怎么组装**」——这才需要跟
 *     前端类型和 zod 对齐。
 *
 * ★ 别在别处再写一套 `text.includes('退出码')`：原因码是界面 / 台账 / 磁盘 / 模型
 *   看到的同一套字符串。
 */

/**
 * 失败原因码。
 *
 * ★ 这是**界面 / 台账 / 磁盘 / 模型**看到的同一套字符串，别在别处另起一套
 *   （比如界面里自己写 `if (text.includes('退出码'))` —— 那正是这次要根治的写法）。
 */
const REASON = {
  /** 进程起来了但非零退出 —— `exitCode` 一定有值 */
  EXIT_CODE: 'EXIT_CODE',
  /** 超过时限被杀掉 —— 没有退出码（进程树被强杀） */
  TIMEOUT: 'TIMEOUT',
  /** 用户点了停止 */
  ABORTED: 'ABORTED',
  /** 用户拒绝了这个操作，或策略层拦下 */
  DENIED: 'DENIED',
  /** 目标文件 / 目录不存在 */
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** 权限不足 */
  PERMISSION: 'PERMISSION',
  /** 网络不通 */
  NETWORK: 'NETWORK',
  /** 断言 / 用例挂了（跑了，但结果不对） */
  ASSERTION_FAILED: 'ASSERTION_FAILED',
  /** 工具自己报了错（`错误：…`），但认不出更细的原因 */
  TOOL_ERROR: 'TOOL_ERROR',
  /** 兜底 —— 认不出来就是认不出来，不猜 */
  UNKNOWN: 'UNKNOWN',
}

/**
 * `errors.cjs` 的分类 → 原因码。两张表必须对得上：`errors.KINDS` 里新增一类而这里
 * 没跟上，走的是 `UNKNOWN`（宁可说「不知道」也不要说错）。自检里钉着「KINDS 的每个
 * 键都在这张表里或有明确的兜底」。
 */
const FROM_KIND = {
  process_exit: REASON.EXIT_CODE,
  timeout: REASON.TIMEOUT,
  aborted: REASON.ABORTED,
  permission: REASON.PERMISSION,
  network: REASON.NETWORK,
  file_missing: REASON.FILE_NOT_FOUND,
  file_changed: REASON.FILE_NOT_FOUND,
  tool_failure: REASON.TOOL_ERROR,
  auth: REASON.PERMISSION,
  bad_request: REASON.TOOL_ERROR,
  rate_limit: REASON.NETWORK,
  server: REASON.NETWORK,
  mcp: REASON.TOOL_ERROR,
  model_unsupported: REASON.TOOL_ERROR,
  context_overflow: REASON.TOOL_ERROR,
}

/**
 * 原因码 → `category`（蓝图 §4 的索引字段）。分类是**索引**，不能假装解释了
 * 原因 —— 所以这里只是给检索用的粗标签。
 */
const CATEGORY_OF = {
  EXIT_CODE: 'tool_failure',
  TIMEOUT: 'tool_failure',
  ABORTED: 'tool_failure',
  DENIED: 'tool_failure',
  FILE_NOT_FOUND: 'tool_failure',
  PERMISSION: 'tool_failure',
  NETWORK: 'external_blocked',
  ASSERTION_FAILED: 'assertion_failed',
  TOOL_ERROR: 'tool_failure',
  UNKNOWN: 'tool_failure',
}

/**
 * 工具 → `domain`（蓝图 §4：`code/web/file/research/daily/other`）。
 *
 * 为什么按工具名而不是按参数猜：领域是「这次操作碰的是什么」，工具自己最清楚；
 * 拿命令文本去正则猜「这是不是代码工作」只会猜错（`run_shell python x.py` 可能是
 * 数据处理也可能是跑测试）。
 *
 * @type {Array<[RegExp, string]>}  ★ 元组标注不能省：不写就被推成
 *   `(string|RegExp)[]`，解构出来的 `pattern.test` 会报「string 上没有 test」。
 */
const DOMAIN_RULES = [
  [/^run_shell$|^run_project_test$|^apply_test_fix$|^analyze_test_failure$|^restore_test_fix$/, 'code'],
  [/^browse|^edge_/, 'web'],
  [/^search_web$/, 'research'],
  [/^(read_file|write_file|edit_file|list_dir|download|read_image)$/, 'file'],
]

/** 文本标记：这两条是 `run_shell.cjs` 里写死的字面量（改那边要同步改这里） */
const ABORTED_TEXT = /已被用户中断|用户已停止/
const DENIED_TEXT = /^用户拒绝/

function domainOf(toolName) {
  const name = String(toolName ?? '')
  for (const [pattern, domain] of DOMAIN_RULES) {
    if (pattern.test(name)) return domain
  }
  return 'other'
}

/**
 * 定原因码。**顺序就是优先级**，别重排：
 *
 *   超时 → 中断 → 拒绝 → 退出码 → 分类 → 兜底
 *
 * 为什么退出码排在分类之前：一个非零退出的命令，文本里**必定**带 `[退出码 N]`，
 * 而 `errors.cjs` 的 `MESSAGE_RULES` 也可能从同一段文本里命中别的特征（命令输出
 * 里恰好有 "timeout" 这个词）。退出码是**硬事实**，分类是**猜**，事实优先。
 */
function reasonOf({ timedOut, aborted, denied, exitCode, kind, output }) {
  if (timedOut === true) return REASON.TIMEOUT
  if (aborted === true || ABORTED_TEXT.test(output)) return REASON.ABORTED
  if (denied === true || DENIED_TEXT.test(output)) return REASON.DENIED
  if (Number.isInteger(exitCode) && exitCode !== 0) return REASON.EXIT_CODE
  const mapped = FROM_KIND[String(kind ?? '')]
  /*
   * 分类说「非零退出」但没有退出码（命令根本没起来，比如 `npm` 不在 PATH 上，
   * `error.code` 是字符串 'ENOENT' 而不是数字）—— 这时不能说 EXIT_CODE，
   * 那是把「没跑起来」说成「跑了但失败」，会让人去翻一段根本不存在的输出。
   */
  if (mapped === REASON.EXIT_CODE) return REASON.TOOL_ERROR
  if (mapped) return mapped
  return REASON.UNKNOWN
}

module.exports = {
  REASON,
  FROM_KIND,
  CATEGORY_OF,
  DOMAIN_RULES,
  ABORTED_TEXT,
  DENIED_TEXT,
  domainOf,
  reasonOf,
}
