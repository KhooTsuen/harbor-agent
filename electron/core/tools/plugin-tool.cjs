/**
 * 本地插件的权限门 + 执行
 *
 * 从 tools/index.cjs 拆出来的（那边加插件权限之后过 300 行了）。
 *
 * 职责：如果工具名是个本地插件，按 manifest 里声明的权限过闸，
 * 然后执行，返回结果字符串；**不是插件则返回 null**，交给内置工具流程。
 *
 * 权限闸和内置工具是同一套语义：
 *   · 联网 / 写文件都算「有副作用」—— readonly 拦、ask 确认、full 放行
 *   · `allowNetwork:false` 拦联网插件、`allowWrite:false` 拦写文件插件
 *
 * ⚠️ 这只是「宿主决定要不要调用」这一层。插件本身在宿主进程里 require，
 * 它能用 node:fs 之类，真正沙箱化是 P2（第三方插件）的事。
 */

const plugins = require('../plugins.cjs')
const { auditCall } = require('./permission.cjs')

/**
 * @param {string} name 工具名
 * @param {Record<string, unknown>} args
 * @param {object} ctx
 * @param {number} startedAt
 * @returns {Promise<string | null>} 插件的结果；不是插件返回 null
 */
async function executePlugin(name, args, ctx, startedAt) {
  const plugin = plugins.getByName(name)
  if (!plugin) return null

  const perm = plugin.permissions ?? {}
  const needsNetwork = perm.network === true
  const needsWrite = perm.write === true
  /* 联网/写文件都算「有副作用」——和写操作一样对待 */
  const risky = needsNetwork || needsWrite

  /* ── 运行时约束（不依赖模型自觉，和内置工具同一套）── */
  if (ctx.allowTools === false) {
    auditCall(ctx, { tool: name, args, startedAt, ok: false, error: '本次对话关闭工具' })
    return `错误：本次对话已关闭工具调用，${name} 被拒绝。`
  }
  if (ctx.allowWrite === false && needsWrite) {
    auditCall(ctx, { tool: name, args, startedAt, ok: false, error: '本轮约束禁止写入' })
    return `错误：本轮对话的运行时约束是「只分析，不修改」，${name} 被拒绝。`
  }
  if (ctx.allowNetwork === false && needsNetwork) {
    auditCall(ctx, { tool: name, args, startedAt, ok: false, error: '本轮约束禁止联网' })
    return `错误：本轮对话禁止联网，${name} 被运行时拒绝。`
  }
  if (ctx.permission === 'readonly' && risky) {
    auditCall(ctx, { tool: name, args, startedAt, ok: false, error: '只读模式拒绝插件' })
    return `错误：当前是「只读」权限，插件「${plugin.nameForHuman}」${plugins.describePermissions(perm)}被拒绝。`
  }

  let approval = null
  if (risky && ctx.permission === 'ask' && typeof ctx.confirm === 'function') {
    approval = await ctx.confirm({
      kind: 'write',
      name,
      args,
      summary: `运行插件「${plugin.nameForHuman}」${plugins.describePermissions(perm)}`,
    })
    if (!approval) {
      auditCall(ctx, { tool: name, args, startedAt, approval: false, ok: false, error: '用户拒绝' })
      return `用户拒绝了这个操作：${name}`
    }
  }

  try {
    const text = await plugins.runPlugin(plugin, args ?? {}, ctx)
    auditCall(ctx, {
      tool: name,
      args,
      startedAt,
      approval,
      ok: true,
      extras: { plugin: plugin.id, permissions: perm },
    })
    return text
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    auditCall(ctx, { tool: name, args, startedAt, approval, ok: false, error: message })
    return `错误：${message}`
  }
}

module.exports = { executePlugin }
