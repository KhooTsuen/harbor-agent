/**
 * Codex MCP 桥的**配置段**（2026-10-17 第四阶段 · 接进设置界面）
 *
 * ── 为什么单列一个文件 ────────────────────────────────────────
 *
 * `config-defaults.cjs` 已经 299 行贴着 300 红线，`config-normalize.cjs` 也快满了。
 * 照 `config-security.cjs` 的老范式：**默认值与规范化同住一个文件**，
 * 两个贴线文件各加一行 require —— 既腾行，也保证「形状只有一处定义」（硬约束 #9）。
 *
 * ── ★ 默认全关（用户第 2 条）─────────────────────────────────
 *
 * 四项全 false / 空串：装了 Harbor 的人**不会**因为升级就突然多出一个能写文件的外部通道。
 * 必须用户自己在「设置 → 扩展」里逐项打开。
 *
 * ── 与代码里的开关是什么关系 ──────────────────────────────────
 *
 * `codex-mcp-lifecycle.cjs` 的 `enabled()` / `writeConfig()` / `testConfig()` 都读这里
 * （环境变量 `HARBOR_CODEX_MCP*` 仍可作为**开发期覆盖**，优先级更高 —— 验收脚本用它）。
 * 所以界面看到的、和代码真正执行的，是**同一份配置**，不存在两套状态。
 */

/** 默认值（四项全关） */
const CODEX_MCP_DEFAULTS = {
  /** MCP 桥总开关。改它**需要重开会话/重启应用**（桥在启动时装配命名管道） */
  enabled: false,
  /** 受限写入（`harbor_write_file`）。可热切换：关掉后新请求立刻被拒 */
  write: false,
  /** 允许写入的工作区（绝对路径）。**必须由主进程验证落在隔离数据根内** */
  writeRoot: '',
  /** 受限测试执行（`harbor_run_test`）。可热切换 */
  runTest: false,
}

/** 规范化里允许的键（多一个都会被丢掉 —— 手工改配置也塞不进别的） */
const CODEX_MCP_KEYS = Object.keys(CODEX_MCP_DEFAULTS)

/**
 * 把外部给的 `codexMcp` 收成合法形状。
 *
 * @param {unknown} src 磁盘 / 界面传来的原始值
 * @returns {{ enabled: boolean, write: boolean, writeRoot: string, runTest: boolean }}
 */
function normalizeCodexMcp(src) {
  const a = /** @type {Record<string, any>} */ (src && typeof src === 'object' && !Array.isArray(src) ? src : {})
  const out = { ...CODEX_MCP_DEFAULTS }
  for (const key of CODEX_MCP_KEYS) {
    if (key === 'writeRoot') out.writeRoot = typeof a.writeRoot === 'string' ? a.writeRoot.trim().slice(0, 500) : ''
    else out[key] = a[key] === true
  }
  return out
}

module.exports = { CODEX_MCP_DEFAULTS, CODEX_MCP_KEYS, normalizeCodexMcp }
