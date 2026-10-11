/**
 * 发布门禁判据（从 `run.mjs` 抽出来，供执行器与审计夹具共用）
 *
 * 为什么单独成文件：`run.mjs` 顶层会 self-execute，import 它等于直接跑一遍套件；
 * 而门禁负例测试（有效性审计 Phase D）只需要**判据函数**，喂合成报告即可。
 * 判据只有这一处 —— run.mjs 和审计夹具都从这里取，避免两套实现漂移。
 *
 * 依据《Harbor Agent 自动化安全测试清单》第 12 节：适用的 P0 不得 FAIL / BLOCKED /
 * NOT_RUN，也不得缺失或重复。默认档只挡 FAIL（不然「还没写的用例」会拦住每次提交）。
 */

import { CASES } from './cases.mjs'

const PASS = 'PASS'

/** P0 里每一个不是 PASS 的（FAIL / BLOCKED / NOT_RUN / 任何未知状态都算） */
export function p0NotPassing(report) {
  const cases = Array.isArray(report?.cases) ? report.cases : []
  return cases.filter((c) => c.priority === 'P0' && c.status !== PASS)
}

/**
 * 严格门禁要挡的三件事：P0 非 PASS、P0 缺失、id 重复。
 * 「缺失」不能只看 report.cases 自己 —— 用 CASES 定义反查，报告里少了谁才看得见。
 */
export function gateProblems(report) {
  const cases = Array.isArray(report?.cases) ? report.cases : []
  const counts = new Map()
  for (const c of cases) counts.set(c.id, (counts.get(c.id) ?? 0) + 1)
  const dup = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
  const ids = new Set(cases.map((c) => c.id))
  const missing = CASES.filter((c) => c.priority === 'P0' && !ids.has(c.id)).map((c) => c.id)
  const bad = p0NotPassing(report)
  return { bad, missing, dup, ok: bad.length === 0 && missing.length === 0 && dup.length === 0 }
}

/**
 * 退出码。`--gate` 按第 12 节（P0 不许任何非 PASS / 缺失 / 重复，且无任何 FAIL）；
 * 默认档只挡 FAIL（清单第 10.5 条：安全失败不许被吞掉）。
 */
export function securityExitCode(report, summary, gate) {
  const g = gateProblems(report)
  const fail = Number(summary?.fail ?? 0)
  if (gate) return g.ok && fail === 0 ? 0 : 1
  return fail > 0 ? 1 : 0
}
