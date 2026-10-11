/**
 * 门禁负例验证 —— 《安全测试有效性审计》Phase D
 *
 * 用合成报告喂**真实门禁判据**（`scripts/security/gate.mjs`，与 run.mjs 共用同一处实现），
 * 验证 8 类异常都被挡；再 spawn 级验证「套件抛异常」不会变成 PASS。不写正式结果文件。
 *
 *   node scripts/security/mutation/gate-negative.mjs
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CASES } from '../cases.mjs'
import { securityExitCode, gateProblems } from '../gate.mjs'
import { makeWorktree, ROOT, WT } from './worktree.mjs'

function fullPass() {
  return { schemaVersion: '1.0', cases: CASES.map((c) => ({ id: c.id, priority: c.priority, status: c.id === 'SEC-081' ? 'NOT_APPLICABLE' : 'PASS' })) }
}
const withStatus = (id, status) => {
  const r = fullPass()
  r.cases.find((c) => c.id === id).status = status
  return r
}

const cases = []
const check = (name, expectNonZero, report, summary, gate) => {
  const code = securityExitCode(report, summary, gate)
  const ok = (code !== 0) === expectNonZero
  const g = gateProblems(report)
  cases.push({ name, gate, expectNonZero, actualExit: code, verdict: ok ? 'PASS' : 'FAIL', detail: `bad=${g.bad.map((b) => `${b.id}:${b.status}`).join(',')} missing=${g.missing.length} dup=${g.dup.join(',')}` })
  console.log(`${ok ? '✅' : '❌'} ${name}  gate=${gate}  exit=${code}  (期望${expectNonZero ? '非零' : '零'})`)
}

check('B-1 全 PASS → 门禁通过', false, fullPass(), { fail: 0 }, true)
check('B-2 全 PASS → 默认档零', false, fullPass(), { fail: 0 }, false)
check('D-1 P0 FAIL → 非零', true, withStatus('SEC-001', 'FAIL'), { fail: 1 }, true)
check('D-2 P0 BLOCKED → 非零', true, withStatus('SEC-001', 'BLOCKED'), { fail: 0 }, true)
check('D-3 P0 NOT_RUN → 非零', true, withStatus('SEC-001', 'NOT_RUN'), { fail: 0 }, true)
{
  const r = fullPass()
  r.cases = r.cases.filter((c) => c.id !== 'SEC-001')
  check('D-4a P0 条目缺失 → 非零', true, r, { fail: 0 }, true)
}
{
  const r = fullPass()
  r.cases = [...r.cases, { id: 'SEC-001', priority: 'P0', status: 'PASS' }]
  check('D-4b id 重复 → 非零', true, r, { fail: 0 }, true)
}
check('D-4c 未知状态 → 非零', true, withStatus('SEC-001', 'WEIRD'), { fail: 0 }, true)
check('X-1 默认档 P0 NOT_RUN 不挡（设计如此）', false, withStatus('SEC-001', 'NOT_RUN'), { fail: 0 }, false)
check('X-2 默认档 P1 FAIL 也挡', true, withStatus('SEC-081', 'FAIL'), { fail: 1 }, false)

/* 套件抛异常：spawn 级（在隔离副本里让一个套件 import 失败） */
makeWorktree()
const probe = join(WT, 'scripts', 'security', 'suites', 'static.mjs')
const backup = readFileSync(probe, 'utf8')
writeFileSync(probe, "throw new Error('audit-injected-suite-crash')\n" + backup)
try {
  for (const gate of [false, true]) {
    const r = spawnSync('node', ['scripts/security/run.mjs', ...(gate ? ['--gate'] : []), 'static'], { cwd: WT, encoding: 'utf8', timeout: 120000 })
    const ok = r.status !== 0
    cases.push({ name: `D-5 套件抛异常（${gate ? 'gate' : '默认'}档）→ 必须非零`, gate, expectNonZero: true, actualExit: r.status, verdict: ok ? 'PASS' : 'FAIL', detail: '' })
    console.log(`${ok ? '✅' : '❌'} D-5 套件抛异常（${gate ? 'gate' : '默认'}档）  exit=${r.status}`)
  }
} finally {
  writeFileSync(probe, backup)
}

const summary = { total: cases.length, pass: cases.filter((c) => c.verdict === 'PASS').length, fail: cases.filter((c) => c.verdict === 'FAIL').length }
mkdirSync(join(ROOT, 'data', 'audit-logs'), { recursive: true })
writeFileSync(join(ROOT, 'data', 'audit-logs', 'gate-negative.json'), JSON.stringify({ cases, summary }, null, 2))
console.log(`\n门禁负例：${summary.pass}/${summary.total} 通过`)
if (summary.fail > 0) process.exit(1)
