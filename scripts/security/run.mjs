/**
 * 安全回归套件入口
 *
 *   node scripts/security/run.mjs              # 跑全部 9 个套件，写报告
 *   node scripts/security/run.mjs ipc agent    # 只跑指定套件
 *   node scripts/security/run.mjs --audit      # 只查元数据表（84 项 / 9 套件不重叠）
 *   node scripts/security/run.mjs --gate       # **严格档**：P0 有 FAIL/BLOCKED/NOT_RUN 就非零
 *
 * 产物（`scripts/security/report.mjs`）：
 *   · `security-results.json`  —— 机器读（文档第 11 节契约）
 *   · `security-report.md`     —— 人工审查
 *
 * ── 两个退出码口径，别混 ──
 *   默认：**有任何 FAIL 就是非零**（清单第 10.5 条：安全失败不许被吞掉）。
 *         NOT_RUN 不挡 —— 不然「还没写的用例」会把每一次提交都拦住。
 *   `--gate`：按文档第 12 节的发布门禁，**P0 不得 FAIL / BLOCKED / NOT_RUN**。
 *         这个档用在发布前；平时 `verify` 挂的是默认档。
 */

import { CASES, SUITES } from './cases.mjs'
import { settle, STATUS } from './harness.mjs'
import { cleanup, prepare, ROOT } from './sandbox.mjs'
import { build, writeJson, writeMarkdown } from './report.mjs'
import path from 'node:path'

const argv = process.argv.slice(2)
const wantSuite = argv.filter((a) => !a.startsWith('--'))
const auditOnly = argv.includes('--audit')
const gate = argv.includes('--gate')
const jsonPath =
  (argv.find((a) => a.startsWith('--json=')) ?? '').slice(7) ||
  path.join(ROOT, 'security-results.json')
/* 文档第 11 节建议的人工审查版文件名就是 security-report.md，别跟着 json 名走 */
const mdPath =
  (argv.find((a) => a.startsWith('--md=')) ?? '').slice(5) ||
  path.join(ROOT, 'security-report.md')

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

/** P0 里每一个不是 PASS 的（FAIL / BLOCKED / NOT_RUN 都算）—— 严格门禁的判据 */
function p0NotPassing(report) {
  return report.cases.filter((c) => c.priority === 'P0' && c.status !== STATUS.PASS)
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
  globalThis.__harborSecurityStartedAt = new Date().toISOString()
  try {
    for (const name of toRun) {
      console.log(`\n════ security:${name} ════`)
      const mod = await import(new URL(`./suites/${name}.mjs`, import.meta.url))
      await mod.run()
    }
  } finally {
    settle()
    const { report, summary, coverage } = build({ jsonPath })
    writeJson(report, jsonPath)
    writeMarkdown(report, mdPath)
    cleanup()

    const p0bad = p0NotPassing(report)
    console.log('\n════════════════════════════════')
    console.log(`  用例实现率 ${(coverage.implementedRate * 100).toFixed(1)}%` +
      `（${coverage.implemented}/${coverage.total}）`)
    console.log(`  实际执行率 ${(coverage.executedRate * 100).toFixed(1)}%` +
      `（${coverage.executed}/${coverage.total}）`)
    console.log(`  通过率 ${coverage.passRate === null ? '—' : (coverage.passRate * 100).toFixed(1) + '%'}` +
      `（分母 PASS+FAIL=${coverage.executed}）`)
    console.log(`  未通过用例数（漏洞数）：${coverage.vulnerabilities}`)
    console.log(`  PASS ${summary.pass} · FAIL ${summary.fail} · BLOCKED ${summary.blocked}` +
      ` · N/A ${summary.notApplicable} · NOT_RUN ${summary.notRun}`)
    console.log(`  报告：${path.relative(ROOT, jsonPath)} + ${path.relative(ROOT, mdPath)}`)
    if (summary.fail > 0) {
      console.log('\n  失败清单：')
      for (const c of report.cases.filter((x) => x.status === STATUS.FAIL)) {
        console.log(`    · ${c.id} ${c.observed}`)
      }
    }
    if (p0bad.length) {
      console.log(`\n  ⚠ P0 未 PASS：${p0bad.map((c) => `${c.id}(${c.status})`).join(' ')}`)
      if (gate) console.log('  ⛔ --gate：P0 未全部 PASS → 发布门禁不通过')
    }
    console.log('════════════════════════════════\n')

    /*
     * 退出码：默认只挡 FAIL（不然 NOT_RUN 一多，每次提交都被拦）。
     * --gate 时按文档第 12 节，P0 不许有任何非 PASS。
     */
    if (gate) process.exit(p0bad.length > 0 || summary.fail > 0 ? 1 : 0)
    process.exit(summary.fail > 0 ? 1 : 0)
  }
}

main()
