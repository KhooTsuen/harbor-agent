/**
 * Codex MCP 桥的**生命周期与开关**（2026-10-17 第二阶段 · 接线）
 *
 * ── 它管三件事 ────────────────────────────────────────────────
 *
 *   ① **开关**：`HARBOR_CODEX_MCP=1` 才启用。默认**关着** —— 不建命名管道、
 *      不起 MCP 服务、不动 token、不改任何现有行为（用户第 2 条）。
 *   ② **装配/收摊**：启用时把 `codex-mcp-bridge.cjs` 接到主进程，并在
 *      `app will-quit` 与 `process exit` 时收摊（用户第 7 条：生命周期归 Harbor）。
 *   ③ **codex 启动参数**：给 `codex-cli` 后端用 —— 把 MCP server 配置经
 *      `-c` **临时注入**（用户第 5 条：**不写用户的 `~/.codex/config.toml`**）。
 *
 * ── 为什么开关是环境变量而不是配置项 ──────────────────────────
 *
 * 它是**开发期**开关，且「默认关闭 + 零副作用」是硬要求。走配置的话要在
 * `config-defaults.cjs`（299 行）与 `config-normalize-parts.cjs` 两处贴线文件里
 * 加字段（不写白名单还会被静默丢掉）。环境变量不进用户数据、不改配置形状、
 * 不启用时**一个字节都不产生** —— 最小改动，也最容易回退。
 *
 * ── ★ 参数安全：为什么路径要过 `safePath`（fail-closed）────────
 *
 * 这两项要拼进 **cmd 命令行**，而路径来自安装位置（可能含空格、引号、`&`）。
 * 命令行里出现 `"` `'` `&` `|` `%` 这类字符就可能被 shell 重新解释 ——
 * 那是一条注入通道。所以：**含这些字符就整个不注入**（宁可不启用，也不拼一条
 * 语义不确定的命令行）。空格是安全的（在引号内），允许。
 *
 * ⚠️ 不 require electron（自检能在纯 Node 里跑）。
 */

const fs = require('node:fs')
const path = require('node:path')

/* ★ 开关常量与状态判定**都在 codex-mcp-switch.cjs**（那边是唯一家，避免两处各写一套）。
   这里转发导出，是为了让既有调用方（codex-cli / 自检）不用改一行。 */
const sw = require('./codex-mcp-switch.cjs')
const {
  ENV_FLAG,
  ENV_WRITE,
  ENV_WRITE_ROOT,
  ENV_TEST,
  ENV_CONFIRM_MS,
  settings,
  enabled,
  writeConfig,
  testConfig,
  resolveState,
} = sw

/** MCP server 入口（在 `electron/` 下，与主进程同级） */
const SERVER_FILE = 'mcp-server-standalone.cjs'

/** 拼进命令行会改变语义的字符（含它们就拒绝注入 —— 见文件头） */
const UNSAFE = /["'&|<>%`\r\n\t]/

/** 路径能不能安全地拼进命令行（空 / 含危险字符 → false） */
function safePath(value) {
  const text = String(value ?? '')
  if (!text.trim()) return false
  return !UNSAFE.test(text)
}

/** 反斜杠 → 正斜杠（cmd 与 TOML 里都少一层转义，PoC 实测这条最稳） */
function fwd(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** MCP server 的入口路径（`electron/mcp-server-standalone.cjs`） */
function serverPath() {
  return path.join(__dirname, '..', SERVER_FILE)
}

/**
 * 桥的**调用记录** → `<data>/codex-mcp-calls.jsonl`（一次调用一行）。
 *
 * 为什么桥自己还要记一份（审计里不是有了吗）：审计只记**真正执行**的工具调用，
 * 而「被拒的调用」（错 token / 越界路径 / 未知工具）在那之前就返回了 ——
 * 那些恰恰是安全验收要看的东西。参数过 `redact.scrub`（与 audit.cjs 同口径）。
 */
function appendCall(dataDir, rec) {
  try {
    const redact = require('./redact.cjs')
    fs.appendFileSync(path.join(dataDir, 'codex-mcp-calls.jsonl'), `${JSON.stringify(redact.scrub(rec))}\n`, 'utf8')
  } catch {
    /* 取证失败不影响主流程（同 audit.cjs 的底线②） */
  }
}

/**
 * 给 codex 的 `exec` 追加的参数（**未启用 / 路径不安全 → 空数组**）。
 *
 * 形状：`-c mcp_servers.harbor.command=node` ·
 *      `-c mcp_servers.harbor.args=['<server>','<dataDir>','<runId>']`
 * （为什么是单引号、为什么不能加外层引号 —— 见下面那段实测记录）
 *
 * `args[1]` = 数据根（MCP server 靠它算管道名与 token 位置）；
 * `args[2]` = **本次运行**（runId）：审批卡按它绑定到发起这一轮对话。
 *
 * @param {string} [runId] 形状不合法 → 不注入（桥拿不到上下文，写类调用被拒）
 * @returns {string[]}
 */
function codexExtraArgs(runId = '') {
  if (!enabled()) return []
  /* 延迟 require：只要「没启用」就不该把 paths.cjs（乃至整个桥）拉进来 */
  const dataDir = require('./paths.cjs').DIRS.data
  const server = serverPath()
  if (!safePath(dataDir) || !safePath(server)) return []
  /* ★ runId 会拼进命令行 —— 形状必须安全（只允许 [A-Za-z0-9_-]），否则宁可不带 */
  const run = require('./codex-mcp-context.cjs').RUN_ID_RE.test(String(runId ?? ''))
    ? String(runId)
    : ''
  return [
    '-c',
    'mcp_servers.harbor.command=node',
    '-c',
    /*
     * ★ 形状（**只有这一种在生产的 `cmd /s /c` 路径下验过**）：TOML **单引号字面字符串**、
     *   **不加外层引号**。
     *
     * 2026-10-17 主进程 e2e 实测出来的两条硬事实：
     *   ① **cmd 不认 `\"` 转义** —— 写成 `args=[\"a\",\"b\"]` 会让引号配对错乱，
     *      cmd 于是把 `E:\...\codex.cmd" exec ...` 整段当成命令名（「不是内部或外部命令」）。
     *      PoC 之所以能用那种写法，是因为它走的是 **bat**，不是 `cmd /s /c`。
     *   ② 单引号在 cmd 里**不是特殊字符** → 不会被重新解释；TOML 又正好把 `'…'`
     *      当字面字符串（不做反斜杠转义），路径用正斜杠即可。
     * ⚠️ 因此路径里**不能有单引号** —— `safePath` 已经把它列入拒绝集（见文件头）。
     */
    `mcp_servers.harbor.args=['${fwd(server)}','${fwd(dataDir)}'${run ? `,'${run}'` : ''}]`,
    /*
     * ★ 只有**写能力启用时**才加这一条（默认零影响）。
     *
     * 为什么必须加（2026-10-17 实测）：`codex exec` 是**非交互**的，而它把写类 MCP
     * 工具（`readOnlyHint:false`）一律判为「需要审批」，非交互下无卡可弹 →
     * 直接拒绝（`MCP tool call requires approval, but approval policy is never`），
     * 请求**根本到不了 Harbor**。`approval_policy` 各种写法都改不动这一点
     * （裸值 / 带引号都试过）；能改的是 **MCP server 级**的这个键。
     *
     * ★ **它不是安全控制**：codex 层只是别再自己拦一道；真正的闸门在 Harbor 侧 ——
     *   写根必须落在隔离数据根内 + **PermissionBar 逐次真人审批** + 审计。
     *   这正是一开始就定下的分工（「codex 的 flag 不能替代 Harbor 的审批」）。
     */
    ...(writeConfig().writeEnabled
      ? ['-c', "mcp_servers.harbor.default_tools_approval_mode='approve'"]
      : []),
  ]
}

/**
 * 把桥接到主进程（**只有启用时才真的做事**）。
 *
 * 全程 try/catch：桥起不来**只记一条日志**，绝不影响 Harbor 其他功能
 * （用户第 2 条：未启用时零副作用；启用时坏了也不能拖垮应用）。
 *
 * @param {{ app?: object, resolveWorkdir?: () => string, log?: object }} [deps]
 * @returns {object|null} 桥实例（未启用时 `null`）
 */
function install(deps = {}) {
  const log = deps.log ?? {}
  if (!enabled()) {
    log.info?.('codex-mcp：未启用（HARBOR_CODEX_MCP 未设为 1）—— 不建管道、不启动 MCP 服务')
    return null
  }

  let bridge = null
  try {
    const { DIRS } = require('./paths.cjs')
    const w = writeConfig()
    bridge = require('./codex-mcp-bridge.cjs').install({
      resolveWorkdir: deps.resolveWorkdir,
      dataDir: DIRS.data,
      /* 诊断项的「隔离/数据目录」这一项：主进程下就报本次运行的数据根 */
      isoDir: DIRS.data,
      codexHome: String(process.env.CODEX_HOME ?? ''),
      /* ★ 开关**每次调用现读**（不是装配快照）：设置里关掉写入/测试 → 新请求立刻被拒。
         写根是否真的允许仍由 policy 判（必须落在隔离数据根内）。 */
      getSwitch: () => {
        const wc = writeConfig()
        const tc = testConfig()
        return {
          mcpEnabled: enabled(),
          writeEnabled: wc.writeEnabled,
          writeRoot: wc.writeRoot,
          testEnabled: tc.testEnabled,
          testRoot: tc.testRoot,
        }
      },
      /* 审批超时（开发期可调；没设就是 approval.cjs 的默认） */
      confirmTimeoutMs: Number(process.env[ENV_CONFIRM_MS] ?? 0),
      onCall: (rec) => appendCall(DIRS.data, rec),
      log,
    })
    sw.markInstalled(true)
    log.info?.(
      `codex-mcp：已接入主进程（数据根 ${DIRS.data}，写=${w.writeEnabled ? `开(${w.writeRoot})` : '关'}，管道 ${bridge.info?.().pipe ?? '?'}）`,
    )
  } catch (error) {
    log.warn?.(`codex-mcp：接入主进程失败（不影响其他功能）${String((error && error.message) || error)}`)
    return null
  }

  /* ★ 生命周期：正常退出（will-quit）与异常退出（exit）都要收摊（用户第 7 条） */
  const stop = () => {
    try {
      bridge.stop()
    } catch {
      /* 收摊失败不是错误：进程都要走了 */
    }
  }
  try {
    deps.app?.on?.('will-quit', stop)
  } catch {
    /* 没有 app（自检/纯 Node）时跳过 */
  }
  try {
    process.once('exit', stop)
  } catch {
    /* 同上 */
  }

  return bridge
}

/**
 * 一轮对话开始 → 登记它的审批上下文；结束 → 注销。
 *
 * 桥按 `runId` 找回**发起这次操作的那条对话**的 `confirm`（审批卡据此落在正确对话上）。
 * **未启用时什么都不做**（Map 都不碰）—— 保证「未启用零副作用」。
 *
 * @param {string} runId = `chat:send` 的 `phaseKey`（也是 codex 的 `traceId`）
 * @param {{ requestId?: string, sessionId?: string, confirm?: Function }} ctx
 */
function registerRun(runId, ctx) {
  if (!enabled()) return false
  return require('./codex-mcp-context.cjs').register(runId, { ...ctx, source: 'codex' })
}

/** 一轮对话结束 → 注销（此后拿它发起的审批请求一律被拒） */
function unregisterRun(runId) {
  if (!enabled()) return false
  return require('./codex-mcp-context.cjs').unregister(runId)
}

/**
 * 按**对话的 requestId** 注销（`chat:abort` 走这条）。
 *
 * 为什么不直接用 runId：登记的 key 是 `phaseKey`（可能等于 taskId），而 abort 只拿得到
 * requestId。context 里两个都存着，按 requestId 反查删掉即可。
 */
function unregisterRunByRequest(requestId) {
  if (!enabled()) return false
  return require('./codex-mcp-context.cjs').unregisterByRequest(requestId)
}

/**
 * 桥**这次真的提供**给 Codex 的工具名（未启用 → 空数组）。
 *
 * 为什么需要它：`codex-msg.cjs` 在「带了 tools」时会写「本次运行**没有可用的工具**」——
 * 桥一开 Codex 确实有工具，那句话就在骗它（时灵时不灵，2026-10-17 真机踩到）。
 *
 * @returns {string[]}
 */
function exposedToolNames() {
  if (!enabled()) return []
  try {
    const names = [...require('./codex-mcp-tools.cjs').TOOL_NAMES]
    /* ★ 没开就不许宣称有它（否则 Codex 会调一个必然被拒的工具，白烧一轮）。三个判据独立。 */
    const can = { write: writeConfig().writeEnabled, test: testConfig().testEnabled, project: false }
    try {
      can.project = require('./project-tests.cjs').load().enabled === true
    } catch {
      can.project = false
    }
    return names.filter((n) => {
      if (n === 'harbor_write_file' || n === 'harbor_edit_file') return can.write
      if (n === 'harbor_run_test') return can.test
      if (n === 'harbor_run_project_test') return can.project
      return true
    })
  } catch {
    /* 拿不到就当没有 —— 绝不因此让一轮对话起不来 */
    return []
  }
}

module.exports = {
  ENV_FLAG,
  ENV_WRITE,
  ENV_WRITE_ROOT,
  SERVER_FILE,
  enabled,
  writeConfig,
  safePath,
  codexExtraArgs,
  exposedToolNames,
  install,
  registerRun,
  unregisterRun,
  unregisterRunByRequest,
}
