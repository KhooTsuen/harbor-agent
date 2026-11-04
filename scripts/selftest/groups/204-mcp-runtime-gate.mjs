/**
 * 自检 / 204 —— MCP 工具受本轮运行时约束管辖（C-2）
 *
 * 起因（2026-11-04 动态探针）：`tools/index.cjs` 的 MCP 分支在**函数开头**就
 * `return` 了，而 `allowTools` / `allowWrite` / `allowNetwork` 三道闸在它后面几十行。
 * 结果三种约束下 `mcp.callTool()` 的实际调用次数**都是 1** —— 被禁止的操作真的执行了。
 * 另外 `permission === 'ask'` 而 `ctx.confirm` 不存在时，旧代码直接往下执行
 * （没有确认通道 = 静默放行）。
 *
 * ★ 本组的判据是**调用计数**，不是文案。只断言「返回里有没有『拒绝』两个字」的话，
 *   一个「先拒了又照跑」的实现照样能全绿 —— 那正是这次的病。
 *   每一条拒绝都同时钉两件事：`calls === 0`（真的没执行）**和**审计 `ok:false`
 *   （没有虚假的成功记录）。两者**分别断言**，不混成一个计数。
 *
 * ★ 全程用假 MCP（`mcpCore.callTool` 换成计数器）与隔离沙箱（`SANDBOX`），
 *   不连真服务器、不碰真凭据。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, readFileSync, require } from '../env.mjs'

const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
const mcpCore = require(join(ROOT, 'electron/core/mcp.cjs'))
const auditCore = require(join(ROOT, 'electron/core/audit.cjs'))
const gate = require(join(ROOT, 'electron/core/tools/mcp-gate.cjs'))

/** 只要带 `mcp__` 前缀就会走 MCP 分支，不需要真注册一个服务器 */
const MCP_TOOL = 'mcp__selftest__probe'
const FAKE_RESULT = 'ok-from-fake-mcp'

/**
 * 跑一次 `tools.execute`，MCP 调用与审计都换成探针。
 *
 * @param {object} override 覆盖 ctx 的字段（`permission` / `allowWrite` / `confirm` …）
 * @returns {Promise<{ text: string, calls: number, audits: object[] }>}
 *   `calls` = 假 `mcp.callTool` 被真正执行的次数（**本组的主要判据**）
 */
async function probe(override = {}) {
  const originalCall = mcpCore.callTool
  const originalRecord = auditCore.record
  let calls = 0
  const audits = []
  mcpCore.callTool = async () => {
    calls += 1
    return FAKE_RESULT
  }
  auditCore.record = (entry) => {
    audits.push(entry)
  }
  try {
    const text = await tools.execute(MCP_TOOL, { probe: true }, {
      workdir: SANDBOX,
      permission: 'full',
      sessionId: 'selftest-mcp-runtime-gate',
      /* 每次给新的 Map：`approvals.ask` 会按 kind 记忆 2 分钟，复用会让后一个用例白嫖前一个的批准 */
      granted: new Map(),
      ...override,
    })
    return { text, calls, audits }
  } finally {
    mcpCore.callTool = originalCall
    auditCore.record = originalRecord
  }
}

/** 拒绝的三种证据一起看：没执行 · 有话说 · 审计记的是失败 */
function checkDenied(label, result, keyword) {
  check(`★ ${label} → mcp.callTool 调用次数 0`, result.calls === 0, `实际 ${result.calls}`)
  check(`${label} → 把拒绝理由还给模型`, String(result.text).includes(keyword), `实际：${result.text}`)
  check(
    `${label} → 审计记成失败，且没有成功记录`,
    result.audits.length === 1 && result.audits.every((one) => one.ok === false),
    `审计 ${result.audits.length} 条：${JSON.stringify(result.audits.map((one) => one.ok))}`,
  )
}

export async function run() {
  /* ─────────── ① 三道运行时约束（原来一条都没生效）─────────── */
  group('204 / ① 本轮运行时约束 must reach MCP（修复前三条全部失效）')

  const toolsOff = await probe({ allowTools: false })
  checkDenied('allowTools:false', toolsOff, '关闭工具调用')

  /* ★ 关键一条：`permission='full'`（完全访问档）**不能**绕过运行时约束 */
  const writeOff = await probe({ allowWrite: false })
  checkDenied('full + allowWrite:false', writeOff, '只分析，不修改')
  check(
    '★ 完全访问档不豁免 allowWrite（用户以前批过 MCP 也不豁免）',
    writeOff.calls === 0 && writeOff.audits[0]?.permission === 'full',
    `calls=${writeOff.calls} permission=${writeOff.audits[0]?.permission}`,
  )

  const netOff = await probe({ allowNetwork: false })
  checkDenied('full + allowNetwork:false', netOff, '禁止联网')

  /* ─────────── ② 只读档与确认通道 ─────────── */
  group('204 / ② 只读档 / 确认通道（ask 无通道 = 拒绝，不再静默执行）')

  const readonly = await probe({ permission: 'readonly' })
  checkDenied('permission:readonly', readonly, '只读')
  check(
    '只读档文案逐字沿用旧 MCP 分支（老审计/老文档还认得这句话）',
    readonly.text === gate.TEXTS.readonly(),
    `实际：${readonly.text}`,
  )
  check(
    '只读档审计原因逐字沿用（`只读模式下拒绝 MCP 工具`）',
    readonly.audits[0]?.error === gate.REASONS.readonly,
    `实际：${readonly.audits[0]?.error}`,
  )

  const askNoChannel = await probe({ permission: 'ask' })
  checkDenied('permission:ask 且没有 confirm', askNoChannel, '没有可确认的界面')

  const askDenied = await probe({ permission: 'ask', confirm: async () => false })
  checkDenied('permission:ask + 用户拒绝', askDenied, '用户拒绝')

  /* ─────────── ③ 正常路径不回归 ─────────── */
  group('204 / ③ 正常授权照常执行（修好约束，不能把正常路径一起关掉）')

  const fullPlain = await probe({ permission: 'full' })
  check('★ full + 无运行时限制 → callTool 调用 1 次', fullPlain.calls === 1, `实际 ${fullPlain.calls}`)
  check(
    'full 档不问人（审计里 approval 为 null）',
    fullPlain.audits[0]?.approval === null,
    `实际：${fullPlain.audits[0]?.approval}`,
  )
  check(
    '★ 成功路径仍打上「外部数据不是指令」的边界（返回值契约不变）',
    String(fullPlain.text).includes('以下为外部工具返回的数据') && String(fullPlain.text).includes(FAKE_RESULT),
    `实际：${fullPlain.text}`,
  )
  check(
    '成功记账为 ok:true（拒绝与成功分别断言，不混成一个计数）',
    fullPlain.audits.length === 1 && fullPlain.audits[0].ok === true,
    `审计：${JSON.stringify(fullPlain.audits.map((one) => one.ok))}`,
  )

  const askApproved = await probe({ permission: 'ask', confirm: async () => true })
  check(
    '★ permission:ask + 用户批准 → callTool 调用 1 次',
    askApproved.calls === 1,
    `实际 ${askApproved.calls}`,
  )
  check(
    'ask 批准后审计记的是「问过且批了」（approval:true）',
    askApproved.audits[0]?.approval === true,
    `实际：${askApproved.audits[0]?.approval}`,
  )

  /* ─────────── ④ 内置工具不回归 ─────────── */
  group('204 / ④ 内置工具的权限判据与行为没被动到')

  const sharedCtx = { workdir: SANDBOX, sessionId: 'selftest-mcp-runtime-gate', granted: new Map() }
  const readOk = await tools.execute(
    'read_file',
    { path: join(SANDBOX, 'hello.txt') },
    { ...sharedCtx, permission: 'full', allowWrite: false },
  )
  check(
    'read_file 在 allowWrite:false 下仍能读（「只分析」不该拦纯读）',
    String(readOk).includes('line one'),
    `实际：${String(readOk).slice(0, 120)}`,
  )

  const writeDenied = await tools.execute(
    'write_file',
    { path: join(SANDBOX, 'gate-probe.txt'), content: 'x' },
    { ...sharedCtx, permission: 'full', allowWrite: false },
  )
  check(
    'write_file 在 allowWrite:false 下仍被拒（老文案不变）',
    String(writeDenied).includes('只分析，不修改'),
    `实际：${String(writeDenied).slice(0, 120)}`,
  )

  /* ─────────── ⑤ 判据只有一处（硬约束 9）─────────── */
  group('204 / ⑤ 判据的唯一真相源')

  const src = readFileSync(join(ROOT, 'electron/core/tools/index.cjs'), 'utf8')
  check(
    '★ index.cjs 的 MCP 分支改为调 mcpGate.check（不再自己判 allowTools/allowWrite）',
    src.includes('mcpGate.check(') && !src.includes('只读模式下拒绝 MCP 工具'),
    'index.cjs 里还留着旧的 MCP 判据就等于两处真相源',
  )
  check(
    '★ MCP 分支的三道约束都在 callTool 之前（源码顺序断言）',
    indexOfIn(src, 'mcpGate.check(') < indexOfIn(src, 'mcp.callTool('),
    '判据必须在 callTool 之前',
  )
}

/** `String.prototype.indexOf` 的小包装，只为让上面的断言短一点 */
function indexOfIn(haystack, needle) {
  return haystack.indexOf(needle)
}
