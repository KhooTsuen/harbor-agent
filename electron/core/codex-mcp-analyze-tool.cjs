/**
 * `harbor_analyze_test_failure` 的 **MCP 工具定义 + 参数净化**（2026-10-17 · 3B-1）
 *
 * 拆出来的理由：`codex-mcp-tools.cjs` 已经贴 300 行红线（加完定义 + 净化会到 359）。
 * 照 `config-codex-mcp.cjs` 的老范式：**形状与净化同住一个文件**，
 * 主文件只 require 两行拼进去 —— 既腾行，也保证「形状只有一处定义」（硬约束 9）。
 *
 * ── ★ 它为什么是只读的 ────────────────────────────────────────
 *
 * 它能做的事只有：按 id 读**已有**执行记录、按相对路径读源码片段、算 diff 预览。
 * 没有 command、没有 shell、不写盘、不重跑测试。所以 `readOnlyHint: true` 是
 * **诚实的描述**（不是安全控制；真正的闸门在 Harbor 侧的路径校验与审批）。
 *
 * ⚠️ 不 require electron。
 */

/** 上限（防外部拿超长字段撑爆内存） */
const MAX_ID = 80
const MAX_TEST_ID = 40
const MAX_FILES = 6
const MAX_PATH = 400
const MAX_TEXT = 40_000
const MAX_PROPOSALS = 4

const TOOL = {
  name: 'harbor_analyze_test_failure',
  description:
    '分析**已经执行过**的项目测试失败结果：已确认事实 / 规则诊断推测 / 未知项分开给，' +
    '并列出建议检查的文件与修复建议；证据足够时附 unified diff 预览（**仅预览，不写盘**）。' +
    '不重新执行测试。只能给 executionId 或 testId —— 状态以执行记录为准。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      executionId: { type: 'string', description: '要分析的那次执行 id' },
      testId: { type: 'string', description: '不给 executionId 时，分析该条目最近一次执行' },
      files: { type: 'array', items: { type: 'string' }, description: '要读的相对路径（越界一律拒）' },
      proposals: { type: 'array', items: { type: 'object' }, description: '拟议修改（仅算 diff 预览，不写盘）' },
    },
    additionalProperties: false,
  },
}

/** 去掉多余键、夹住长度（**不判路径安全** —— 那是取证层的事） */
function clean(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const out = {}
  const executionId = typeof a.executionId === 'string' ? a.executionId.trim() : ''
  const testId = typeof a.testId === 'string' ? a.testId.trim() : ''
  if (executionId) out.executionId = executionId.slice(0, MAX_ID)
  if (testId) out.testId = testId.slice(0, MAX_TEST_ID)
  if (!out.executionId && !out.testId) {
    return { ok: false, message: 'executionId 或 testId 至少要给一个（不能自己声明一个未执行过的失败）' }
  }
  if (Array.isArray(a.files)) {
    out.files = a.files
      .filter((x) => typeof x === 'string' && x.trim())
      .slice(0, MAX_FILES)
      .map((x) => x.trim().slice(0, MAX_PATH))
  }
  if (Array.isArray(a.proposals)) {
    out.proposals = a.proposals
      .filter((x) => x && typeof x === 'object')
      .slice(0, MAX_PROPOSALS)
      .map((x) => ({
        path: typeof x.path === 'string' ? x.path.trim().slice(0, MAX_PATH) : '',
        before: typeof x.before === 'string' ? x.before.slice(0, MAX_TEXT) : '',
        after: typeof x.after === 'string' ? x.after.slice(0, MAX_TEXT) : '',
        note: typeof x.note === 'string' ? x.note.slice(0, 300) : '',
      }))
      .filter((x) => x.path)
  }
  return { ok: true, args: out }
}

module.exports = { TOOL, clean, MAX_ID, MAX_TEST_ID, MAX_FILES, MAX_TEXT }
