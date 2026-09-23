/* MCP 的类型（从 models-extra.ts 抽出来的 —— 那边又贴顶了）

   内核那边唯一真相源：`mcp-presets.cjs`（预设）、`mcp-runtime.cjs`（怎么起进程）。 */

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
  /**
   * 用应用自带的 Node 跑（Electron 的可执行文件 + `ELECTRON_RUN_AS_NODE=1`）——
   * 自己写的 JS 服务器因此不必先装 Node。只对 `node <脚本>` 这种命令生效。
   */
  useBundledNode?: boolean
  /* ── 隔离（默认最保守）── */
  /** 是否继承主进程环境变量。默认否 —— 不然会把所有 API Key 递给第三方程序 */
  inheritEnvironment: boolean
  envAllowlist: string[]
  cwd: string
  network: 'deny' | 'ask' | 'allow'
  timeoutMs: number
  permission: 'full' | 'ask' | 'readonly'
}

export interface McpServerStatus {
  id: string
  name: string
  alive: boolean
  error: string
  toolCount: number
  tools: Array<{ name: string; description: string }>
  /*
   * 下面三个是 2026-09-24 网络策略落地时内核新加的（`core/mcp.cjs` 的 `status()`）。
   * 可选项：老版本内核 / 假数据没有它们，界面得能处理 undefined。
   */
  /** 被网络策略拦下的理由（空 = 没被拦） */
  blockedReason?: string
  /** 如实反映「这份声明到底管住了多少」：`controlled` 兑现了，`uncontrolled` 没兑现 */
  networkStatus?: 'controlled' | 'uncontrolled' | 'blocked'
  /** 为什么是这个状态（人话，直接显示给用户） */
  networkNote?: string
}

/** 内置预设（内核 mcp-presets.cjs 是唯一真相源；command 里的占位符已由内核填好） */
export interface McpPreset {
  id: string
  name: string
  description: string
  command: string
  /** 'node' = 需要系统装了 Node；'bundled-node' = 用应用自带的 Node，不必装 */
  needs: 'node' | 'bundled-node'
  repo: string
}
