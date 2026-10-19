/**
 * **协作闭环里的「真实痕迹」**：从 DeepSeek 这次执行的 `toolRuns` 里，
 * 抽出「改了哪些文件 / 测试是什么状态 / 对应哪次执行记录」。
 *
 * ── ★ 为什么不用模型自述 ──────────────────────────────────────
 *
 * 验收如果只看「执行者说自己改好了」，那就等于没验收。
 * 这里的数据源只有一个：`loop.run` 返回的 `toolRuns`（内核逐个工具调用记下来的
 * `{ id, name, args, ok, output, ms }`）。**成功与否看 `ok`，测试状态看
 * `classifyRun`（六态的唯一判据）** —— 不解析模型的话，也不自造状态。
 *
 * ⚠️ 不 require electron。
 */

const { classifyRun, STATUS } = require('./project-test-status.cjs')

/** 会改动文件的工具（与 registry 的 FILE_WRITERS 同一批语义） */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_test_fix', 'restore_test_fix'])

/** 从工具参数里取目标路径（三个工具的写法不同，收在一处） */
function targetOf(run) {
  const args = run?.args ?? {}
  if (typeof args.path === 'string' && args.path.trim()) return args.path.trim()
  const first = Array.isArray(args.proposals) ? args.proposals[0] : null
  if (first && typeof first.path === 'string' && first.path.trim()) return first.path.trim()
  return ''
}

/** 从正文里抠出执行记录 id（`ptr_...`）—— 只是**读**，不凭它判状态 */
function executionIdOf(text) {
  const m = String(text ?? '').match(/\bptr_[a-z0-9_]+/i)
  return m ? m[0] : ''
}

/**
 * 从 toolRuns 里抽真实痕迹。
 *
 * @param {Array<{name:string,args:object,ok:boolean,output:string}>} toolRuns
 * @returns {{ writes: string[], tests: object[], lastTest: object|null,
 *             executionId: string, retries: number, tools: object[] }}
 */
function extractTrace(toolRuns) {
  const list = Array.isArray(toolRuns) ? toolRuns : []
  const writes = []
  const tests = []
  let executionId = ''

  for (const run of list) {
    if (!run || typeof run.name !== 'string') continue
    const output = String(run.output ?? '')

    if (WRITE_TOOLS.has(run.name) && run.ok === true) {
      const path = targetOf(run)
      /* 只有真的写成功才记（`ok:false` 的写入尝试不算"改过"） */
      if (path && !writes.includes(path)) writes.push(path)
    }
    if (run.name === 'run_project_test') {
      const verdict = classifyRun(output)
      tests.push({
        status: verdict.status,
        exitCode: verdict.exitCode,
        testId: String(run.args?.id ?? ''),
        ok: run.ok === true,
      })
    }
    const id = executionIdOf(output)
    if (id) executionId = id
  }

  return {
    writes,
    tests,
    lastTest: tests.length > 0 ? tests[tests.length - 1] : null,
    executionId,
    /* 「重试过几次」= 同一工具名出现多次且前几次失败（只报数字，不做判断） */
    retries: list.filter((r) => r && r.ok !== true).length,
    tools: list.map((r) => ({ name: r?.name ?? '', ok: r?.ok === true })),
  }
}

/** 六态里哪些算「测试真的通过了」—— 只有 PASS */
function testPassed(trace) {
  return trace?.lastTest?.status === STATUS.PASS
}

/**
 * 从恢复点里取这次修复的真实 diff（拿不到就返回空 —— 不编）。
 *
 * ★ 为什么在恢复点里取：那里存着写入前的原文 + 写入后的 hash，是**唯一**能
 *   还原「到底改了什么」的来源。拿不到就不给 diff，绝不用模型自述凑一段。
 *
 * @param {string} executionId @param {string[]} writes
 * @returns {string}
 */
function diffOf(executionId, writes) {
  if (!executionId || !Array.isArray(writes) || writes.length === 0) return ''
  try {
    const restore = require('./project-test-restore.cjs')
    const { diffFile } = require('./diff-text.cjs')
    const points = restore.loadAllPoints(executionId)
    if (!Array.isArray(points) || points.length === 0) return ''
    const latest = points[points.length - 1]
    const parts = []
    for (const e of latest.entries ?? []) {
      if (e.restorable === false) continue
      const view = diffFile({ path: e.rel, before: String(e.before ?? ''), after: String(e.after ?? '') })
      const body = (view.hunks ?? [])
        .flatMap((h) =>
          (h.lines ?? []).map((l) => `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${l.text ?? ''}`),
        )
        .join('\n')
      if (body) parts.push(`diff --git a/${e.rel} b/${e.rel}\n${body}`)
    }
    return parts.join('\n')
  } catch {
    return ''
  }
}

/**
 * 渲染给用户看的协作汇报（A / B 各自做了什么，一眼能看出）。
 *
 * ★ 每个数字都来自 `trace` 或两次调用的真实返回；没有的就写「无」。
 * ★ A/B 的显示名由调用方给（plannerLabel / executorLabel），缺省回落旧默认
 *   （Codex CLI / DeepSeek）—— 兼容早期只写死这两个的自检断言。
 *
 * @param {{ plan?: object, planRaw?: string, review?: object, trace?: object,
 *           phases?: object[], error?: object, plannerLabel?: string, executorLabel?: string }} input
 */
function renderReport(input) {
  const { plan, review, trace, phases, error } = input
  const plannerLabel = input.plannerLabel ?? 'Codex CLI'
  const executorLabel = input.executorLabel ?? 'DeepSeek'
  const lines = ['## 双模型协作结果', '']

  lines.push(`### A · ${plannerLabel}（检查 / 规划 / 验收）`)
  if (plan) {
    lines.push(`- 要解决的问题：${plan.problem}`)
    lines.push(`- 允许改的范围：${plan.scope.length > 0 ? plan.scope.join(' / ') : '（未声明）'}`)
    lines.push(`- 预期结果：${plan.expected || '（未声明）'}`)
    lines.push(`- 验证方法：${plan.verify || '（未声明）'}`)
  } else {
    lines.push('- （没有拿到计划）')
  }
  lines.push('')

  lines.push(`### B · ${executorLabel}（执行）`)
  if (trace) {
    lines.push(
      `- 实际改动的文件：${trace.writes.length > 0 ? trace.writes.join(' / ') : '（没有改动任何文件）'}`,
    )
    const t = trace.lastTest
    lines.push(
      t
        ? `- 测试：${t.testId || '(未标注)'} → ${t.status}（退出码 ${t.exitCode ?? '无'}）`
        : '- 测试：没有跑',
    )
    if (trace.executionId) lines.push(`- 执行记录：${trace.executionId}`)
    lines.push(
      `- 工具调用：${trace.tools.map((x) => `${x.name}${x.ok ? '' : '(失败)'}`).join(' → ') || '无'}`,
    )
  } else {
    lines.push('- （执行没有产生可用的痕迹）')
  }
  lines.push('')

  lines.push(`### A · ${plannerLabel}（验收）`)
  if (review) {
    lines.push(`- 结论：**${review.verdict}**`)
    for (const r of review.reasons ?? []) lines.push(`  · ${r}`)
    if ((review.issues ?? []).length > 0) {
      lines.push('- 需要修的问题：')
      for (const i of review.issues) lines.push(`  · ${i}`)
    }
  } else {
    lines.push('- （没有拿到验收结论）')
  }

  if (error) {
    lines.push('', '### 中止原因', `- ${error.code}：${error.message}`)
  }
  if (Array.isArray(phases) && phases.length > 0) {
    lines.push('', `阶段轨迹：${phases.join(' → ')}`)
  }
  return lines.join('\n')
}

module.exports = { WRITE_TOOLS, targetOf, executionIdOf, extractTrace, testPassed, diffOf, renderReport }
