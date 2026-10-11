/**
 * 安全回归套件入口
 *
 *   node scripts/security/run.mjs              # 跑全部 9 个套件，写报告
 *   node scripts/security/run.mjs ipc agent    # 只跑指定套件
 *   node scripts/security/run.mjs --audit      # 只查元数据表（84 项 / 9 套件不重叠）
 *
 * 产物：`security-results.json`（文档第 11 节契约）+ 终端摘要。
 * 退出码：**有任何 FAIL 就是非零**（清单第 10.5 条：安全失败不许被吞掉）。
 * BLOCKED / NOT_RUN 不算通过 —— 发布门禁要求「适用的 P0 全部 PASS」。
 */

import { CASES, SUITES } from './cases.mjs'
import { mark, resultOf, settle, STATUS } from './harness.mjs'
import { cleanup, prepare, ROOT } from './sandbox.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const wantSuite = argv.filter((a) => !a.startsWith('--'))
const auditOnly = argv.includes('--audit')
const jsonPath = (argv.find((a) => a.startsWith('--json=')) ?? '').slice(7) ||
  path.join(ROOT, 'security-results.json')

/** 元数据自检：id 唯一、9 套件不重叠覆盖 84 项、每项都有期望文案 */
function audit() {
  const problems = []
  const ids = new Set()
  const perSuite = Object.fromEntries(SUITES.map((s) => [s, 0]))
  for (const c of CASES) {
    if (ids.has(c.id)) problems.push(`重复编号：${c.id}`)
    ids.add(c.id)
    if (!SUITES.includes(c.suite)) problems.push(`${c.id} 的套件名非法：${c.suite}`)
    else perSuite[c.suite] += 1
    if (!c.expect || !c.title) problems.push(`${c.id} 缺标题或断言文案`)
  }
  for (let i = 1; i <= 84; i += 1) {
    const id = `SEC-${String(i).padStart(3, '0')}`
    if (!ids.has(id)) problems.push(`缺少 ${id}`)
  }
  console.log('\n── 元数据自检 ──')
  console.log(`  共 ${CASES.length} 项，${SUITES.length} 个套件`)
  for (const s of SUITES) console.log(`  · ${s.padEnd(11)} ${perSuite[s]} 项`)
  if (problems.length) {
    for (const p of problems) console.log(`  ❌ ${p}`)
    return 1
  }
  console.log('  ✅ 84 项齐、编号唯一、套件不重叠')
  return 0
}

function commit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function suiteFile(name) {
  return `scripts/security/suites/${name}.mjs`
}

function writeReport() {
  const cases = CASES.map((c) => {
    const r = resultOf(c.id)
    return {
      id: c.id,
      priority: c.priority,
      status: r.status,
      testFile: r.status === STATUS.NOT_RUN ? null : suiteFile(c.suite),
      expected: c.expect,
      observed: r.observed || null,
      evidencePaths: r.evidence,
      notes: '',
    }
  })
  const summary = { pass: 0, fail: 0, blocked: 0, notRun: 0 }
  for (const c of cases) {
    if (c.status === STATUS.PASS) summary.pass += 1
    else if (c.status === STATUS.FAIL) summary.fail += 1
    else if (c.status === STATUS.BLOCKED) summary.blocked += 1
    else summary.notRun += 1
  }
  const report = {
    schemaVersion: '1.0',
    commit: commit(),
    environment: { os: process.platform, mode: 'isolated-test' },
    cases,
    summary,
  }
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')
  return { report, summary }
}

async function main() {
  if (auditOnly) process.exit(audit())
  const rc = audit()
  if (rc !== 0) process.exit(rc)

  const toRun = wantSuite.length ? wantSuite : SUITES
  for (const name of toRun) {
    if (!SUITES.includes(name)) {
      console.log(`\n未知套件：${name}（可用：${SUITES.join(' / ')}）`)
      process.exit(2)
    }
  }

  prepare()
  try {
    for (const name of toRun) {
      console.log(`\n════ security:${name} ════`)
      const mod = await import(new URL(`./suites/${name}.mjs`, import.meta.url))
      await mod.run()
    }
  } finally {
    settle()
    const { report, summary } = writeReport()
    cleanup()
    const applicable = report.cases.filter((c) => c.status !== STATUS.NOT_RUN)
    const p0 = report.cases.filter((c) => c.priority === 'P0')
    const p0Bad = p0.filter((c) => c.status !== STATUS.PASS)
    console.log('\n════════════════════════════════')
    console.log(`  已实现 ${applicable.length} / ${CASES.length} 项`)
    console.log(`  PASS ${summary.pass} · FAIL ${summary.fail} · BLOCKED ${summary.blocked} · NOT_RUN ${summary.notRun}`)
    console.log(`  报告：${path.relative(ROOT, jsonPath)}`)
    if (report.cases.some((c) => c.status === STATUS.FAIL)) {
      console.log('\n  失败清单：')
      for (const c of report.cases.filter((x) => x.status === STATUS.FAIL)) {
        console.log(`    · ${c.id} ${c.observed}`)
      }
    }
    if (p0Bad.length) {
      console.log(`\n  ⚠ 未通过/未跑的 P0：${p0Bad.map((c) => `${c.id}(${c.status})`).join(' ')}`)
    }
    console.log('════════════════════════════════\n')
    process.exit(summary.fail > 0 ? 1 : 0)
  }
}

main()
