const fs = require('node:fs')
const path = require('node:path')
const editRules = require('./codex-mcp-edit-rules.cjs')

function denied(code, message) {
  return { ok: false, error: { code, message } }
}

function failure(text) {
  return /^(错误：|用户拒绝了这个操作：)/.test(String(text ?? ''))
}

function absolutePath(root, input) {
  return path.resolve(root, String(input ?? ''))
}

async function runConversationTool({ tool, args, entry, ctx, toolsIndex, toolReply, startedAt }) {
  if (!entry) return null
  if (entry.signal?.aborted) return denied('CANCELLED', '当前对话已经停止')
  if (entry.threadSettings?.allowTools === false)
    return denied('TOOLS_DISABLED', '这条对话已关闭工具')
  const root = String(entry.workdir ?? '')
  if (!root || ctx.workdir !== root || ctx.sessionId !== entry.sessionId) {
    return denied('CONTEXT_MISMATCH', '对话工作目录或授权身份已失效')
  }

  if (tool === 'harbor_read_image') {
    const text = await toolsIndex.execute('read_image', args, ctx)
    return toolReply(text, { harborTool: 'read_image', ms: Date.now() - startedAt })
  }
  if (tool === 'harbor_read_file') {
    const text = await toolsIndex.execute(
      'read_file',
      { path: args?.path, offset: args?.offset, limit: args?.limit },
      ctx,
    )
    let resolved = absolutePath(root, args?.path)
    try {
      resolved = fs.realpathSync(resolved)
    } catch {
      /* 读取失败时保留请求路径；下方工具结果会给出具体原因 */
    }
    const version = failure(text) ? '' : editRules.versionOf(resolved)
    return toolReply(version ? `${text}\n\n（文件版本：${version}）` : text, {
      harborTool: 'read_file',
      resolved,
      ms: Date.now() - startedAt,
    })
  }
  if (tool !== 'harbor_write_file' && tool !== 'harbor_edit_file') return null
  if (entry.allowWrite === false || ctx.permission === 'readonly')
    return denied('READ_ONLY', '当前对话没有写入权限')

  if (tool === 'harbor_write_file') {
    const text = await toolsIndex.execute(
      'write_file',
      { path: args?.path, content: args?.content },
      { ...ctx, freshApproval: true },
    )
    return toolReply(text, {
      harborTool: 'write_file',
      resolved: absolutePath(root, args?.path),
      ms: Date.now() - startedAt,
    })
  }

  /* 先通过 Harbor 的路径授权门读一次；授权成功后再核版本，绝不绕过 capability。 */
  const read = await toolsIndex.execute('read_file', { path: args?.path, limit: 1 }, ctx)
  if (failure(read)) return toolReply(read, { harborTool: 'edit_file', ms: Date.now() - startedAt })
  let resolved = absolutePath(root, args?.path)
  try {
    resolved = fs.realpathSync(resolved)
  } catch {
    return denied('NOT_FOUND', '目标文件不存在或无法解析真实路径')
  }
  const actual = editRules.versionOf(resolved)
  if (!actual || actual !== String(args?.expectHash ?? ''))
    return denied('VERSION_CONFLICT', `文件版本已变化（当前 ${actual || '无法读取'}），请重新读取后再编辑`)
  const before = fs.readFileSync(resolved, 'utf8')
  const oldText = editRules.lf(args?.oldText)
  const normalized = editRules.lf(before)
  const at = normalized.indexOf(oldText)
  if (!oldText || at < 0 || normalized.indexOf(oldText, at + oldText.length) >= 0)
    return denied('EDIT_NOT_UNIQUE', '待替换文本必须在当前文件中恰好出现一次')
  const text = await toolsIndex.execute(
    'edit_file',
    { path: resolved, oldText: args?.oldText, newText: args?.newText },
    { ...ctx, freshApproval: true },
  )
  return toolReply(text, { harborTool: 'edit_file', resolved, ms: Date.now() - startedAt })
}

function recheckConversation(name, request, runId) {
  const entry = require('./codex-mcp-context.cjs').get(runId)
  if (!entry || entry.signal?.aborted || entry.threadSettings?.allowTools === false) return false
  if (entry.allowWrite === false || entry.permission === 'readonly') return false
  const root = String(entry.workdir ?? '')
  if (!root) return false
  const absolute = absolutePath(root, request?.args?.path)
  const decision = require('./capability.cjs').check(absolute, {
    workdir: root,
    sessionId: entry.sessionId,
    consumeOnce: false,
  })
  if (!decision.ok) return false
  if (name !== 'edit_file') return true
  const args = request?.args ?? {}
  const resolved = decision.absolute
  const actual = editRules.versionOf(resolved)
  if (!actual || actual !== String(args.expectHash ?? '')) return false
  try {
    const text = editRules.lf(fs.readFileSync(resolved, 'utf8'))
    const oldText = editRules.lf(args.oldText)
    const at = text.indexOf(oldText)
    return Boolean(oldText) && at >= 0 && text.indexOf(oldText, at + oldText.length) < 0
  } catch {
    return false
  }
}

module.exports = { runConversationTool, recheckConversation }
