/**
 * 错误分类：三张表（从 errors.cjs 拆出来的）
 *
 * `KINDS`（每类的处置）+ `MESSAGE_RULES`（消息特征）+ `STRATEGY_TEXT`（给模型看的一句话）
 * 三张表加起来占了原文件的一大半；判断逻辑留在 errors.cjs。
 *
 * 表格的说明（怎么分、顺序为什么有讲究）就在各自的注释里。
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

module.exports = { KINDS, MESSAGE_RULES, STRATEGY_TEXT }
