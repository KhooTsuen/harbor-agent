/**
 * **Codex MCP 桥** —— 主进程侧宿主，也是**唯一**执行工具的地方：
 * 收 MCP 转发的调用 → 验 token → 调 `tools/index.cjs` 的 `execute()` → 回结果。
 * ★ 不重写工具实现：权限三档、风险分级、路径授权、审计落盘全在 `execute()` 里。
 * ★ 六个能力：read_file / env_diag（常量）/ write_file（审批）/ edit_file（审批+版本）/
 *   run_test（常量）/ run_project_test（用户配置的命令，只给 id）。
 * ★ 三层结果语义：① 通道 → `B.reply`/`B.failure` ② 转发 → `res.ok` ③ 工具 → `payload.toolOk`。
 * ★ 审批：白名单命令 → 策略批准；**其余 → 委派给发起这一轮的真 confirm**（PermissionBar）。
 *   拿不到对话上下文 → 拒绝（不拿「活跃会话」顶替）。
 * ★ 开关**每次现读**（`getSwitch`）：关掉写入或总开关，新请求立刻被拒，不等重启。
 */

const net = require('node:net')
const path = require('node:path')

const B = require('./codex-mcp-protocol.cjs')
const policy = require('./codex-mcp-policy.cjs')
const { createApproval } = require('./codex-mcp-approval.cjs')
const { runWriteTool } = require('./codex-mcp-write.cjs')
const { runEditTool } = require('./codex-mcp-edit.cjs')
const { runTestTool, testCommands } = require('./codex-mcp-test.cjs')
const { runProjectTest } = require('./project-test-run.cjs')

/** 审计里这条通道用的会话标识（事后能一眼分出「哪些调用来自 Codex」） */
const SESSION = 'codex-mcp'

/**
 * 造一个桥实例（**不自动监听**）。
 *
 * @param {{
 *   resolveWorkdir?: () => string,
 *   dataDir?: string,
 *   isoDir?: string,
 *   codexHome?: string,
 *   writeEnabled?: boolean, writeRoot?: string, testEnabled?: boolean, testRoot?: string,
 *   getSwitch?: () => ({ mcpEnabled: boolean, writeEnabled: boolean, writeRoot: string, testEnabled: boolean, testRoot: string }),
 *   confirmTimeoutMs?: number, log?: { warn?: Function, info?: Function },
 *   onCall?: (rec: object) => void, idleExitMs?: number,
 * }} [deps]
 */
function createBridge(deps = {}) {
  const resolveWorkdir = typeof deps.resolveWorkdir === 'function' ? deps.resolveWorkdir : () => process.cwd()
  const dataDir = String(deps.dataDir ?? '')
  const isoDir = String(deps.isoDir ?? '')
  const codexHome = String(deps.codexHome ?? process.env.CODEX_HOME ?? '')
  /* ★ 开关**每次调用时现读**（`getSwitch`），不是装配快照 —— 否则「设置里关掉写入」得重启才生效。
     没注入时回落静态 deps（自检 / 探针走这套）。 */
  const staticSwitch = () => ({
    mcpEnabled: true,
    writeEnabled: deps.writeEnabled === true,
    writeRoot: String(deps.writeRoot ?? ''),
    testEnabled: deps.testEnabled === true,
    testRoot: String(deps.testRoot ?? deps.writeRoot ?? ''),
  })
  const getSwitch = typeof deps.getSwitch === 'function' ? deps.getSwitch : staticSwitch
  /* 审批超时可注入（缺省 = approval.cjs 的 10 分钟）；「超时→不写」验收要用 */
  const confirmTimeoutMs = Number(deps.confirmTimeoutMs) > 0 ? Number(deps.confirmTimeoutMs) : 0
  const log = deps.log ?? {}
  const onCall = typeof deps.onCall === 'function' ? deps.onCall : null
  const idleExitMs = Number(deps.idleExitMs) > 0 ? Number(deps.idleExitMs) : 0

  const toolsIndex = require('./tools/index.cjs')
  /** 受信任命令集合：诊断 + 受限测试（**精确匹配**，命令都是常量） */
  const DIAG_CMDS = policy.diagCommands({ isoDir, codexHome })
  const TRUSTED_CMDS = new Set([...Object.values(DIAG_CMDS), ...Object.values(testCommands())])

  let token = ''
  let pipe = ''
  let server = null
  let idleTimer = null
  const stats = { calls: 0, denied: 0, lastAt: 0 }
  const note = (message) => log.info?.(`codex-mcp：${message}`)

  /* 审批：白名单命令 → 策略批准；**其余（写）→ 委派给发起这一轮的真 confirm**，
     拿不到对话上下文就拒绝。判据与文案在 codex-mcp-approval.cjs（这里只装配）。 */
  const approvalFor = createApproval({
    trustedCmdSet: TRUSTED_CMDS,
    note,
    /* 批准后再核一次。**按工具分类**，不搞「一律要求 writeEnabled」——
     * 原判据第一行就是 `if (writeEnabled !== true) return false`，于是「项目测试」
     * 也被要求先开 codexMcp.write（它的权限其实是 projectTests.enabled）→
     * 用户开了项目测试、没开写文件（默认关）时，每次调用都被按拒绝结算。
     * 这个洞只有真走一遍 MCP 链路才现形。现在：write/edit 仍要 writeEnabled，
     * edit 另加「文件版本没变」；其余（run_shell：诊断走白名单、项目测试走用户配置）
     * 不在这里管 —— 项目测试的开关由 project-test-run.cjs 每 500ms 复查。 */
    recheck: (name, request) => {
      const l = getSwitch()
      if (l.mcpEnabled !== true) return false
      if (name !== 'write_file' && name !== 'edit_file') return true
      if (l.writeEnabled !== true) return false
      if (name !== 'edit_file') return true
      const v = require('./codex-mcp-edit-rules.cjs').recheckEdit(l, isoDir, request?.args ?? {})
      if (v.ok !== true) note(`审批后复核不通过（${v.code}）—— 按拒绝结算`)
      return v.ok === true
    },
  })

  /** Harbor 工具执行用的 ctx（与 `loop.cjs` 同源，权限档更紧）。`runId` 决定审批卡发给哪一轮。 */
  function makeCtx(workdir, runId) {
    return {
      workdir,
      sessionId: SESSION,
      taskId: '',
      changeSetId: '',
      permission: 'ask',
      allowTools: true,
      /* 「不开写」**不靠 allowWrite**：那是「用户说只分析」的语义，会把 run_shell（MUTATING_TOOLS）
         连只读诊断一起拦掉。边界由**白名单 + 写工具判据**保证。 */
      allowWrite: true,
      allowNetwork: false,
      temporary: false,
      shellTimeout: 30,
      shellPolicy: { medium: 'ask', high: 'ask', critical: 'block' },
      fileScope: 'workspace',
      outputLimit: 512 * 1024,
      confirm: approvalFor(runId),
      ...(confirmTimeoutMs > 0 ? { confirmTimeoutMs } : {}),
      log: { warn: (m) => log.warn?.(`codex-mcp：${m}`), info: () => {} },
      emit: () => {},
      granted: new Map(),
    }
  }

  /** 工具结果 → 桥的应答（`toolOk` 单列：转发成功 ≠ 工具成功，见文件头 ③） */
  function toolReply(text, meta) {
    return { ok: true, payload: { text, toolOk: !policy.isToolFailure(text), meta } }
  }

  /** 一次工具调用：过 Harbor 的 `execute`（四道闸在里面）。`runId` = 发起那次操作的那一轮对话 */
  async function handleCall(tool, args, runId = '') {
    /* 每次现读（见 getSwitch）：MCP 总开关中途关掉 → 立刻拒绝，不等重启 */
    const live = getSwitch()
    if (live.mcpEnabled !== true) return { ok: false, error: { code: 'MCP_DISABLED', message: 'MCP 桥已在设置里关闭 —— 拒绝这次调用' } }
    const workdir = String(resolveWorkdir() ?? '')
    if (!workdir) return { ok: false, error: { code: 'NO_WORKDIR', message: '拿不到受信任的工作区路径 —— 拒绝执行' } }
    const ctx = makeCtx(workdir, runId)
    const startedAt = Date.now()

    if (tool === 'harbor_read_file') {
      /* ★ 真实路径校验（拒绝对路径 / `..` 穿越 / 符号链接越界）—— 在 Harbor 侧做 */
      const target = policy.resolveInWorkspace(workdir, args?.path)
      if (target.ok === false) return { ok: false, error: { code: target.code, message: target.message } }
      const text = await toolsIndex.execute('read_file', { path: target.abs, offset: args?.offset, limit: args?.limit }, ctx)
      const meta = { harborTool: 'read_file', resolved: target.abs, ms: Date.now() - startedAt }
      /* 读成功 → 正文末尾附「文件版本」（局部编辑的 expectHash 取它；Codex 只看到正文） */
      const v = policy.isToolFailure(text) ? '' : require('./codex-mcp-edit-rules.cjs').versionOf(target.abs)
      if (!v) return toolReply(text, meta)
      return { ok: true, payload: { text: `${text}\n\n（文件版本：${v}）`, toolOk: true, meta: { ...meta, version: v } } }
    }

    if (tool === 'harbor_env_diag') {
      const picked = policy.pickChecks(args?.checks)
      if (picked.ok === false) return { ok: false, error: { code: 'BAD_INPUT', message: picked.message } }
      const failed = [] /* 哪几项诊断**真的失败了**（逐项判，见文件头 ③） */
      const lines = ['## Harbor 环境诊断（经 MCP 桥 · 只读）', '']
      for (const id of picked.checks) {
        /* 命令来自常量表；外部只给了 id（pickChecks 已校验它在枚举内） */
        const out = await toolsIndex.execute('run_shell', { command: DIAG_CMDS[id], cwd: workdir }, ctx)
        if (policy.isToolFailure(out)) failed.push(id)
        lines.push(`### ${policy.DIAG_LABELS[id]}`, '', '```', String(out).trim(), '```', '')
      }
      /* 有失败就在正文顶部点出来（**全成功时一个字不加** —— 既有输出逐字节不变） */
      if (failed.length > 0) lines.splice(1, 0, `⚠️ 有 ${failed.length} 项诊断失败：${failed.join(' / ')}`, '')
      const meta = { harborTool: 'run_shell', checks: picked.checks, failed, ms: Date.now() - startedAt }
      return { ok: true, payload: { text: lines.join('\n'), toolOk: failed.length === 0, meta } }
    }

    if (tool === 'harbor_write_file') {
      return runWriteTool({ toolsIndex, writeEnabled: live.writeEnabled, writeRoot: live.writeRoot, isoDir, args, ctx, startedAt, toolReply })
    }
    if (tool === 'harbor_edit_file') {
      /* 局部编辑：同一道写闸；版本 + 唯一匹配由 codex-mcp-edit-rules.cjs 判 */
      return runEditTool({ toolsIndex, writeEnabled: live.writeEnabled, writeRoot: live.writeRoot, isoDir, args, ctx, startedAt, toolReply })
    }
    if (tool === 'harbor_run_test') {
      /* 命令与 cwd 由 codex-mcp-test.cjs 固定；**不接受任何外部参数**（用户第 4 条） */
      return runTestTool({ toolsIndex, testEnabled: live.testEnabled, testRoot: live.testRoot, isoDir, args, ctx, startedAt, toolReply })
    }
    if (tool === 'harbor_run_project_test') {
      /* 命令来自**用户配置**（只给 id）；项目根边界由 policy 判。与本地工具同一个执行段 */
      return runProjectTest({ toolsIndex, isoDir, args, ctx, startedAt })
    }

    return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `不认识的工具：${String(tool)}` } }
  }

  /** 一帧请求 → 处理 → 回一帧 */
  async function onFrame(sock, msg) {
    const id = String(msg?.id ?? '')
    const kind = String(msg?.kind ?? '')
    if (!id) return
    if (!token || String(msg?.token ?? '') !== token) {
      stats.denied += 1
      recordCall({ id, denied: 'bad-token', ok: false })
      sock.write(B.encodeFrame(B.failure({ id, kind, code: 'DENIED', message: '通道 token 不匹配 —— 拒绝' })))
      return
    }
    const tool = String(msg?.payload?.tool ?? '')
    const args = msg?.payload?.args ?? {}
    /* 这一帧属于**哪一轮对话**（codex 侧透传；审批卡按它绑定 —— 见 codex-mcp-approval.cjs） */
    const runId = String(msg?.payload?.runId ?? '')
    let res
    try {
      res = await handleCall(tool, args, runId)
    } catch (error) {
      res = { ok: false, error: { code: 'INTERNAL', message: String((error && error.message) || error) } }
    }
    stats.calls += 1
    stats.lastAt = Date.now()
    const payload = /** @type {any} */ (res).payload
    const err = /** @type {any} */ (res).error
    /* toolOk 单独记：ok:true 但 toolOk:false = 转发成功、**工具失败**那一类（文件头 ③） */
    recordCall({ id, tool, args, ok: res.ok === true, toolOk: payload?.toolOk ?? null, error: res.ok === false ? err : null })
    sock.write(
      B.encodeFrame(res.ok ? B.reply({ id, kind, payload }) : B.failure({ id, kind, code: err.code, message: err.message })),
    )
  }

  function recordCall(rec) {
    const entry = { at: new Date().toISOString(), sessionId: SESSION, ...rec }
    try {
      onCall?.(entry)
    } catch {
      /* 取证失败不影响主流程 */
    }
    return entry
  }
  /** 起监听（token 落 data 根，管道名按 data 根算） */
  function start() {
    if (!dataDir) {
      log.warn?.('codex-mcp：没有数据根 —— 桥不启动')
      return { ok: false, error: 'NO_DATA_DIR' }
    }
    token = B.writeToken(dataDir)
    if (!token) {
      log.warn?.('codex-mcp：token 写不进去（fail-closed，桥拒绝一切请求）')
      return { ok: false, error: 'NO_TOKEN' }
    }
    pipe = B.pipeName(dataDir)
    server = net.createServer((sock) => {
      /** @type {Buffer} */ let buf = Buffer.alloc(0)
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, /** @type {Buffer} */ (chunk)])
        const parsed = B.decodeFrames(buf)
        buf = parsed.rest
        for (const frame of parsed.messages) void onFrame(sock, frame)
      })
      sock.on('error', () => {})
    })
    server.on('error', (e) => log.warn?.(`codex-mcp：监听失败 ${String(e?.message || e)}`))
    server.listen(pipe, () => note(`就绪：${pipe}（数据根 ${dataDir}）`))

    if (idleExitMs > 0) {
      let last = Date.now()
      server.on('connection', () => {
        last = Date.now()
      })
      idleTimer = setInterval(() => {
        if (Date.now() - last >= idleExitMs) {
          note(`空闲 ${Math.round(idleExitMs / 1000)}s，自动退出`)
          stop()
        }
      }, 1000)
      idleTimer.unref?.()
    }
    return { ok: true, pipe, tokenLen: token.length }
  }

  /** 收摊（幂等） */
  function stop() {
    if (idleTimer) clearInterval(idleTimer)
    idleTimer = null
    if (server) {
      try {
        server.close()
      } catch {
        /* 已经关了 */
      }
      server = null
    }
  }
  /** 自检 / 验收读它（只读）。开关**现读**，所以反映的是「此刻」 */
  const info = () => ({ pipe, dataDir, ...getSwitch(), diagCommands: DIAG_CMDS, stats: { ...stats } })

  return { start, stop, handleCall, info, stats, SESSION, TRUSTED_CMDS }
}
/** 主进程装配入口（`register-handlers.cjs` 调它）。全程 try/catch：起不来只记一条日志。 */
function install(deps) {
  const bridge = createBridge(deps)
  try {
    bridge.start()
  } catch (error) {
    deps?.log?.warn?.(`codex-mcp：装配失败（不影响其他功能）${String((error && error.message) || error)}`)
  }
  return bridge
}

module.exports = { createBridge, install, SESSION }
