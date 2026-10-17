/**
 * Codex MCP 桥的**开关与状态**（2026-10-17 第四阶段 · 接进设置界面）
 *
 * ── 为什么从 lifecycle 拆出来 ─────────────────────────────────
 *
 * lifecycle 管的是「装配 / 收摊 / 拼命令行」，它已经贴着 300 行红线。
 * 而「现在到底开没开」是一组**纯读取**的判据，跟装配没关系 —— 拆出来既腾行，
 * 也能被自检和界面 IPC 直接调（不必起整个桥）。
 *
 * ── ★ 两套来源，一份判定（用户第 6 条）────────────────────────
 *
 * 开关有两个来源：
 *   · **设置界面**（`config.codexMcp`）—— 用户日常用这个
 *   · **环境变量** `HARBOR_CODEX_MCP*` —— 开发期 / 验收脚本用（不改用户配置）
 *
 * 二者任一为真即为真。★ 关键：**界面读的是 `resolveState()` 的输出**，
 * 而不是配置对象里的原始字段 —— 所以即使环境变量把某项打开了，界面显示的
 * 也是「真的在生效」那个值，并标明来源（`source: 'env'`）。
 * 不会出现「界面显示已启用、后端其实没启用」或反过来。
 *
 * ── ★ 哪些改动需要重开会话（用户第 6 条）──────────────────────
 *
 *   · `enabled`（总开关）：桥在**主进程启动时**装配命名管道，中途改不了 →
 *     改完必须重启应用。`resolveState().needsRestart` 会把这件事如实报给界面。
 *   · `write` / `runTest`：**每次调用时现读**（`writeConfig()` / `testConfig()`）→
 *     热切换，关掉后新请求立刻被拒（用户第 5 条）。
 *
 * ⚠️ 不 require electron。
 */

/** 开关环境变量（开发期覆盖；未设置 = 只看配置） */
const ENV_FLAG = 'HARBOR_CODEX_MCP'
const ENV_WRITE = 'HARBOR_CODEX_MCP_WRITE'
const ENV_WRITE_ROOT = 'HARBOR_CODEX_MCP_WRITE_ROOT'
const ENV_TEST = 'HARBOR_CODEX_MCP_TEST'
/** 审批超时（毫秒；开发期可调，缺省 = approval.cjs 自己的 10 分钟） */
const ENV_CONFIRM_MS = 'HARBOR_CODEX_MCP_CONFIRM_MS'

/** 全关的形状（读不到配置时的回落 —— 绝不因为读失败就放行） */
const ALL_OFF = { enabled: false, write: false, writeRoot: '', runTest: false }

/**
 * 设置里的那一段（**唯一真相源**）。
 * @returns {{ enabled: boolean, write: boolean, writeRoot: string, runTest: boolean }}
 */
function settings() {
  try {
    const cfg = require('./config.cjs').get()
    const raw = cfg && cfg.codexMcp
    if (raw && typeof raw === 'object') return { ...ALL_OFF, ...raw }
  } catch {
    /* 落到全关 */
  }
  return { ...ALL_OFF }
}

const envOn = (name) => String(process.env[name] ?? '').trim() === '1'
const envText = (name) => String(process.env[name] ?? '').trim()

/** 桥总开关（配置或环境变量任一为真） */
function enabled() {
  return envOn(ENV_FLAG) || settings().enabled === true
}

/**
 * 写能力：桥开着 + 写开关为真 + 配了写根。
 * 写根是否**真的允许**还要过 `policy.resolveWriteRoot`（必须落在隔离数据根内）。
 */
function writeConfig() {
  const s = settings()
  const on = envOn(ENV_WRITE) || s.write === true
  const root = envText(ENV_WRITE_ROOT) || String(s.writeRoot ?? '')
  return { writeEnabled: enabled() && on && Boolean(root), writeRoot: root }
}

/**
 * 受限测试：桥开着 + 测试开关为真 + 有测试根。
 * 测试根复用写根 —— 测试必须跑在**有代码的那个隔离工作区**里。
 */
function testConfig() {
  const s = settings()
  const on = envOn(ENV_TEST) || s.runTest === true
  const { writeRoot } = writeConfig()
  return { testEnabled: enabled() && on && Boolean(writeRoot), testRoot: writeRoot }
}

/* ── 装配快照：判「改完设置要不要重启」的唯一依据 ───────────── */

let installedEnabled = false
let installedAt = 0

/** 装配时记一笔（由 lifecycle 的 install 调） */
function markInstalled(value) {
  installedEnabled = value === true
  installedAt = Date.now()
}

/** 桥现在真的是装着的吗 */
function isInstalled() {
  return installedEnabled
}

/**
 * 给界面 / IPC 的**真实生效状态**（不是配置原值）。
 *
 * @returns {{ mcp: object, write: object, runTest: object, approval: object,
 *             needsRestart: boolean, installedAt: number }}
 */
function resolveState() {
  const w = writeConfig()
  const t = testConfig()
  const now = enabled()
  const writeSource = envOn(ENV_WRITE) || envText(ENV_WRITE_ROOT) ? 'env' : 'config'
  return {
    mcp: { enabled: now, source: envOn(ENV_FLAG) ? 'env' : 'config' },
    write: { enabled: w.writeEnabled, root: w.writeRoot, source: writeSource },
    runTest: { enabled: t.testEnabled, root: t.testRoot, source: envOn(ENV_TEST) ? 'env' : 'config' },
    /* 逐次审批是**硬编码**的（写与测试都走真人卡），不是开关 —— 如实标出来 */
    approval: { perRequest: true, ui: 'PermissionBar' },
    /* 现在的总开关与装配时不一致 → 界面必须提示「重启应用后生效」 */
    needsRestart: now !== installedEnabled,
    installedAt,
  }
}

module.exports = {
  ENV_FLAG,
  ENV_WRITE,
  ENV_WRITE_ROOT,
  ENV_TEST,
  ENV_CONFIRM_MS,
  settings,
  enabled,
  writeConfig,
  testConfig,
  markInstalled,
  isInstalled,
  resolveState,
}
