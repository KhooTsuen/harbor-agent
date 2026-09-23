/**
 * 错误分类
 *
 * 问题不是「出错了」，而是「出错了之后怎么办」。
 * 现在整个链路只有一个字符串错误，调用方只能选择「重试」或「放弃」——
 * 这两种都是错的：429 该退避重试，401 该让用户去改 Key，
 * 上下文超限该压缩，文件被改过该重新读一遍。
 *
 * 所以先把错误分成几类，每类给一个明确处置（AG-015）：
 *
 *   kind            retryable  strategy      needsUser
 *   network         网络不通     是  retry         否
 *   timeout         超时         是  retry         否
 *   rate_limit      限流         是  backoff       否
 *   server          5xx          是  retry         否
 *   auth            401/403      否  ask           **是**（要用户去改 Key）
 *   bad_request     400 参数     否  replan        否
 *   model_unsupported 模型不支持 否  switch_model  **是**
 *   context_overflow 上下文超限  否  compact       否
 *   file_changed    文件被改过   否  reread        否
 *   permission      权限不足     否  ask           **是**
 *   tool_failure    工具执行失败 否  replan        否
 *   process_exit    命令非零退出 否  inspect       否
 *   mcp             MCP 出错     是  retry         否
 *   aborted         用户中断     否  none          否
 *   unknown                      否  none          **是**
 *
 * `strategy` / `needsUser` 是 AG-015 加的：光知道「能不能重试」不够 ——
 * 界面要告诉用户「现在发生了什么、我打算怎么办、要不要你插手」。
 * 具体取值见下面 KINDS 的注释。
 */

/**
 * 每类的处置。
 *
 *   retryable —— 能不能自动重试（`shouldRetry` 用）
 *   strategy  —— 恢复策略，取值：
 *                  retry        直接重试
 *                  backoff      退避后重试（限流这类要等久一点）
 *                  reread       重新读取（文件被改过）
 *                  compact      压缩上下文
 *                  replan       分析后重新规划（AG-017）
 *                  inspect      检查退出码/输出（命令非零退出）
 *                  ask          需要用户出手（给 Key、给权限）
 *                  switch_model 换个模型
 *                  none         不处理
 *   needsUser —— 要不要用户介入。这一项决定界面是「自己重试」还是「告诉用户」
 *   hint      —— 给用户看的说明（不是给日志看的）
 */
const KINDS = {
  network: { retryable: true, strategy: 'retry', needsUser: false, hint: '网络请求失败' },
  timeout: { retryable: true, strategy: 'retry', needsUser: false, hint: '请求超时' },
  rate_limit: { retryable: true, strategy: 'backoff', needsUser: false, hint: '被限流了' },
  server: { retryable: true, strategy: 'retry', needsUser: false, hint: '对方服务器出错' },
  auth: { retryable: false, strategy: 'ask', needsUser: true, hint: '认证失败 —— 检查 API Key' },
  bad_request: { retryable: false, strategy: 'replan', needsUser: false, hint: '请求参数不被接受' },
  model_unsupported: {
    retryable: false,
    strategy: 'switch_model',
    needsUser: true,
    hint: '这个模型不支持该能力',
  },
  context_overflow: {
    retryable: false,
    strategy: 'compact',
    needsUser: false,
    hint: '上下文超出模型上限',
  },
  file_changed: {
    retryable: false,
    strategy: 'reread',
    needsUser: false,
    /* 只在「读完它之后被人改了」时走这条 —— 重读一遍是有意义的 */
    hint: '文件读完之后被改动了',
  },
  /* 从 file_changed 拆出来的：不存在 ≠ 被改过 —— 前者重试也没用，故 replan 而非 reread */
  file_missing: {
    retryable: false,
    strategy: 'replan',
    needsUser: false,
    hint: '文件不存在 —— 换个路径，或先看看目录里有什么，别重复读同一个',
  },
  permission: { retryable: false, strategy: 'ask', needsUser: true, hint: '权限不足' },
  /* AG-015 新增的三类 */
  tool_failure: {
    retryable: false,
    strategy: 'replan',
    needsUser: false,
    hint: '工具执行失败',
  },
  process_exit: {
    retryable: false,
    strategy: 'inspect',
    needsUser: false,
    hint: '命令非正常退出（看退出码和输出）',
  },
  mcp: { retryable: true, strategy: 'retry', needsUser: false, hint: 'MCP 服务出错' },
  aborted: { retryable: false, strategy: 'none', needsUser: false, hint: '被主动中断' },
  unknown: { retryable: false, strategy: 'none', needsUser: true, hint: '未知错误' },
}

/** 从 HTTP 状态码判断 */
function fromStatus(status) {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'bad_request'
  if (status === 408) return 'timeout'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (status >= 400) return 'bad_request'
  return 'unknown'
}

/** 从错误码判断（Node 的 syscall 错误） */
function fromCode(code) {
  const text = String(code ?? '').toUpperCase()
  if (
    ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH'].includes(text)
  ) {
    return 'network'
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(text)) return 'timeout'
  if (text === 'ABORT_ERR') return 'aborted'
  if (text === 'ENOENT') return 'file_missing' /* 没有这个文件，不是被改过 */
  if (text === 'EACCES' || text === 'EPERM') return 'permission'
  return null
}

/**
 * 从错误消息里认特征。
 *
 * 顺序有讲究：先具体后笼统。「model does not support image」既像
 * bad_request 又像 model_unsupported，让它先命中后者。
 */
const MESSAGE_RULES = [
  [/(aborted|abort(ed)? by user|用户(取消|中断))/, 'aborted'],
  [
    /(context length|context_length|maximum context|too many tokens|reduce the length)/i,
    'context_overflow',
  ],
  [
    /(does not support (image|vision)|unsupported (content|modality)|image.*not supported|multimodal)/i,
    'model_unsupported',
  ],
  [/(model.{0,20}(not found|不存在|invalid)|unknown model)/i, 'model_unsupported'],
  [/(rate limit|too many requests|429)/i, 'rate_limit'],
  [
    /(invalid api key|incorrect api key|unauthorized|authentication|api key.*(invalid|错误))/i,
    'auth',
  ],
  [/(timed? ?out|timeout)/i, 'timeout'],
  [/(socket hang up|fetch failed|network|econnreset|enotfound)/i, 'network'],
  [/文件不存在|不存在：|no such file|enoent/i, 'file_missing'], /* ★ 在前：更具体 */
  [/(old text|找不到这段原文|出现多次|file.{0,12}changed|文件.{0,6}(被改|已改|变了))/i, 'file_changed'],
  [/(permission denied|eacces|没有权限|需要授权)/i, 'permission'],
  /* AG-015 新增三类：先具体后笼统，所以放在最后几条 */
  [/(\bmcp\b|json-?rpc|MCP 服务器)/i, 'mcp'],
  [/(退出码|exit code|exited with|process exited)/i, 'process_exit'],
  [/工具.{0,6}(失败|出错|异常)/, 'tool_failure'],
]

/**
 * 分类一个错误。
 *
 * @param {unknown} error
 * @param {{ status?: number }} [extra]
 * @returns {{ kind: string, retryable: boolean, strategy: string, needsUser: boolean, hint: string, status: number, message: string }}
 */
function classify(error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const status = Number(extra.status ?? error?.status ?? error?.statusCode ?? 0)

  let kind = null

  if (error instanceof Error && error.name === 'AbortError') kind = 'aborted'
  if (!kind && status) kind = fromStatus(status)
  if (!kind && error?.code) kind = fromCode(error.code)
  if (!kind) {
    for (const [pattern, candidate] of MESSAGE_RULES) {
      if (pattern.test(message)) {
        kind = candidate
        break
      }
    }
  }
  if (!kind) kind = 'unknown'

  const meta = KINDS[kind] ?? KINDS.unknown
  return {
    kind,
    retryable: meta.retryable,
    strategy: meta.strategy,
    needsUser: meta.needsUser,
    hint: meta.hint,
    status,
    message: message.slice(0, 500),
  }
}

/**
 * 该不该重试。
 *
 * 两个额外的否决条件：
 *   · 用户已经中断 → 一律不重试（否则「停止」按钮会变成摆设）
 *   · 这一类不在允许重试的名单里 → 不重试
 */
function shouldRetry(info, attempt, options = {}) {
  const { attempts = 2, retryOn = ['timeout', 'rate_limit', 'server', 'network'] } = options
  if (attempt >= attempts) return false
  if (info.kind === 'aborted') return false
  if (!info.retryable) return false
  return retryOn.includes(info.kind)
}

/** 退避时长：限流等久一点，其它指数退避，最多 8 秒 */
function backoffMs(attempt, kind = 'unknown') {
  const base = kind === 'rate_limit' ? 2000 : 500
  const delay = base * 2 ** Math.max(0, attempt)
  return Math.min(delay, 8000)
}

/**
 * 恢复策略 → 给模型看的一句话（AG-015）。
 *
 * 文档的「失败体验标准」里写着应该出现这种句子：
 *
 *   Agent 判断：这是测试失败，不是执行环境错误。
 *   下一步：正在读取测试输出并定位失败原因…
 *
 * 那就是这里 —— 失败的工具结果后面接一句「这是什么错、你该怎么办」，
 * 模型就不至于在同一个坑里反复试。
 */
const STRATEGY_TEXT = {
  retry: '可以直接重试',
  backoff: '等一会儿再重试',
  reread: '重新读一次（文件可能已经变了）',
  compact: '上下文太长了，需要先压缩',
  replan: '分析原因后换个做法，不要重复同样的调用',
  inspect: '看退出码和输出，判断是命令自己失败还是环境问题',
  ask: '需要用户介入 —— 说清楚你需要什么',
  switch_model: '换个模型',
  none: '不必重试，如实报告',
}

/**
 * 从工具的输出文本分类。
 *
 * 工具失败时返回的是**字符串**（`错误：…`），不是 Error —— 所以不能直接
 * 丢给 `classify`，得先把文本包成 Error 走一遍规则。
 * 一条兜底：以「错误：」开头、但没有任何特征命中的，就是工具自己失败了。
 */
function classifyToolOutput(output, extra = {}) {
  const text = String(output ?? '')
  const info = classify(new Error(text), extra)
  if (info.kind === 'unknown' && /^错误：/.test(text.trim())) {
    return { ...info, ...KINDS.tool_failure, kind: 'tool_failure' }
  }
  return info
}

/**
 * 可以安全自动重试的工具（AG-016）。
 *
 * ★ 关键是**只读**：
 *   「文件被改过 → 重新读一遍」很安全；
 *   但 `run_shell` 超时后自动重试会把命令**再跑一遍** —— 那不是恢复，
 *   那是重复副作用（可能重启服务、重复提交、重复转账）。
 *   写操作一律不自动重试，交给模型判断（AG-015 已经给了它分类和建议）。
 */
const READONLY_TOOLS = new Set(['read_file', 'list_dir', 'search_web', 'browse', 'browse_elements'])

/** 值得自动重试的几种策略（其余的要么要用户、要么要模型动手） */
const AUTO_STRATEGIES = new Set(['reread', 'retry', 'backoff'])

/** 自动重试最多几次（文档：「必须有最大 Retry 次数」） */
const MAX_AUTO_RETRY = 1

/**
 * 这个错误 + 这个工具，能不能自动重试？
 *
 * @param {{ strategy?: string }} info  `classify` / `classifyToolOutput` 的结果
 * @param {string} toolName
 */
function canAutoRecover(info, toolName) {
  if (!AUTO_STRATEGIES.has(String(info?.strategy ?? ''))) return false
  return READONLY_TOOLS.has(String(toolName ?? ''))
}

module.exports = {
  KINDS,
  STRATEGY_TEXT,
  READONLY_TOOLS,
  MAX_AUTO_RETRY,
  classify,
  classifyToolOutput,
  canAutoRecover,
  shouldRetry,
  backoffMs,
  fromStatus,
  fromCode,
}
