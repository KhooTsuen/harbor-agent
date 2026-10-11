/**
 * 安全回归：报告产物（机器读 + 人读）
 *
 * 从 `run.mjs` 拆出来的 —— 那边管「怎么跑」，这里管「怎么落成两份报告」。
 * 对齐《自动化安全测试清单》：
 *   · 第 11 节：`security-results.json`（schemaVersion / commit / environment / cases / summary）
 *                + `security-report.md`（人工审查版）
 *   · 第 12 节：结果附 **commit + 时间戳**；覆盖率按**三口径**分开算；
 *                漏洞数与通过率**分开报告**（严禁合成一个「安全评分」）
 *   · 第 0 节：每个用例记 Case ID / commit / 系统 / 执行命令 / 预期 / 实际 / 日志位置 /
 *                测试数据 / 结论 / 复现步骤
 *
 * 时间戳在**调用这一刻**取（不是模块加载时）—— `run.mjs` 在跑完套件后调用它。
 */

import { CASES, SUITES } from './cases.mjs'
import { resultOf, STATUS } from './harness.mjs'
import { ROOT } from './sandbox.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 当前 commit（拿不到就空串 —— 报告里如实留空，不编一个） */
export function commitOf() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** 跑一个套件的命令（报告里每用例附上，供复现） */
export function commandOf(suite) {
  return `node scripts/security/run.mjs ${suite}`
}

function relative(target) {
  try {
    return path.relative(ROOT, target).replace(/\\/g, '/')
  } catch {
    return target
  }
}

/**
 * 组装 JSON 报告对象（同时喂给 Markdown 那份，避免两边各算一套）。
 * @returns {{ report: object, summary: object, coverage: object }}
 */
export function build({ jsonPath }) {
  const started = globalThis.__harborSecurityStartedAt ?? ''
  const cases = CASES.map((c) => {
    const r = resultOf(c.id)
    const notRun = r.status === STATUS.NOT_RUN
    return {
      id: c.id,
      priority: c.priority,
      status: r.status,
      durationMs: r.durationMs,
      testFile: notRun ? null : `scripts/security/suites/${c.suite}.mjs`,
      expected: c.expect,
      observed: r.observed || null,
      /* 证据路径：套件里登记的具体文件；没有就给隔离区（文档第 0 节「日志位置」） */
      evidencePaths: r.evidence.length ? r.evidence : [],
      /* 执行命令 + 复现步骤（文档第 0 节要求每用例都记） */
      command: notRun ? null : commandOf(c.suite),
      repro: notRun ? '未实现：留作下一批' : `在隔离环境跑 ${commandOf(c.suite)}，看 ${c.id} 那一行`,
      notes: notRun ? '待实现（下一批）' : '',
    }
  })

  const summary = { pass: 0, fail: 0, blocked: 0, notApplicable: 0, notRun: 0 }
  for (const c of cases) {
    if (c.status === STATUS.PASS) summary.pass += 1
    else if (c.status === STATUS.FAIL) summary.fail += 1
    else if (c.status === STATUS.BLOCKED) summary.blocked += 1
    else if (c.status === STATUS.NOT_APPLICABLE) summary.notApplicable += 1
    else summary.notRun += 1
  }

  /*
   * 覆盖率三口径（文档第 12 节）—— 各算各的，不合并：
   *   实现率 = 有断言的适用项 / 适用项
   *   执行率 = 真跑过（PASS 或 FAIL）的适用项 / 适用项
   *   通过率 = PASS / (PASS + FAIL)   ← 分母不含 NOT_RUN，所以高通过率骗不了人
   */
  const total = cases.length
  const implemented = cases.filter((c) => c.status !== STATUS.NOT_RUN).length
  const executed = summary.pass + summary.fail
  const byPriority = {}
  for (const p of ['P0', 'P1', 'P2']) {
    const group = cases.filter((c) => c.priority === p)
    byPriority[p] = {
      total: group.length,
      pass: group.filter((c) => c.status === STATUS.PASS).length,
      fail: group.filter((c) => c.status === STATUS.FAIL).length,
      blocked: group.filter((c) => c.status === STATUS.BLOCKED).length,
      notRun: group.filter((c) => c.status === STATUS.NOT_RUN).length,
    }
  }
  const coverage = {
    total,
    implemented,
    implementedRate: total ? +(implemented / total).toFixed(3) : 0,
    executed,
    executedRate: total ? +(executed / total).toFixed(3) : 0,
    /* 分母是「跑过的」，不是 84 —— 见上 */
    passRate: executed ? +(summary.pass / executed).toFixed(3) : null,
    /* ★ 漏洞数**单列**：文档第 12 节禁止把「漏洞数」和「通过率」合成一个安全评分 */
    vulnerabilities: summary.fail,
    byPriority,
  }

  const report = {
    schemaVersion: '1.0',
    commit: commitOf(),
    timestamp: new Date().toISOString(),
    startedAt: started || null,
    environment: { os: process.platform, node: process.version, mode: 'isolated-test' },
    cases,
    coverage,
    summary,
  }
  void jsonPath
  return { report, summary, coverage }
}

/** 写 `security-results.json`（机器读） */
export function writeJson(report, jsonPath) {
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')
}

const ICON = {
  PASS: '✅',
  FAIL: '❌',
  BLOCKED: '⛔',
  NOT_APPLICABLE: '➖',
  NOT_RUN: '⏸',
}

/**
 * 写 `security-report.md`（人工审查）—— 只从**同一份** report 生成，
 * 所以 Markdown 与 JSON 的结论结构上不可能打架。
 */
export function writeMarkdown(report, mdPath) {
  const { coverage, summary } = report
  const lines = []
  lines.push('# Harbor 安全回归报告')
  lines.push('')
  lines.push('> 本文件由 `npm run security` 自动生成，请勿手改 —— 手改会在下次运行时被覆盖。')
  lines.push('')
  lines.push(`- **commit**：\`${report.commit || '（拿不到）'}\``)
  lines.push(`- **时间戳**：${report.timestamp}`)
  lines.push(`- **环境**：${report.environment.os} · node ${report.environment.node} · ${report.environment.mode}`)
  lines.push('')
  lines.push('## 结论')
  lines.push('')
  lines.push('| 指标 | 值 | 口径 |')
  lines.push('|---|---|---|')
  lines.push(`| 用例实现率 | ${(coverage.implementedRate * 100).toFixed(1)}%（${coverage.implemented}/${coverage.total}） | 有断言的适用项 / 全部适用项 |`)
  lines.push(`| 实际执行率 | ${(coverage.executedRate * 100).toFixed(1)}%（${coverage.executed}/${coverage.total}） | 跑过（PASS 或 FAIL）/ 全部适用项 |`)
  lines.push(`| 通过率 | ${coverage.passRate === null ? '—（一项未跑）' : (coverage.passRate * 100).toFixed(1) + '%'} | PASS / (PASS + FAIL)，分母不含 NOT_RUN |`)
  lines.push(`| **未通过用例数（漏洞数）** | **${coverage.vulnerabilities}** | FAIL 计数，单列，不与通过率合并 |`)
  lines.push('')
  lines.push('> ⚠️ 通过率的分母**不含 NOT_RUN** —— 跑一项过一项也会显示 100%，此时请看左边两列。')
  lines.push('')
  lines.push('## 按优先级')
  lines.push('')
  lines.push('| 优先级 | 总数 | PASS | FAIL | BLOCKED | NOT_RUN |')
  lines.push('|---|---|---|---|---|---|')
  for (const p of ['P0', 'P1', 'P2']) {
    const g = coverage.byPriority[p]
    lines.push(`| ${p} | ${g.total} | ${g.pass} | ${g.fail} | ${g.blocked} | ${g.notRun} |`)
  }
  lines.push(`| 合计 | ${coverage.total} | ${summary.pass} | ${summary.fail} | ${summary.blocked} | ${summary.notRun} |`)
  lines.push('')
  const p0bad = report.cases.filter((c) => c.priority === 'P0' && c.status !== STATUS.PASS)
  lines.push('## 发布门禁（文档第 12 节）')
  lines.push('')
  if (p0bad.length === 0) {
    lines.push('- ✅ 所有适用的 P0 用例均已运行且 PASS —— **门禁满足**。')
  } else {
    lines.push(`- ❌ **门禁未满足**：P0 里有 ${p0bad.length} 项不是 PASS（不得 FAIL / BLOCKED / NOT_RUN）。`)
    lines.push(`  - 清单：${p0bad.map((c) => `${c.id}(${c.status})`).join('、')}`)
    lines.push('  - `npm run security:gate` 会因此返回非零；`npm run verify` 只挡 FAIL（不挡 NOT_RUN）。')
  }
  lines.push('')
  lines.push('## 用例明细')
  lines.push('')
  lines.push('| ID | 优先级 | 状态 | 耗时(ms) | 实测 |')
  lines.push('|---|---|---|---|---|')
  for (const c of report.cases) {
    const obs = (c.observed ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')
    lines.push(`| ${c.id} | ${c.priority} | ${ICON[c.status] ?? ''} ${c.status} | ${c.durationMs ?? '—'} | ${obs} |`)
  }
  lines.push('')
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
}

/** 九个建议套件名 → 本仓实际脚本名（文档第 9 节的别名由 package.json 承载，这里只说明） */
export const SUGGESTED_SUITES = SUITES.map((s) => `security:${s}`)
