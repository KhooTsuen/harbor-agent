/**
 * 安全套件：断言与结果收集
 *
 * 和 `scripts/selftest/harness.mjs` 的差别：那个只有「过 / 不过」两态，
 * 而安全清单要求 **NOT_RUN / PASS / FAIL / BLOCKED / NOT_APPLICABLE** 五态，
 * 并且每项要带 observed（实测到什么）与 evidence（证据路径/数字）——
 * 「未执行不能算 PASS」这条硬规矩得靠状态机在结构上保证，而不是靠人记。
 *
 * 一个 case 可以有多条断言：**全过才 PASS，一条不过就 FAIL**。
 * 一条断言都没跑的 case 保持 NOT_RUN（永远不会被误报成 PASS）。
 */

const STATUS = {
  NOT_RUN: 'NOT_RUN',
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
}

/** id -> { assertions, failed: string[], evidence: string[], status, observed } */
const state = new Map()

function slot(id) {
  let s = state.get(id)
  if (!s) {
    s = { assertions: 0, failed: [], evidence: [], status: STATUS.NOT_RUN, observed: '' }
    state.set(id, s)
  }
  return s
}

/** 跑一条断言。`ok` 为假时该项最终 FAIL；`evidence` 在半数情况下也当证据留档 */
export function sec(id, ok, evidence = '') {
  const s = slot(id)
  s.assertions += 1
  if (ok) {
    if (evidence) s.evidence.push(evidence)
    console.log(`  ✅ ${id}  ${evidence}`)
  } else {
    s.failed.push(evidence || '断言不成立')
    console.log(`  ❌ ${id}  ${evidence}`)
  }
}

/** 直接落定一个非「断言」状态（BLOCKED / NOT_APPLICABLE / 由外部 runner 承载的结果） */
export function mark(id, status, observed = '', evidence = []) {
  const s = slot(id)
  s.status = status
  s.observed = observed
  if (evidence.length) s.evidence.push(...evidence)
  const icon = status === STATUS.PASS ? '✅'
    : status === STATUS.BLOCKED ? '⛔'
      : status === STATUS.NOT_APPLICABLE ? '➖'
        : status === STATUS.NOT_RUN ? '⏸' : '❌'
  console.log(`  ${icon} ${id}  ${status}${observed ? ` · ${observed}` : ''}`)
}

/** 该记一条「环境不支持」的，带原因（BLOCKED 绝不等于 PASS） */
export function blocked(id, why) {
  mark(id, STATUS.BLOCKED, why)
}

/** 计分：把断言数折算成状态。**任何一条断言失败 → FAIL**（哪怕之前被 mark 成 PASS） */
export function settle() {
  for (const [id, s] of state) {
    if (s.failed.length > 0) {
      s.status = STATUS.FAIL
      s.observed = s.failed.join('；')
      continue
    }
    if (s.status === STATUS.NOT_RUN && s.assertions > 0) {
      s.status = STATUS.PASS
      s.observed = s.observed || `${s.assertions} 条断言通过`
    }
  }
}

export function resultOf(id) {
  const s = state.get(id)
  if (!s) return { status: STATUS.NOT_RUN, observed: '', evidence: [] }
  return { status: s.status, observed: s.observed, evidence: s.evidence }
}

export function allIds() {
  return [...state.keys()]
}

export function reset() {
  state.clear()
}

export { STATUS }
