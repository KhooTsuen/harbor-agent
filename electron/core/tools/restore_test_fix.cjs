/**
 * 本地工具 `restore_test_fix`（2026-10-17 · 3B-3）
 *
 * ── 它做什么 ──────────────────────────────────────────────────
 *
 * 「把某一次修复精确退回去」。只动**那一次修复改过的文件**，而且只在这两种情况下动手：
 *   · 文件还是修复后的那份（hash 对得上）→ 写回修复前的内容
 *   · 文件已经是修复前的内容 → 什么都不做，如实说「本就已恢复」
 * 如果文件在这之后又被别人改过（两种 hash 都不对）→ **拒绝覆盖**。
 *
 * ── ★ 2026-10-17 可靠性收尾补的两条 ──────────────────────────
 *
 *   ① **恢复也要用户审批**（本阶段第 6 条）。原来它是「备份过的内容想写哪就写哪」——
 *      不需要点头、不看 diff。现在：先算 diff → 弹审批 → 不批就一个字节不写。
 *   ② **恢复点按尝试序号独立**。`executionId` 退的是**最新那次**；要退到更早的
 *      那一次，传 `pointId`（apply_test_fix 的返回里给）。
 *
 * ── ★ 它不删文件、不动目录 ────────────────────────────────────
 *
 * 只写回 `files` 的**文本内容**。没有"删除新建文件"这种能力 —— 那会越过
 * 「精确限定本轮改动」这条线。路径再验一遍（落在记录的写根内才写）。
 *
 * ⚠️ 它在 WRITE_TOOLS / MUTATING_TOOLS 里（会写盘）。
 */

const auditCore = require('../audit.cjs')
const { diffFile } = require('../diff-text.cjs')

module.exports = {
  name: 'restore_test_fix',

  description:
    '把某一次修复（apply_test_fix）改过的文件**精确退回修复前的内容**（逐次需用户审批）。' +
    '只回退那一次改过的文件；如果文件在这之后又被改动过，会**拒绝覆盖**并如实报告。' +
    '不删除任何文件，不动目录。不给 pointId 时退的是那次失败**最新一次**写入。',

  parameters: {
    type: 'object',
    properties: {
      executionId: { type: 'string', description: '那次修复用的执行记录 id（apply_test_fix 结果里的 executionId）' },
      pointId: { type: 'string', description: '可选：精确指定要退到哪个恢复点（apply_test_fix 返回里的 pointId）' },
    },
    required: ['executionId'],
  },

  async run(args, ctx) {
    const restore = require('../project-test-restore.cjs')
    const id = String(args?.executionId ?? '').trim()
    const wanted = String(args?.pointId ?? '').trim()

    /* ① 先只读：把要退的东西取出来，算出**真实**的 diff 给用户看 */
    const point = wanted ? restore.loadById(wanted) : restore.loadPoint(id)
    if (!point) {
      return { text: `恢复结果：没有这个恢复点（id 不对，或已被裁剪）`, toolOk: false }
    }

    const policy = require('../codex-mcp-policy.cjs')
    const plan = []
    for (const e of point.entries) {
      const allowed = restore.pathAllowed(e, policy.isInside)
      if (!allowed.ok) {
        plan.push({ rel: String(e.rel ?? ''), skip: allowed.message })
        continue
      }
      if (e.restorable === false) {
        plan.push({ rel: String(e.rel ?? ''), skip: '原内容太大未保存，无法恢复' })
        continue
      }
      let now = null
      try {
        now = require('node:fs').readFileSync(String(e.abs), 'utf8')
      } catch {
        plan.push({ rel: String(e.rel ?? ''), skip: '文件已不存在，拒绝凭空重建' })
        continue
      }
      plan.push({ rel: String(e.rel ?? ''), abs: String(e.abs), now, before: e.before, entry: e })
    }

    const doable = plan.filter((p) => !p.skip && p.now !== p.before)
    if (doable.length === 0) {
      /* 没有要动的（全是 skip 或本就已恢复）→ 不必打扰用户 */
      const res = restore.restorePoint({ executionId: id, pointId: wanted })
      return { text: `恢复结果：${res.message}\n${res.results.map((r) => `- ${r.rel} → ${r.action}（${r.message}）`).join('\n')}`, toolOk: res.ok }
    }

    /* ② 审批（fail-closed：不是 true 就是拒绝） */
    if (typeof ctx?.confirm !== 'function') {
      return { text: '错误：拿不到审批通道 —— 拒绝恢复（不能无人确认就改源码）', toolOk: false }
    }
    const views = doable.map((p) => ({ ...diffFile({ path: p.rel, before: p.now, after: p.before }), path: p.rel }))
    const approved = await ctx.confirm({
      kind: 'write',
      name: 'restore_test_fix',
      args: { executionId: id, pointId: wanted },
      summary: `把 ${doable.map((p) => p.rel).join('、')} 退回修复前（${views.map((v) => `+${v.additions}/−${v.deletions}`).join('，')} 行）`,
      impact: [
        `将恢复：${doable.length} 个文件`,
        `恢复点：${point.pointId ?? point.id ?? id}`,
        '只写回文本内容；不删除文件、不动目录',
        '如果这些文件在修复之后又被改过，会拒绝覆盖（不会抹掉别人的改动）',
      ],
      diff: views,
    })
    if (approved !== true) {
      auditCore.record({
        sessionId: ctx?.sessionId,
        taskId: ctx?.taskId,
        permission: ctx?.permission,
        tool: 'restore_test_fix',
        args: { executionId: id, pointId: wanted },
        approval: false,
        ok: false,
        error: '用户拒绝',
      })
      return { text: '用户拒绝或超时 —— 没有恢复任何文件', toolOk: false }
    }

    /* ③ 这次才真恢复（内部再验一次 hash，防止审批期间被改） */
    const res = restore.restorePoint({ executionId: id, pointId: wanted })

    try {
      auditCore.record({
        sessionId: ctx?.sessionId,
        taskId: ctx?.taskId,
        permission: ctx?.permission,
        tool: 'restore_test_fix',
        args: { executionId: id, pointId: wanted },
        approval: true,
        ok: res.ok,
        error: res.ok ? '' : res.message,
        affectedFiles: res.results.filter((r) => r.action === 'restored').map((r) => String(r.rel)),
        extras: { actions: res.results.map((r) => `${r.rel}:${r.action}`) },
      })
    } catch {
      /* 审计失败不影响恢复本身 */
    }

    const lines = [`恢复结果：${res.message}`, ...res.results.map((r) => `- ${r.rel} → ${r.action}（${r.message}）`)]
    return { text: lines.join('\n'), toolOk: res.ok }
  },

  summarize(args) {
    const id = String(args?.executionId ?? '').trim()
    const p = String(args?.pointId ?? '').trim()
    if (p) return `退回修复：${p}`
    return id ? `退回修复：${id}` : '退回上一次修复'
  },
}
