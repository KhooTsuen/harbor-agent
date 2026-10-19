/**
 * 本地工具 `apply_test_fix`（2026-10-17 · 3B-2 / 3B-3）
 *
 * ── 它做什么 ──────────────────────────────────────────────────
 *
 * 「按分析结果真的改一次代码，然后只重跑那一条测试」。**这是本阶段唯一会写
 * 项目源码的工具**，所以它比 `analyze_test_failure` 多三道门：审批、哈希复核、
 * 尝试预算。
 *
 * ── ★ 参数里没有任何可执行的东西 ──────────────────────────────
 *
 *   · `executionId` / `testId` —— 指定**哪一次**失败（status 从快照读）
 *   · `proposals` —— 具体的改法（一次只收 1 个文件）
 *   · `maxAttempts` —— 想要几次额度（默认 1，上限 3）
 *
 * 没有 command、没有 shell、没有"重跑别的测试"的入口。
 *
 * ── 与 Codex 路径的关系 ───────────────────────────────────────
 *
 * Codex 走 MCP 的 `harbor_apply_test_fix`，复用同一个执行段
 * （`core/project-test-fix.cjs`）。本文件只做参数形状收紧与文案包装。
 *
 * ⚠️ 它在 WRITE_TOOLS / MUTATING_TOOLS 里 —— 「只分析」那一轮不该改代码。
 */

const restore = require('../project-test-restore.cjs')

module.exports = {
  name: 'apply_test_fix',

  description:
    '按失败分析结果**真的修改**项目源码（逐次需用户审批），然后只重跑受影响的那一条测试。' +
    '起点必须是**已经真实执行过**的 FAIL 结果（给 executionId 或 testId），不能自己声明状态。' +
    '一次最多改 1 个文件；写入前会复核文件哈希，文件被别人改过就拒绝覆盖。' +
    '改前会建文件级恢复点（**每次写入一个独立点，互不覆盖**），可用 restore_test_fix 精确回退。' +
    '默认只允许 1 次尝试（最多 3 次）—— 用完即停，不会自己循环。' +
    '预算只含**次数与耗时**两种；模型调用费没有上限（本版未实现）。',

  parameters: {
    type: 'object',
    properties: {
      executionId: { type: 'string', description: '要修的那次执行 id（run_project_test 结果里的 executionId）' },
      testId: { type: 'string', description: '不给 executionId 时，修这个条目**最近一次**的失败' },
      proposals: {
        type: 'array',
        description: '具体改法（一次只能 1 项；before 必须真的来自读到的源码）',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '项目根下的相对路径' },
            before: { type: 'string', description: '修改前的完整文件内容（必须与磁盘一致）' },
            after: { type: 'string', description: '修改后的完整文件内容' },
            note: { type: 'string', description: '这处修改为什么这么改' },
          },
          required: ['path', 'before', 'after'],
        },
      },
      maxAttempts: {
        type: 'integer',
        description: '这条失败允许的总尝试次数（默认 1，上限 3）；用完就停，不会自动重试',
      },
    },
    required: ['proposals'],
  },

  async run(args, ctx) {
    const core = require('../project-test-fix.cjs')
    const { DIRS } = require('../paths.cjs')

    const res = await core.runTestFix({
      toolsIndex: require('./index.cjs'),
      isoDir: DIRS.data,
      args: args ?? {},
      ctx,
      startedAt: Date.now(),
    })
    if (res.ok === false) return `错误：${res.error.message}`
    const payload = /** @type {any} */ (res.payload)
    return { text: String(payload?.text ?? ''), toolOk: payload?.toolOk !== false }
  },

  summarize(args) {
    const id = String(args?.executionId ?? '').trim()
    const p = String(args?.proposals?.[0]?.path ?? '').trim()
    if (p) return `按分析结果修 ${p}${id ? `（依据 ${id}）` : ''}`
    return '按分析结果修一个文件'
  },
}

/** 供自检核对：恢复点目录在哪（不参与工具 schema） */
module.exports.restoreDir = restore.dir
