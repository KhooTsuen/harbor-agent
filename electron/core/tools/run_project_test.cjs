/**
 * 本地工具 `run_project_test`（2026-10-17 · 3A）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * Codex 走 MCP 桥能跑项目测试（`harbor_run_project_test`），但 **DeepSeek 走的是
 * 本地工具**这条路。用户第 4 节要求「两者应能使用同一套 Harbor 测试能力」，
 * 且「不为了本轮功能强行重构 Provider 架构」。
 *
 * 所以这里**只做一层薄封装**：真正干活的判据与执行全在 `core/project-test-run.cjs`
 * （与 MCP 侧同一个函数）。这个文件不重复任何判据 —— 改一处两边都变（硬约束 9）。
 *
 * ── ★ 它不开放任意 shell ──────────────────────────────────────
 *
 * `parameters` 里**没有 command 字段**，只有 `id`。模型给不出命令，
 * 只能点名「用户已经配好的那一条」。这是本工具与 `run_shell` 的根本区别。
 *
 * ⚠️ 它仍进 WRITE_TOOLS / MUTATING_TOOLS：跑测试**会执行代码**，可能改文件
 * （构建产物、快照测试），所以「只分析」那一轮必须拦住它。
 */

module.exports = {
  name: 'run_project_test',

  description:
    '在用户**指定项目的根目录**里执行用户**预先配置好**的一条测试命令并返回真实结果。' +
    '不接受自由命令：只能给 `id`（用户在设置 → 项目测试里配置的条目；不传则列出可选项）。' +
    '结果如实区分 PASS / FAIL / TIMEOUT / CANCELLED / DENIED / ERROR —— 退出码非 0 一律算失败。' +
    '默认关闭；执行前会弹确认框。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '要跑的那一条的 id（不给则列出可选项）' },
    },
    required: [],
  },

  async run(args, ctx) {
    const tests = require('../project-tests.cjs')
    const core = require('../project-test-run.cjs')
    const { DIRS } = require('../paths.cjs')

    /* 不给 id 时别让它去猜 —— 把可选项摊开，模型下一步就能点对 */
    if (!String(args?.id ?? '').trim()) {
      const cfg = tests.load()
      if (cfg.enabled !== true) return '错误：项目测试未启用（设置 → 项目测试）。'
      if (cfg.items.length === 0) return '错误：还没有配置任何项目测试（设置 → 项目测试）。'
      const list = cfg.items.map((x) => `- ${x.id}：${x.label}（${x.command} @ ${x.root}）`)
      return ['可用的项目测试：', ...list, '', '请带 id 再调用一次。'].join('\n')
    }

    /* 项目根边界由 policy 判（与 MCP 侧同一个函数，不另写一套） */
    const res = await core.runProjectTest({
      toolsIndex: require('./index.cjs'),
      isoDir: DIRS.data,
      args: args ?? {},
      ctx,
      startedAt: Date.now(),
    })
    if (res.ok === false) return `错误：${res.error.message}`
    return String(/** @type {any} */ (res.payload)?.text ?? '')
  },

  summarize(args) {
    const id = String(args?.id ?? '').trim()
    return id ? `跑项目测试：${id}` : '列出项目测试'
  },
}
