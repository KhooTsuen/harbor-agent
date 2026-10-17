/**
 * `harbor_edit_file` 的**执行段**（2026-10-17 第五阶段 · 安全局部编辑）
 *
 * ── 它做什么 ──────────────────────────────────────────────────
 *
 * 让 Codex 只改一小段，而不是整文件覆盖。整条链路**全部复用既有机制**：
 * 写开关 / 写根校验 / 逐次审批 / PermissionBar / 审计 / Codex 只读沙箱。
 *
 * ── ★ 五道不变量（用户第 3、4、5、6 条）──────────────────────────
 *
 *   ① **默认关闭**：跟着 `writeEnabled` 走 —— 用户没主动开写入，编辑一律不可用。
 *   ② **写根之内**：`policy.resolveWriteRoot`（realpath 比目录，必须落在隔离数据根内）。
 *   ③ **版本 + 唯一匹配**：`codex-mcp-edit-rules.resolveForEdit` 判
 *      （版本冲突 / 0 次匹配 / 多次匹配 → 全拒，绝不猜位置）。
 *   ④ **审批期间不许变**：批准之后**再跑一遍** ②③ —— 期间文件被改或权限被关，按拒绝。
 *   ⑤ **执行在 Harbor**：真的改由 `tools.execute('edit_file', …)` 做；Codex 仍 `-s read-only`。
 *
 * ── ★ 为什么「批准后再核」要重跑整段而不是只比哈希 ────────────────
 *
 * 审批卡挂着的时候，可能发生三件事：文件被别的回合改（哈希变）、写根被指向别处
 * （边界变）、写入开关被关掉（权限变）。只比哈希会漏掉后两件 —— 所以这里
 * 把 `resolveWriteRoot` + `resolveForEdit` **整段再跑一次**，三件一起挡住。
 *
 * ⚠️ 不 require electron。
 */

/**
 * 跑一次受限局部编辑。
 *
 * @param {{ toolsIndex: object, writeEnabled: boolean, writeRoot: string, isoDir: string,
 *           args: object, ctx: object, startedAt: number, toolReply: Function }} input
 * @returns {Promise<{ ok: true, payload: object } | { ok: false, error: { code: string, message: string } }>}
 */
async function runEditTool(input) {
  const { toolsIndex, writeEnabled, writeRoot, isoDir, args, ctx, startedAt, toolReply } = input
  const policy = require('./codex-mcp-policy.cjs')
  const rules = require('./codex-mcp-edit-rules.cjs')

  if (!writeEnabled) {
    return { ok: false, error: { code: 'WRITE_DISABLED', message: '写能力未启用（没有配置可写的隔离工作区）' } }
  }

  /* 判据打包成一次「检查」，批准前后各跑一遍（见文件头 ④） */
  const check = () => {
    const root = policy.resolveWriteRoot(writeRoot, isoDir)
    if (root.ok === false) return root
    return rules.resolveForEdit(root.abs, args?.path, args?.oldText, args?.newText, args?.expectHash)
  }

  const before = check()
  if (before.ok === false) return { ok: false, error: { code: before.code, message: before.message } }

  /*
   * 逐次审批：`freshApproval` 让 approval.cjs 既不读也不写「批准窗口」记忆 ——
   * 连续两次编辑必须分别弹卡。卡上带 diff（write-diff.cjs 已支持 edit_file，
   * 行号是真实的），用户看得到到底改哪几行。
   */
  const editCtx = { ...ctx, freshApproval: true, expectHash: args?.expectHash }
  /*
   * ★ `expectHash` 必须一起进 args（不只是进 ctx）：批准之后 `recheck` 是从
   *   `request.args` 里读它的。只放 ctx 的话，复核会判「缺版本」→ 明明批准了却被
   *   按拒绝结算（2026-10-17 真机踩到：卡点了允许、文件没改、toolOk=false）。
   *   `edit_file` 自己只读 path/oldText/newText，多余字段无害。
   */
  const wrote = await toolsIndex.execute(
    'edit_file',
    { path: before.abs, oldText: args?.oldText, newText: args?.newText, expectHash: args?.expectHash },
    editCtx,
  )
  /* 审批被拒 / 超时 → edit_file 返回「用户拒绝了…」→ 这里如实报失败（toolOk=false） */
  if (policy.isToolFailure(wrote)) {
    return toolReply(wrote, { harborTool: 'edit_file', resolved: before.abs, ms: Date.now() - startedAt })
  }

  return toolReply(wrote, {
    harborTool: 'edit_file',
    resolved: before.abs,
    /* 版本变化：调用方据此知道「下一段该按哪个版本匹配」 */
    hashBefore: before.hash,
    hashAfter: policyHash(before.abs),
    ms: Date.now() - startedAt,
  })
}

/** 改完之后的新版本（读不到就返回空串 —— 只是元信息，不影响成败判定） */
function policyHash(file) {
  try {
    return require('./codex-mcp-edit-rules.cjs').hashOf(require('node:fs').readFileSync(file, 'utf8'))
  } catch {
    return ''
  }
}

module.exports = { runEditTool }
