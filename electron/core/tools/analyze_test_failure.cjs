/**
 * 本地工具 `analyze_test_failure`（2026-10-17 · 3B-1）
 *
 * ── 它做什么 ──────────────────────────────────────────────────
 *
 * 「刚才那次测试为什么挂、该看哪个文件、可能怎么改」。**只读**：
 * 按 id 取已有执行快照 → 规则诊断 → 按需读项目源码片段 → 可选 diff 预览。
 * **不重新跑测试**（B11），**不写任何文件**。
 *
 * ── ★ 参数里没有任何可执行的东西 ──────────────────────────────
 *
 * `parameters` 只有：
 *   · `executionId` / `testId` —— 指定**哪一次**执行（status 从快照读，不由调用方声明）
 *   · `files`  —— 想看哪几个**相对路径**（绝对路径与 `..` 一律拒）
 *   · `proposals` —— 具体的拟议修改（用于算 diff，**不写盘**）
 *
 * 没有 command、没有 shell、没有可执行入口 —— 这是它和 `run_shell` 的根本区别。
 *
 * ── 与 Codex 路径的关系 ───────────────────────────────────────
 *
 * Codex 走 MCP 的 `harbor_analyze_test_failure`，复用同一个执行段
 * （`core/project-test-analyze.cjs` + `-source.cjs` + `-history.cjs`）。
 * 本文件只做参数形状收紧与文案包装，不含判据（硬约束 9）。
 *
 * ⚠️ 它仍是**只读工具**：不进 WRITE_TOOLS / MUTATING_TOOLS（「只分析」那一轮
 * 应该允许它 —— 它正是用来分析的）。
 */

const path = require('node:path')

/** 一次最多看几个文件 / 给几条拟议修改（防上下文膨胀） */
const MAX_FILES = 6
const MAX_PROPOSALS = 4
/** 拟议内容长度上限 */
const MAX_TEXT = 40_000

/** 收一个路径：只要是字符串就留着，越界由取证层判（这里只管形状） */
function cleanFiles(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const one of input.slice(0, MAX_FILES)) {
    if (typeof one === 'string' && one.trim()) out.push({ rel: one.trim() })
    else if (one && typeof one === 'object' && typeof one.rel === 'string' && one.rel.trim()) {
      out.push({ rel: one.rel.trim(), line: Number(one.line) || 0 })
    }
  }
  return out
}

/** 收一条拟议修改：path + before + after 三个字符串，别的字段丢掉 */
function cleanProposals(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const one of input.slice(0, MAX_PROPOSALS)) {
    if (!one || typeof one !== 'object') continue
    const p = typeof one.path === 'string' ? one.path.trim() : ''
    if (!p) continue
    const before = typeof one.before === 'string' ? one.before.slice(0, MAX_TEXT) : null
    const after = typeof one.after === 'string' ? one.after.slice(0, MAX_TEXT) : null
    if (before === null || after === null) continue
    out.push({ path: p, before, after, note: typeof one.note === 'string' ? one.note.slice(0, 300) : '' })
  }
  return out
}

module.exports = {
  name: 'analyze_test_failure',

  description:
    '分析**已经执行过**的项目测试失败结果：给出已确认事实、规则诊断推测、未知项、建议检查的文件、修复建议，' +
    '并在证据足够时给出 unified diff 预览（**仅预览，不写盘**）。' +
    '不会重新执行测试。只能给 executionId 或 testId，不能自己声明状态。' +
    '结果明确区分「事实 / 推测 / 未知」，且属于**规则诊断**（不涉及模型推理）。',
  parameters: {
    type: 'object',
    properties: {
      executionId: { type: 'string', description: '要分析的那次执行 id（run_project_test 结果里的 executionId）' },
      testId: { type: 'string', description: '不给 executionId 时，分析这个测试条目**最近一次**执行' },
      files: {
        type: 'array',
        description: '想读哪几个文件（**项目内相对路径**；绝对路径与 .. 会被拒）',
        items: { type: 'string' },
      },
      proposals: {
        type: 'array',
        description: '具体的拟议修改（仅用于算 diff 预览，不写盘；没有就别传）',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '项目内相对路径' },
            before: { type: 'string', description: '修改前的内容（必须真的来自读到的源码）' },
            after: { type: 'string', description: '修改后的内容' },
            note: { type: 'string', description: '这处修改为什么这么改' },
          },
          required: ['path', 'before', 'after'],
        },
      },
    },
    required: [],
  },

  async run(args, ctx) {
    const history = require('../project-test-history.cjs')
    const analyze = require('../project-test-analyze.cjs')
    const source = require('../project-test-analyze-source.cjs')

    /* ① 取快照：executionId 优先，其次 testId 的最近一次。**取不到就明确说** */
    const executionId = String(args?.executionId ?? '').trim()
    const testId = String(args?.testId ?? '').trim()
    let snap = executionId ? history.get(executionId) : null
    if (!snap && !executionId && testId) snap = history.latest(testId)

    if (!snap) {
      const recent = history.listRecent(5)
      const lines = ['错误：找不到可分析的执行记录。']
      if (executionId) lines.push(`给了 executionId=${executionId}，但历史里没有这一条。`)
      else if (testId) lines.push(`条目 ${testId} 还没有任何执行记录。`)
      else lines.push('没给 executionId 也没给 testId。')
      lines.push('', '最近的执行记录：')
      if (recent.length === 0) lines.push('- （一条都没有 —— 先跑一次 run_project_test）')
      else for (const r of recent) lines.push(`- ${r.executionId}  ${r.testId}  ${r.status}  ${r.at}`)
      lines.push('', '分析只能针对**真实执行过**的结果，不接受自己声明的状态。')
      return lines.join('\n')
    }

    /* ② 项目根必须是快照里记的那个（**不接受调用方另给一个**），且现在仍需被授权读 */
    const projectRoot = String(snap.projectRoot ?? '')
    const roots = require('../project-roots.cjs')
    const granted = projectRoot
      ? roots.resolveAuthorizedRoot({
          root: projectRoot,
          isoDir: require('../paths.cjs').DIRS.data,
          items: require('../project-tests.cjs').load().items,
          action: 'read',
        })
      : { ok: false, message: '这次执行记录里没有项目根' }
    const sources =
      projectRoot && granted.ok === true ? source.readMany(projectRoot, cleanFiles(args?.files)) : []

    /* ③ 分析（规则诊断，不调模型） */
    const analysis = analyze.buildAnalysis({
      snapshot: snap,
      sources,
      proposals: cleanProposals(args?.proposals),
    })

    /* ④ 没读到源码时把原因说清楚（否则 unknowns 里只会说"没读到"，看不出是被拒了） */
    const why = !projectRoot
      ? '这次执行记录里没有项目根'
      : granted.ok === false
        ? `这个项目根当前没有被授权读取（${granted.message}）`
        : ''
    const text = why ? `${analyze.renderText(analysis)}\n\n⚠️ 没有读任何源码：${why}。` : analyze.renderText(analysis)

    return { text, toolOk: true }
  },

  summarize(args) {
    const id = String(args?.executionId ?? '').trim()
    const t = String(args?.testId ?? '').trim()
    if (id) return `分析测试失败：${id}`
    if (t) return `分析测试失败：${t}（最近一次）`
    return '分析测试失败（未指定）'
  },
}
