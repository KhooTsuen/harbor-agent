/* ══════════════════════════════════════════════════════════════
   Codex MCP 桥的设置与**真实生效状态**（渲染层镜像）

   从 `models.ts` 单独拆出来的 —— 那边 299 行贴着 300 红线。

   ★ 关键区别：`CodexMcpSettings` 是**用户配了什么**（存在 config.json 里），
     `CodexMcpState` 是**主进程算出来的此刻真的在生效什么**。
     界面必须显示后者 —— 否则会出现「界面说开了、后端其实没开」（用户第 6 条）。
     `source` 是 `'env'` 时说明是开发期环境变量覆盖的（验收脚本用），不是用户在界面设的。
   ══════════════════════════════════════════════════════════════ */

/** 用户在界面上配的那四项（默认全 false / 空串） */
export interface CodexMcpSettings {
  enabled: boolean
  write: boolean
  writeRoot: string
  runTest: boolean
}

/** 一条能力此刻的真实状态 */
export interface CodexMcpCapability {
  enabled: boolean
  /** 写/测试才有：当前使用的目录 */
  root?: string
  /** 目录是否通过了主进程校验（越界 / 符号链接 / 目录联接都会被拒） */
  rootValid?: boolean
  /** 不合法时的原文（界面直接显示，不改写） */
  rootError?: string
  /** `'env'` = 被开发期环境变量覆盖（不是用户在界面设的值） */
  source: 'env' | 'config'
}

/** `codexMcp:status` 的返回体 */
export interface CodexMcpState {
  mcp: CodexMcpCapability
  write: CodexMcpCapability
  runTest: CodexMcpCapability
  /** 逐次审批是硬编码的（写与测试都走真人卡），不是开关 */
  approval: { perRequest: boolean; ui: string }
  /** 总开关改过但桥没重新装配 → 界面提示「重启应用后生效」 */
  needsRestart: boolean
  installedAt: number
}
