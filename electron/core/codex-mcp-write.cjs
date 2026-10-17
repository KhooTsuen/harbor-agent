/**
 * `harbor_write_file` 的**执行段**（2026-10-17 第三阶段 · 受限写）
 *
 * ── 为什么单列一个文件 ────────────────────────────────────────
 *
 * `codex-mcp-bridge.cjs` 已经贴着 300 行红线，而「写」这一段自成一体：
 * **默认关闭 → 写根校验 → 规范化路径校验 → 逐次审批 → 交给 tools.execute**。
 * 搬出来既腾行，也能被自检直接喂假 ctx 跑（不必起整个桥）。
 *
 * ── ★ 四道不变量（用户第 4、5 条）──────────────────────────────
 *
 *   ① **默认关闭**：`writeEnabled` 不为 true → 直接 `WRITE_DISABLED`。
 *   ② **写根必须在隔离数据根之内**：判据是 `policy.resolveWriteRoot`
 *      （realpath 后比目录），指向正式源码 / 配置 / 打包产物在**代码层面**不可能。
 *   ③ **路径规范化**：`..` / 绝对路径 / 符号链接 / 目录联接 由 `policy.resolveForWrite`
 *      全部拒绝（写这个动作**不跟随链接**）。
 *   ④ **执行在 Harbor**：真的写由 `tools/index.cjs` 的 `execute('write_file', …)` 做 ——
 *      Codex 自己仍 `-s read-only`，它没有任何途径绕过 Harbor 写文件。
 *
 * ⚠️ 不 require electron。
 */

/**
 * 跑一次受限写。
 *
 * @param {{ toolsIndex: object, writeEnabled: boolean, writeRoot: string, isoDir: string,
 *           args: object, ctx: object, startedAt: number, toolReply: Function }} input
 * @returns {Promise<{ ok: true, payload: object } | { ok: false, error: { code: string, message: string } }>}
 */
async function runWriteTool(input) {
  const { toolsIndex, writeEnabled, writeRoot, isoDir, args, ctx, startedAt, toolReply } = input
  const policy = require('./codex-mcp-policy.cjs')

  if (!writeEnabled) {
    return { ok: false, error: { code: 'WRITE_DISABLED', message: '写能力未启用（没有配置可写的隔离工作区）' } }
  }
  const root = policy.resolveWriteRoot(writeRoot, isoDir)
  if (root.ok === false) return { ok: false, error: { code: root.code, message: root.message } }

  const target = policy.resolveForWrite(root.abs, args?.path, args?.content)
  if (target.ok === false) return { ok: false, error: { code: target.code, message: target.message } }

  /*
   * ★ 逐次审批：`freshApproval` 让 approval.cjs **既不读也不写**那个「批准窗口」记忆 ——
   *   连续两次写必须**分别弹卡**（用户第 3 条）。执行前 Harbor 先弹真卡；
   *   用户拒绝或超时 → write_file 返回「用户拒绝…」→ 这里如实报失败（toolOk=false）。
   */
  const writeCtx = { ...ctx, freshApproval: true }
  const wrote = await toolsIndex.execute('write_file', { path: target.abs, content: args?.content }, writeCtx)
  return toolReply(wrote, { harborTool: 'write_file', resolved: target.abs, ms: Date.now() - startedAt })
}

module.exports = { runWriteTool }
