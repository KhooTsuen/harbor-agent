/* ══════════════════════════════════════════════════════════════
   开屏「工作区总览」的桥返回类型（内核 core/workspace-summary.cjs 产出）

   单独一个文件而不是塞进 backend.ts：那边贴着 300 行，
   而「谁的桥接口住在哪个文件」本来就是这个项目的既有做法。
   ══════════════════════════════════════════════════════════════ */

/** Git 摘要（不是仓库 / 没装 git 时 ok:false，界面照常显示其余部分） */
export interface WorkspaceGitSummary {
  ok: boolean
  branch?: string
  changes?: number
  error?: string
}

/** 工作区扫描结果 */
export interface WorkspaceSummary {
  ok: boolean
  dir: string
  name?: string
  /** 技术栈标签（最多 6 个，浅层识别，不递归） */
  stack?: string[]
  /** 有测试入口时的跑法（npm test / cargo test / go test ./...） */
  testCommand?: string
  git?: WorkspaceGitSummary
  error?: string
}

/** 开屏相关桥（只读）；区块各自 ok，单项失败不拖垮整块 */
export interface WorkspaceBridge {
  workspaceScan: (dir?: string) => Promise<WorkspaceSummary>
}
