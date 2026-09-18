import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-015：错误分类

   文档列了 11 类，并要求每类定义四件事：
     用户可理解的说明 / 是否自动恢复 / 恢复策略 / 是否需要用户介入

   改造前只有前两项（`hint` + `retryable`）—— 光知道「能不能重试」不够：
   界面要能回答「现在发生了什么、我打算怎么办、要不要你插手」。
   而且缺三类：ToolFailure / ProcessExit / MCPError。

   ★ 分类只有被用起来才算数。所以还钉一条：失败的工具结果后面
     必须接一句「这是什么错、建议怎么办」—— 不然模型只会原样重试，
     同一个坑里反复掉（那正是 AG-017 要治的）。
   ══════════════════════════════════════════════════════════════ */

const errors = require(join(ROOT, 'electron/core/errors.cjs'))

export async function run() {
  group('AG-015 · 错误分类')

  /* ── 文档点名的那些类都得有 ── */
  const DOC = [
    'network',
    'auth',
    'timeout',
    'rate_limit',
    'permission',
    'file_changed',
    'tool_failure',
    'context_overflow',
    'process_exit',
    'mcp',
    'unknown',
  ]
  for (const kind of DOC) check(`有「${kind}」这一类`, Boolean(errors.KINDS[kind]))

  /* ── 每类的四项齐全 ── */
  const missing = []
  for (const [kind, meta] of Object.entries(errors.KINDS)) {
    if (typeof meta.retryable !== 'boolean') missing.push(`${kind}:retryable`)
    if (!meta.strategy) missing.push(`${kind}:strategy`)
    if (typeof meta.needsUser !== 'boolean') missing.push(`${kind}:needsUser`)
    if (!meta.hint) missing.push(`${kind}:hint`)
  }
  check('★ 每类都齐了：说明 / 可重试 / 恢复策略 / 是否需用户介入', missing.length === 0)

  const strategies = new Set(Object.values(errors.KINDS).map((meta) => meta.strategy))
  const noText = [...strategies].filter((name) => !errors.STRATEGY_TEXT[name])
  check('★ 每个恢复策略都有「给模型看的一句话」', noText.length === 0)

  /* ── 三类新的认得出 ── */
  check('认得出 MCP 错误', errors.classify(new Error('MCP 服务器「fs」不在运行')).kind === 'mcp')
  check('认得出进程退出', errors.classify(new Error('命令退出码 1')).kind === 'process_exit')
  check(
    '认得出工具失败（「错误：」开头且没别的特征 → 就是工具自己失败）',
    errors.classifyToolOutput('错误：参数不合法，请按 schema 重来').kind === 'tool_failure',
  )

  /* ── 老的分类没被改坏 ── */
  check('401 还是 auth', errors.classify(new Error('401 Unauthorized')).kind === 'auth')
  check('网络错误可重试', errors.classify(new Error('fetch failed')).retryable === true)
  check('认证失败不可重试', errors.classify(new Error('401')).retryable === false)
  check(
    '限流的策略是退避',
    errors.classify(new Error('429 too many requests')).strategy === 'backoff',
  )
  check('限流可重试', errors.classify(new Error('429')).retryable === true)
  check('用户中断不重试', errors.classify(new Error('aborted by user')).retryable === false)

  /* ── 需要用户介入的几类 ── */
  check('认证失败要用户介入', errors.classify(new Error('401')).needsUser === true)
  check('权限不足要用户介入', errors.classify(new Error('permission denied')).needsUser === true)
  check(
    '上下文超限不用用户管（自动压缩）',
    errors.classify(new Error('context length exceeded')).needsUser === false,
  )

  /* ── 分类结果带上了 strategy / needsUser ── */
  const info = errors.classify(new Error('ETIMEDOUT'))
  check('classify 返回 strategy', typeof info.strategy === 'string')
  check('classify 返回 needsUser', typeof info.needsUser === 'boolean')

  /* ── 真的用起来了 ── */
  const loopTools = readFileSync(join(ROOT, 'electron/core/loop-tools.cjs'), 'utf8')
  check('★ 工具失败时会分类', loopTools.includes('errors.classifyToolOutput'))
  check('★ 分类和「建议」真的喂给了模型', loopTools.includes('[错误分类]'))
  check('失败事件带上了分类（界面可用）', loopTools.includes('errorKind'))
  check(
    '★ 只在失败时附加（成功的那条不该多一句废话）',
    loopTools.includes('content: info\n        ?'),
  )
}
