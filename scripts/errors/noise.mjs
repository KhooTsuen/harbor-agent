/**
 * 噪音判定 + 「按设计拒绝」判定 —— 这个文件是本工具能不能用的关键。
 *
 * 为什么：实测数据里 **99.4% 的 ERROR 是内核自检故意制造的**
 * （`data/logs` 497 条 ERROR 里 494 条是 `selftest-*`；`data/audit` 有 29525 条 ok=false，
 * 工具名是 `probe_secret` / `net_probe` / `write_probe` —— 这三个名字**只存在于自检**，
 * 已用「全仓库谁引用了它」核实过）。不过滤的话，这个工具第一天就会被噪音淹没。
 *
 * 两条铁律：
 *   ① **绝不静默丢弃**：每条被过滤的都带原因，CLI 会汇总「过滤了多少、为什么」
 *   ② 规则只写在这里一处（改规则改这里，测试也测这里）
 */
import fs from 'node:fs'
import path from 'node:path'

/** 只存在于自检的「工具名」（用 `git grep` 核实过：正式工具注册表里没有它们） */
const SELFTEST_TOOLS = new Set(['probe_secret', 'net_probe', 'write_probe'])

/** 自检/测试夹具用的路径（真实用户路径不会长这样） */
const SELFTEST_PATHS = [
  /data[\\/]selftest-workspace/i,
  /selftest-workspace/i,
  /test-env[\\/]/i, /* 改名前的旧副本目录，测试脚本在用它 */
]

/** 自检/测试用的会话或任务 id 前缀（实测数据里真的出现过这些） */
const TEST_ID_PREFIX = [/^selftest/i, /^break[-_]/i, /^plugintest/i, /^probe[-_]/i, /^ch16$/i]

/** 消息里带这些字样 = 自检自己造的 */
const SELFTEST_TEXT = [
  /selftest[-_]/i,
  /自检/,
  /探针/,
  /^selftest$/i,
]

/**
 * 「按设计拒绝」：审计里 ok=false 但有大量是**安全机制正常工作**的结果
 * （只读模式拒绝、用户拒绝、风险等级被阻止）。它们不是错误 —— 混进错误清单会误导判断。
 * 实测这些文本占 audit 的大头。
 */
const EXPECTED_DENIAL = [
  /只读模式拒绝/,
  /用户拒绝/,
  /风险等级.*被阻止/,
  /已拒绝执行/,
  /本轮约束禁止/,
  /需要授权/,
]

const hasSelftestPath = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return SELFTEST_PATHS.some((re) => re.test(text))
}

/**
 * 判定一条候选记录的归属。
 * @returns {{ verdict: 'error'|'noise'|'expected_denial', reason?: string }}
 */
export function judge(item) {
  const text = String(item.message ?? '')

  /* ① 自检工具名（只看工具，不看消息 —— 消息里可能恰好提到「探针」） */
  const tool = item.context?.tool
  if (tool && SELFTEST_TOOLS.has(tool)) {
    return { verdict: 'noise', reason: `工具 ${tool} 只存在于自检` }
  }

  /* ② 自检工作目录 / 自检标记（taskId、sessionId、路径、消息） */
  const ctx = item.context ?? {}
  if (hasSelftestPath(ctx.args) || hasSelftestPath(ctx.affectedFiles) || hasSelftestPath(text)) {
    return { verdict: 'noise', reason: '路径落在自检夹具目录' }
  }
  for (const key of ['taskId', 'sessionId']) {
    const v = ctx[key]
    if (typeof v !== 'string' || !v) continue
    if (SELFTEST_TEXT.some((re) => re.test(v))) return { verdict: 'noise', reason: `${key} 带自检标记` }
    if (TEST_ID_PREFIX.some((re) => re.test(v))) return { verdict: 'noise', reason: `${key} 是本仓库的测试夹具 id` }
  }
  for (const re of SELFTEST_TEXT) {
    if (re.test(text)) return { verdict: 'noise', reason: `消息里有自检字样（${re.source}）` }
  }

  /* ③ 按设计的拒绝：不是错误，但也**不是噪音**（要单独统计，别让人以为安全机制没工作） */
  for (const re of EXPECTED_DENIAL) {
    if (re.test(text)) return { verdict: 'expected_denial', reason: '安全机制按设计拒绝' }
  }

  return { verdict: 'error' }
}

/** 审计里「ok=false 但 error 为空」的记录：形状异常，可信度低（单独标出来） */
export function lowTrust(item) {
  return item.source === 'audit' && /没写 error 文本/.test(String(item.message ?? ''))
    ? '审计记录了 ok=false，但没写原因'
    : null
}

/** 数据目录是否存在（不存在就没什么可扫的，CLI 要能优雅处理） */
export function hasDataDir(dataDir) {
  try {
    return fs.statSync(dataDir).isDirectory()
  } catch {
    return false
  }
}

export const rules = { SELFTEST_TOOLS, SELFTEST_TEXT, EXPECTED_DENIAL, SELFTEST_PATHS, TEST_ID_PREFIX, dataDirOf: (p) => path.resolve(p) }
