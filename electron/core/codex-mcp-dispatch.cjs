const policy = require('./codex-mcp-policy.cjs')
const { runWriteTool } = require('./codex-mcp-write.cjs')
const { runEditTool } = require('./codex-mcp-edit.cjs')
const { runTestTool } = require('./codex-mcp-test.cjs')
const { runProjectTest } = require('./project-test-run.cjs')

function createDispatcher({ getSwitch, resolveWorkdir, makeCtx, toolsIndex, toolReply, DIAG_CMDS, isoDir }) {
  /** 一次工具调用：过 Harbor 的 `execute`（四道闸在里面）。`runId` = 发起那次操作的那一轮对话 */
  async function handleCall(tool, args, runId = '') {
    /* 每次现读（见 getSwitch）：MCP 总开关中途关掉 → 立刻拒绝，不等重启 */
    const live = getSwitch()
    if (live.mcpEnabled !== true)
      return {
        ok: false,
        error: { code: 'MCP_DISABLED', message: 'MCP 桥已在设置里关闭 —— 拒绝这次调用' },
      }
    const entry = require('./codex-mcp-context.cjs').get(runId)
    const workdir = String(entry?.workdir || resolveWorkdir())
    if (!workdir)
      return {
        ok: false,
        error: { code: 'NO_WORKDIR', message: '拿不到受信任的工作区路径 —— 拒绝执行' },
      }
    const ctx = makeCtx(workdir, runId)
    const startedAt = Date.now()
    if (entry) {
      const response = await require('./codex-mcp-collab.cjs').runConversationTool({
        tool,
        args,
        entry,
        ctx,
        toolsIndex,
        toolReply,
        startedAt,
      })
      if (response) return response
    }

    if (tool === 'harbor_read_file') {
      /* ★ 真实路径校验（拒绝对路径 / `..` 穿越 / 符号链接越界）—— 在 Harbor 侧做 */
      const target = policy.resolveInWorkspace(workdir, args?.path)
      if (target.ok === false)
        return { ok: false, error: { code: target.code, message: target.message } }
      const text = await toolsIndex.execute(
        'read_file',
        { path: target.abs, offset: args?.offset, limit: args?.limit },
        ctx,
      )
      const meta = { harborTool: 'read_file', resolved: target.abs, ms: Date.now() - startedAt }
      /* 读成功 → 正文末尾附「文件版本」（局部编辑的 expectHash 取它；Codex 只看到正文） */
      const v = policy.isToolFailure(text)
        ? ''
        : require('./codex-mcp-edit-rules.cjs').versionOf(target.abs)
      if (!v) return toolReply(text, meta)
      return {
        ok: true,
        payload: {
          text: `${text}\n\n（文件版本：${v}）`,
          toolOk: true,
          meta: { ...meta, version: v },
        },
      }
    }

    if (tool === 'harbor_env_diag') {
      const picked = policy.pickChecks(args?.checks)
      if (picked.ok === false)
        return { ok: false, error: { code: 'BAD_INPUT', message: picked.message } }
      const failed = [] /* 哪几项诊断**真的失败了**（逐项判，见文件头 ③） */
      const lines = ['## Harbor 环境诊断（经 MCP 桥 · 只读）', '']
      for (const id of picked.checks) {
        const out = await toolsIndex.execute(
          'run_shell',
          { command: DIAG_CMDS[id], cwd: workdir },
          ctx,
        )
        if (policy.isToolFailure(out)) failed.push(id)
        lines.push(`### ${policy.DIAG_LABELS[id]}`, '', '```', String(out).trim(), '```', '')
      }
      /* 有失败就在正文顶部点出来（**全成功时一个字不加** —— 既有输出逐字节不变） */
      if (failed.length > 0)
        lines.splice(1, 0, `⚠️ 有 ${failed.length} 项诊断失败：${failed.join(' / ')}`, '')
      const meta = {
        harborTool: 'run_shell',
        checks: picked.checks,
        failed,
        ms: Date.now() - startedAt,
      }
      return { ok: true, payload: { text: lines.join('\n'), toolOk: failed.length === 0, meta } }
    }

    if (tool === 'harbor_write_file') {
      return runWriteTool({
        toolsIndex,
        writeEnabled: live.writeEnabled,
        writeRoot: live.writeRoot,
        isoDir,
        args,
        ctx,
        startedAt,
        toolReply,
      })
    }
    /* 局部编辑：同一道写闸；版本 + 唯一匹配由 codex-mcp-edit-rules.cjs 判 */
    if (tool === 'harbor_edit_file') {
      return runEditTool({
        toolsIndex,
        writeEnabled: live.writeEnabled,
        writeRoot: live.writeRoot,
        isoDir,
        args,
        ctx,
        startedAt,
        toolReply,
      })
    }
    /* 命令与 cwd 由 codex-mcp-test.cjs 固定，不接受外部参数 */
    if (tool === 'harbor_run_test') {
      return runTestTool({
        toolsIndex,
        testEnabled: live.testEnabled,
        testRoot: live.testRoot,
        isoDir,
        args,
        ctx,
        startedAt,
        toolReply,
      })
    }
    /* 命令来自用户配置（只给 id）；项目根边界由 policy 判 */
    if (tool === 'harbor_run_project_test') {
      return runProjectTest({ toolsIndex, isoDir, args, ctx, startedAt })
    }
    /* ★ 3B-1 只读分析：按 id 取**已有**快照 + 限额读源码 + 算 diff 预览。走同一个只读工具。 */
    if (tool === 'harbor_analyze_test_failure') {
      const text = await toolsIndex.execute('analyze_test_failure', args, ctx)
      return toolReply(text, { harborTool: 'analyze_test_failure', ms: Date.now() - startedAt })
    }
    /* ★ 3B-2 / 3B-3：受控修复与精确回退 —— 都走同一个执行段（审批 / 哈希复核在里面） */
    if (tool === 'harbor_apply_test_fix' || tool === 'harbor_restore_test_fix') {
      const name = tool === 'harbor_apply_test_fix' ? 'apply_test_fix' : 'restore_test_fix'
      return toolReply(await toolsIndex.execute(name, args, ctx), {
        harborTool: name,
        ms: Date.now() - startedAt,
      })
    }

    return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `不认识的工具：${String(tool)}` } }
  }

  return handleCall
}

module.exports = { createDispatcher }
