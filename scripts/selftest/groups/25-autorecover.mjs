import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-016：自动恢复

   文档给了策略表：
     FileChanged → 重新读取 / Timeout → 有限 Retry / RateLimit → Backoff /
     ContextOverflow → Compact / ToolFailure → 分析后 Re-plan /
     ProcessExit → 检查退出码 / NetworkError → Retry / PermissionError → 请求确认
   并且写明「必须有最大 Retry 次数」。

   ★ 这一条最容易做错的地方是**把写操作也自动重试**：
     `run_shell` 超时后重试 = 把命令再跑一遍。那不是恢复，是重复副作用。
     所以核心守卫是「只有只读工具才自动重试」，而不是「只有可重试的错误才重试」。
   ══════════════════════════════════════════════════════════════ */

const errors = require(join(ROOT, 'electron/core/errors.cjs'))
const compact = require(join(ROOT, 'electron/core/compact.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('AG-016 · 自动恢复')

  /* ── 只读工具才能自动重试 ── */
  const netErr = errors.classify(new Error('fetch failed')) // strategy: retry
  const changedErr = errors.classify(new Error('文件不存在')) // strategy: reread
  check('网络错误 + 只读工具 → 可以自动重试', errors.canAutoRecover(netErr, 'read_file') === true)
  check('文件被改 + 只读工具 → 可以', errors.canAutoRecover(changedErr, 'list_dir') === true)

  check(
    '★ 网络错误 + run_shell → **不许**自动重试（重跑命令=重复副作用）',
    errors.canAutoRecover(netErr, 'run_shell') === false,
  )
  check(
    '★ 写文件也不自动重试',
    errors.canAutoRecover(netErr, 'write_file') === false &&
      errors.canAutoRecover(netErr, 'edit_file') === false,
  )
  check('生成图片也不自动重试', errors.canAutoRecover(netErr, 'generate_image') === false)

  /* ── 不该自动恢复的策略 ── */
  const authErr = errors.classify(new Error('401 Unauthorized')) // ask
  const overflow = errors.classify(new Error('context length exceeded')) // compact
  check(
    '需要用户出手的错误不自动重试（auth）',
    errors.canAutoRecover(authErr, 'read_file') === false,
  )
  check('上下文超限走的是压缩，不是重试', errors.canAutoRecover(overflow, 'read_file') === false)
  check(
    '工具失败交给模型 re-plan，不自动重试',
    errors.canAutoRecover(errors.classifyToolOutput('错误：参数不合法'), 'read_file') === false,
  )

  /* ── 最大次数 ── */
  check('★ 有最大自动重试次数（文档要求）', errors.MAX_AUTO_RETRY >= 1)
  check('而且不是无限（≤ 2 次）', errors.MAX_AUTO_RETRY <= 2)

  /* ── 上下文压缩后重建历史 ── */
  const history = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第一件事' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '第二件事' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '第三件事' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '第四件事' },
    { role: 'assistant', content: '好' },
  ]
  const rebuilt = compact.rebuild(history, '这里是摘要', 4)
  check('★ 压缩后系统提示还在', rebuilt[0]?.role === 'system')
  check('★ 摘要变成了第一条用户消息', String(rebuilt[1]?.content).includes('这里是摘要'))
  check('★ 最近的几条被留下（摘要会丢细节）', rebuilt.length === 2 + 4)
  check('留的是**最后**几条，不是最前面的', String(rebuilt.at(-1).content) === '好')

  /* ── 源码守卫 ── */
  const loopTools = readCore('electron/core/loop-tools.cjs')
  check('工具循环里有自动重试', loopTools.includes('errors.canAutoRecover'))
  check('重试受上限约束', loopTools.includes('errors.MAX_AUTO_RETRY'))
  check(
    '重试前发 agent.retrying（AG-002 定义的事件）',
    loopTools.includes("type: 'agent.retrying'"),
  )
  check('重试带退避', loopTools.includes('errors.backoffMs'))
  check('★ 成败判定只有一处（isToolOk）', (loopTools.match(/isToolOk\(/g) ?? []).length >= 3)

  const loopModel = readCore('electron/core/loop-model.cjs')
  check('★ 上下文超限会自动压缩一次再试', loopModel.includes('compactMessages('))
  check('★ 只压一次（压完还超说明是单条太长）', loopModel.includes('if (!compacted'))
  check(
    '压缩是**就地**替换 messages（否则 loop 看不到）',
    loopModel.includes('messages.length = 0'),
  )
  check('压缩失败不掩盖原来的错', loopModel.includes('自动压缩失败'))
}
