/**
 * 项目测试失败的**单次受控修复**（2026-10-17 · 3B-2 / 3B-3）
 *
 * 「测试挂了 →（模型读完源码）给出具体改法 → 用户点头 → 改那一个文件 →
 *  只重跑那一条测试 → 如实报六态」。一次最多改一个文件、最多重跑一条测试。
 *
 * ★ 十一条闸（顺序不可换）：
 *   ① 起点必须是真实执行记录（`project-test-fix-args.cjs` 的 `pickSnapshot`）
 *   ② 只有 FAIL 能修（`project-test-rules.cjs` 的 gate）
 *   ③ 路径边界：项目根 → `project-roots.resolveAuthorizedRoot`（授权根 + realpath/禁区）；相对路径 → `resolveForWrite`
 *   ④ 提案必须基于当前真实内容：`before` hash 与磁盘不符 → `STALE_PROPOSAL`
 *   ⑤ 预算（按 executionId 计账，默认 1 次、上限 3 次 + 耗时）。排在形状/路径校验**之后**
 *   ⑥ 用户明确审批：`ctx.confirm` 不是 `true` 一律按拒绝，零写入
 *   ⑦ 审批后复核：文件被改了 → `STALE_AFTER_APPROVAL`；中途取消 → `CANCELLED`（取消优先）
 *   ⑧ **恢复点先落盘再写源码**：存不下就 `RESTORE_FAILED`，不写
 *   ⑨ **三方一致**：diff 基线用真实 `current`；待写内容 hash 审批时记下，写前再比（`CONTENT_SWAPPED`），写完验磁盘（`WRITE_INCONSISTENT`）。⑩ 写完到重测之间再查取消 → `CANCELLED_AFTER_WRITE`（已写但不跑测试）
 *   ⑪ 只重跑那一条；只有**真写过**才记一次尝试（拒绝/STALE/取消都不吃额度）
 *
 * 审计：本文件自落一条（executionId / 路径 / 审批 / 增删行 / 修复后状态）；重跑那条由 `run_project_test` 落。
 *
 * ⚠️ 不 require electron。
 */

const fs = require('node:fs')
const { gate } = require('./project-test-rules.cjs')
const { classifyRun, STATUS } = require('./project-test-status.cjs')
const policy = require('./codex-mcp-policy.cjs')
const { hashOf } = require('./codex-mcp-edit-rules.cjs')
const restore = require('./project-test-restore.cjs')
const loop = require('./project-test-loop.cjs')
const { auditCall } = require('./tools/permission.cjs')
const { diffFile } = require('./diff-text.cjs')
const { isAborted } = require('./abort.cjs')
const { MAX_PROPOSALS, MAX_TEXT, pickSnapshot, cleanProposals } = require('./project-test-fix-args.cjs')

/** 读当前内容；读不到返回 null */
function readNow(abs) {
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** 审批卡的正文（改什么 / 依据 / 影响 / 怎么验证） */
function approvalBody(snap, prop, target, view) {
  return [
    `将修改：${target.abs}`,
    `依据：测试 ${snap.testId ?? ''}（${snap.label ?? ''}）上次结果是 ${snap.status}`,
    prop.note ? `改法说明：${prop.note}` : '',
    '影响范围：只动这 1 个文件；改完只重跑那一条测试',
    `验证方式：重跑 ${snap.testId ?? ''}，按六态如实报`,
    `差异：+${view.additions} / −${view.deletions} 行（详情见下）`,
    '⚠️ 这只是拟议修改 —— 你点「允许」之后才会写盘。',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 审计的小包装（同一形状写四遍太占行） */
function audit(ctx, startedAt, args, extra) {
  auditCall(ctx, { tool: 'apply_test_fix', args, startedAt, ...extra })
}

/**
 * 主入口（与 `run_project_test` 同形状）。
 *
 * @param {{ toolsIndex: object, isoDir: string, args: object, ctx: object, startedAt: number }} input
 */
async function runTestFix(input) {
  const { toolsIndex, isoDir, args, ctx, startedAt } = input

  /* ① 真实执行记录 */
  const picked = pickSnapshot(args)
  if (picked.ok === false) return { ok: false, error: { code: picked.code, message: picked.message } }
  const snap = picked.snapshot
  const auditArgs = { executionId: snap.executionId, path: String(args?.proposals?.[0]?.path ?? '') }

  /* ② 只有 FAIL 能修 */
  const g = gate(snap.status)
  if (!g.fixable) {
    return {
      ok: false,
      error: { code: 'NOT_FIXABLE', message: `这次执行的状态是 ${snap.status}，不做代码修复（${g.note}）` },
    }
  }

  /* ③ 提案形状 */
  const props = cleanProposals(args?.proposals)
  if (props.ok === false) return { ok: false, error: { code: 'BAD_PROPOSAL', message: props.message } }

  /* ④ 路径边界（3C-2：用户授权的项目根；写要比读多一道 allowWrite） */
  const roots = require('./project-roots.cjs')
  const items = require('./project-tests.cjs').load().items
  const root = roots.resolveAuthorizedRoot({ root: snap.projectRoot, isoDir, items, action: 'write' })
  if (root.ok === false) return { ok: false, error: { code: root.code, message: root.message } }
  const prop = props.proposals[0]
  const target = policy.resolveForWrite(root.abs, prop.path, prop.after)
  if (target.ok === false) return { ok: false, error: { code: target.code, message: target.message } }

  /* ⑤ 提案必须基于当前真实内容 */
  const current = readNow(target.abs)
  if (current === null) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `文件不存在：${target.abs}` } }
  }
  if (hashOf(current) !== hashOf(prop.before)) {
    audit(ctx, startedAt, auditArgs, { ok: false, error: '提案内容与磁盘现状不一致（STALE_PROPOSAL）' })
    return {
      ok: false,
      error: {
        code: 'STALE_PROPOSAL',
        message: '提案里的 before 与磁盘上的内容不一致 —— 文件已经变了，请重新读一遍再提改法（不会按旧内容覆盖）',
      },
    }
  }

  /* ⑥ 预算：排在形状/路径/哈希之后，让"越界路径"报越界而不是"次数用完"；
     且只有真写过才记账（下面拒绝 / STALE 都不吃额度） */
  const budget = loop.takeAttempt({ executionId: snap.executionId, maxAttempts: args?.maxAttempts })
  if (budget.ok === false) {
    audit(ctx, startedAt, auditArgs, { ok: false, error: `${budget.code}：${budget.message}` })
    return { ok: false, error: { code: budget.code, message: budget.message } }
  }
  /* ★ 序号还要避开**磁盘上已存在的恢复点**（修的真缺陷）：额度账本是 JSONL、会被环形裁剪，
     写失败也只返回 ok:false；账本一丢行 attemptNo 就从 1 重算，撞上已有 `__a1` → 修复被拒
     （安全但卡死）。取「账本序号」与「已有点最大序号+1」的较大者，两边都不单信。 */
  const attemptNo = Math.max(
    budget.attemptNo,
    restore.loadAllPoints(snap.executionId).reduce((m, p) => Math.max(m, Number(p.attemptNo ?? 0)), 0) + 1,
  )

  /* ⑦ 用户明确审批（fail-closed：不是 true 就是拒绝）
   * ★ 三方一致：diff 基线用**真实读到的 current**（不是模型自报的 before），待写入内容的
   *   hash 记在 afterHashAtApproval；写入前再比一次 —— 审批展示的、校验的、写入的必须同一份。 */
  const view = diffFile({ path: prop.path, before: current, after: prop.after })
  const afterHashAtApproval = hashOf(prop.after)
  if (typeof ctx.confirm !== 'function') {
    return { ok: false, error: { code: 'NO_CONFIRM', message: '拿不到审批通道 —— 拒绝写入（不能无人确认就改源码）' } }
  }
  const approved = await ctx.confirm({
    kind: 'test-fix',
    name: 'apply_test_fix',
    args: auditArgs,
    summary: `按分析结果修 ${prop.path}（+${view.additions} / −${view.deletions} 行）`,
    impact: [...approvalBody(snap, prop, target, view).split('\n'), '审批之后到写入之前若该文件又被改动 → 自动拒绝写入（保护别人的修改）'],
    diff: [{ ...view, path: prop.path }],
  })
  if (approved !== true) {
    /* 拒绝不记账：没有发生任何写入，不该消耗尝试额度 */
    audit(ctx, startedAt, auditArgs, { approval: false, ok: false, error: '用户拒绝' })
    return { ok: false, error: { code: 'DENIED', message: '用户拒绝或超时 —— 没有修改任何文件' } }
  }

  /* ⑧ 审批之后再复核（这期间被别人改了就不覆盖；中途被取消也一律不写） */
  if (isAborted(ctx.signal)) {
    /* 用户点了停止 —— 即使刚点过「允许」也不再写（取消优先于批准） */
    audit(ctx, startedAt, auditArgs, { approval: true, ok: false, error: '用户中途取消（CANCELLED）' })
    return { ok: false, error: { code: 'CANCELLED', message: '这次执行已被用户取消 —— 没有修改任何文件' } }
  }
  const again = readNow(target.abs)
  /* 与审批展示用的**同一份基线**（current）比 —— 而不是与模型自报的 before 比 */
  if (again === null || hashOf(again) !== hashOf(current)) {
    /* 同样不记账：这次也没写成功 */
    audit(ctx, startedAt, auditArgs, { approval: true, ok: false, error: '审批期间文件被改动（STALE_AFTER_APPROVAL）' })
    return {
      ok: false,
      error: {
        code: 'STALE_AFTER_APPROVAL',
        message: '审批期间这个文件被改动了 —— 已拒绝覆盖（不会抹掉别人的修改）',
      },
    }
  }

  /* 恢复点 → 写入
   * ★ 顺序不可换（2026-10-17 修的真缺陷）：原来**丢弃了 savePoint 的返回值**，恢复点
   *   写不进去（磁盘满/只读/权限）照样改源码 —— 改完就退不回来。现在存不下就不写。
   * ★ 按 attemptNo 独立命名：同一失败的第 2 次尝试不会覆盖第 1 次的点。 */
  const entry = restore.capture({ abs: target.abs, rel: prop.path, root: root.abs, before: again, after: prop.after })
  const saved = restore.savePoint(snap.executionId, [entry], {
    attemptNo,
    testId: snap.testId ?? '',
    tool: 'apply_test_fix',
  })
  if (saved.ok === false) {
    audit(ctx, startedAt, auditArgs, { approval: true, ok: false, error: `恢复点保存失败：${saved.message}` })
    return { ok: false, error: { code: 'RESTORE_FAILED', message: `无法建立恢复点，已拒绝修改源码：${saved.message}` } }
  }

  /* ★ 三方一致（第 3 条）：待写入内容的 hash 与审批时记下的对上才写 */
  if (hashOf(prop.after) !== afterHashAtApproval) {
    audit(ctx, startedAt, auditArgs, { approval: true, ok: false, error: '拟议内容在审批后发生变化（CONTENT_SWAPPED）' })
    return { ok: false, error: { code: 'CONTENT_SWAPPED', message: '审批后待写入的内容与会话展示的不一致 —— 已拒绝写入' } }
  }

  try {
    fs.writeFileSync(target.abs, prop.after, 'utf8')
  } catch (error) {
    const msg = String((error && error.message) || error)
    audit(ctx, startedAt, auditArgs, { approval: true, ok: false, error: `写入失败：${msg}` })
    return { ok: false, error: { code: 'WRITE_FAILED', message: `写入失败：${msg}（恢复点在 ${saved.id}）` } }
  }

  /* 写完必须就是 prop.after —— 不是就如实报（恢复点还在，可以退回去） */
  const written = readNow(target.abs)
  if (written === null || hashOf(written) !== hashOf(prop.after)) {
    audit(ctx, startedAt, auditArgs, { approval: true, ok: false, error: '写入后校验失败（WRITE_INCONSISTENT）', affectedFiles: [target.abs] })
    return {
      ok: false,
      error: { code: 'WRITE_INCONSISTENT', message: `写入后内容与预期不符 —— 恢复点在 ${saved.id}，可用 restore_test_fix 退回` },
    }
  }

  /* ★ 第 7 条：写完到重测之间再确认一次没被取消 —— 点了停止就不该再跑测试 */
  if (isAborted(ctx.signal)) {
    audit(ctx, startedAt, auditArgs, { approval: true, ok: false, error: '写入后用户取消，未重跑测试', affectedFiles: [target.abs] })
    return {
      ok: false,
      error: { code: 'CANCELLED_AFTER_WRITE', message: `已写入但用户取消了 —— 没有重跑测试。恢复点在 ${saved.id}` },
    }
  }

  /* ⑧ 只重跑那一条（同一条通道：自带审批 / 审计 / 六态）。★ 显式关 `wantMeta`：
     ctx 从 tool-runner 带了 `wantMeta: true`，execute 就回 `{text,toolOk}`，
     `String()` 变成 `[object Object]` → classifyRun 判不出退出码 → 一律 ERROR
     （2026-10-17 自举实测真缺陷）。重跑要正文，成败由 classifyRun 一处判。 */
  let retestOut = ''
  try {
    const retestCtx = { ...ctx, wantMeta: false }
    const raw = await toolsIndex.execute('run_project_test', { id: String(snap.testId ?? '') }, retestCtx)
    retestOut = raw !== null && typeof raw === 'object' ? String(raw.text ?? '') : String(raw)
  } catch (error) {
    retestOut = `错误：重跑失败 ${String((error && error.message) || error)}`
  }
  const after = classifyRun(retestOut)
  const passed = after.status === STATUS.PASS

  loop.finishAttempt({
    executionId: snap.executionId, attemptNo, testId: snap.testId, path: prop.path,
    beforeStatus: snap.status, afterStatus: after.status, written: true,
  })

  audit(ctx, startedAt, auditArgs, {
    approval: true,
    ok: passed,
    affectedFiles: [target.abs],
    result: `status=${after.status} exit=${after.exitCode ?? 'null'}`,
    extras: {
      executionId: snap.executionId,
      attemptNo,
      pointId: saved.id,
      additions: view.additions,
      deletions: view.deletions,
    },
  })

  const lines = [
    passed ? `修复后测试通过（${snap.testId ?? ''}）` : `修复后仍未通过：${after.status}`,
    '',
    `修改文件：${prop.path}`,
    `差异：+${view.additions} / −${view.deletions} 行`,
    `依据：执行记录 ${snap.executionId}（${snap.status}）`,
    `第 ${attemptNo}/${budget.maxAttempts} 次尝试，剩余 ${budget.remaining} 次`,
    `修复后状态：${after.status}${after.exitCode === null ? '' : `（退出码 ${after.exitCode}）`}`,
    '',
    '—— 回退（每次写入各有一个恢复点，互不覆盖）——',
    `这一次：restore_test_fix，executionId=${snap.executionId}，pointId=${saved.id}`,
    `更早那次：pointId=${restore.pointId(snap.executionId, 1)}`,
    '',
    '—— 重跑输出 ——',
    retestOut,
  ]

  return {
    ok: true,
    payload: {
      text: lines.join('\n'),
      toolOk: passed,
      meta: {
        harborTool: 'run_project_test',
        executionId: snap.executionId,
        testId: snap.testId ?? '',
        written: [target.abs],
        pointId: saved.id,
        additions: view.additions,
        deletions: view.deletions,
        beforeStatus: snap.status,
        afterStatus: after.status,
        afterExitCode: after.exitCode,
        attemptNo,
        maxAttempts: budget.maxAttempts,
        remaining: budget.remaining,
        approved: true,
        /* 如实标注：只实现了次数与耗时；模型费用预算未实现（见 project-test-loop.cjs 文件头） */
        budgets: { attempts: true, elapsed: true, modelCost: false },
      },
    },
  }
}

module.exports = { runTestFix, MAX_PROPOSALS, MAX_TEXT, pickSnapshot, cleanProposals }
