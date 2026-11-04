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
const approvalsCore = require(join(ROOT, 'electron/core/tools/approval.cjs'))

/** 只要带 `mcp__` 前缀就会走 MCP 分支，不需要真注册一个服务器 */
const MCP_TOOL = 'mcp__selftest__probe'
const FAKE_RESULT = 'ok-from-fake-mcp'

/**
 * 跑一次 `tools.execute`，MCP 调用与审计都换成探针。
 *
 * @param {object} override 覆盖 ctx 的字段（`permission` / `allowWrite` / `confirm` …）
 * @param {string} [toolName] 换一个 MCP 工具名（默认本组那个 `mcp__selftest__probe`）
 * @returns {Promise<{ text: string, calls: number, audits: object[], asked: number }>}
 *   `calls` = 假 `mcp.callTool` 被真正执行的次数（**本组的主要判据**）
 *   `asked` = 真的问了几次人（确认粒度看这个）
 */
async function probe(override = {}, toolName = MCP_TOOL) {
  const originalCall = mcpCore.callTool
  const originalRecord = auditCore.record
  let calls = 0
  let asked = 0
  const audits = []
  mcpCore.callTool = async () => {
    calls += 1
    return FAKE_RESULT
  }
  auditCore.record = (entry) => {
    audits.push(entry)
  }
  try {
    const ctx = {
      workdir: SANDBOX,
      permission: 'full',
      sessionId: 'selftest-mcp-runtime-gate',
      /* 每次给新的 Map：`approvals.ask` 会按 kind 记忆 2 分钟，复用会让后一个用例白嫖前一个的批准 */
      granted: new Map(),
      ...override,
    }
    /*
     * 默认**不给**确认通道（各档位用例靠它钉 fail-closed）；
     * 要测「问人」的用例自己在 override 里传 confirm —— 这里只负责数次数。
     */
    if (typeof override.confirm === 'function') {
      const real = override.confirm
      ctx.confirm = async (request) => {
        asked += 1
        return real(request)
      }
    }
    const text = await tools.execute(toolName, { probe: true }, ctx)
    return { text, calls, audits, asked }
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

  /* ─────────── ⑤ 批准按「服务器」记住，不按「整类 mcp」─────────── */
  /*
   * 起因（2026-11-05 实测）：旧代码把 `mcp` 放进 `approval.cjs` 的 `REMEMBERED`，
   * 于是批准 `mcp__fetch__fetch`（只读抓取）之后，同一 2 分钟窗口内
   * `mcp__filesystem__write_file`（**另一个服务器、会写盘**）不再问就执行
   * （探针：asked=0 / calls=1）。卡片上「允许本次」在 MCP 上实际是
   * 「允许所有外部工具两分钟」。
   *
   * ★ 这里的判据同样是**调用次数 + 问人次数**，不是文案：
   *   同一个 `ctx.granted` Map 里，换一个服务器必须重新问，同一个服务器的工具不再问。
   */
  group('204 / ⑤ 一次批准只覆盖同一个服务器的工具（不跨服务器免问）')

  const sharedGranted = new Map()
  /** 用户批准 —— `probe` 会在这个包装外面数 `asked` 次数 */
  const approve = async () => true
  const sameServer = await probe({ permission: 'ask', granted: sharedGranted, confirm: approve })
  const sameServerAgain = await probe({ permission: 'ask', granted: sharedGranted, confirm: approve })
  check(
    '★ 同一服务器的工具：第一次问（asked=1），第二次不再问（asked=0）',
    sameServer.asked === 1 && sameServerAgain.asked === 0,
    `第一次 asked=${sameServer.asked}，第二次 asked=${sameServerAgain.asked}`,
  )
  check(
    '两次都真的执行了（不重复打扰 ≠ 不执行）',
    sameServer.calls === 1 && sameServerAgain.calls === 1,
    `calls=${sameServer.calls}/${sameServerAgain.calls}`,
  )

  const otherServer = await probe(
    { permission: 'ask', granted: sharedGranted, confirm: approve },
    'mcp__otherserver__write_something',
  )
  check(
    '★ 换一个服务器的工具 → **必须重新问**（跨服务器不许共用批准）',
    otherServer.asked === 1,
    `asked=${otherServer.asked}（0 就是漏洞：别的服务器靠前一次批准免问了）`,
  )

  const keys = [...sharedGranted.keys()]
  check(
    '记住的键带服务器标识（不是一个笼统的 `mcp`）',
    keys.length > 0 && keys.every((k) => k.startsWith('mcp:')),
    `实际键：${JSON.stringify(keys)}`,
  )
  check(
    '★ 整类 `mcp` 已从 REMEMBERED 移出（忘传 rememberKey 时退回「每次问」，不是「整类免问」）',
    !approvalsCore.REMEMBERED.has('mcp') && approvalsCore.REMEMBERED.has('write'),
    `REMEMBERED=${JSON.stringify([...approvalsCore.REMEMBERED])}`,
  )

  /* ─────────── ⑥ 判据只有一处（硬约束 9）─────────── */
  group('204 / ⑥ 判据的唯一真相源')

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
