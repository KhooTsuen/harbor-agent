/**
 * 内核单元测试
 *
 * 直接 require core/ 下的模块，不需要 Electron、不联网。
 *
 *   node scripts/selftest.mjs
 *
 * 结构（原本是一个 1193 行的文件，拆开之后好读也好定位）：
 *
 *   scripts/selftest/harness.mjs         记分与汇总
 *   scripts/selftest/env.mjs             公共环境（被 require 的内核模块、路径、沙箱）
 *   scripts/selftest/groups/01-basics.mjs        路径 / 配置 / 会话文件 / 各工具
 *   scripts/selftest/groups/02-…                 技能 / 记忆 / 搜索 / 统计 / 备份
 *   scripts/selftest/groups/03-…                 文件系统与安全（脱敏/凭证/风险/审计）
 *   scripts/selftest/groups/04-…                 可靠性（任务/回滚/错误分类/路由）
 *   scripts/selftest/groups/05-…                 Agent 循环冒烟 + 会话目录分组
 *   scripts/selftest/groups/06-…                 系统提示内容回归 / 状态 / 预算 / 意图路由
 *   scripts/selftest/groups/07-…                 请求体适配（中转站兼容）/ 流内错误
 *   scripts/selftest/groups/08-…                 用量闸（预算）
 *   scripts/selftest/groups/09-…                 浏览器正文清洗 / 导航策略 / browse 工具
 *   scripts/selftest/groups/10-…                 本地插件（加载/校验/执行）
 *   scripts/selftest/groups/11-…                 图像：异步任务轮询 + generate_image 工具
 *   scripts/selftest/groups/12-…                 模块引用：相对 require 路径都存在
 *   scripts/selftest/groups/13-…                 generate_image 工具
 *   scripts/selftest/groups/14-…                 任务台账注入 / 完整性 / 完成门禁
 *   scripts/selftest/groups/15-…                 AG-001 生命周期状态机
 *   scripts/selftest/groups/13-…                 generate_image 工具（提交即返回）
 *
 * **组与组之间不共享状态** —— 加新组只要在下面 GROUPS 里加一行。
 *
 * 注意：**测试全绿 ≠ 能用**。UI、会话、发送、权限这些必须真的走一遍
 * （见 AGENT.md 的验证纪律）。
 */

import { report } from './selftest/harness.mjs'
import { setupSandbox, rmSync, SANDBOX } from './selftest/env.mjs'

import { run as basics } from './selftest/groups/01-basics.mjs'
import { run as skillsMemory } from './selftest/groups/02-skills-memory.mjs'
import { run as fsSafety } from './selftest/groups/03-fs-safety.mjs'
import { run as reliability } from './selftest/groups/04-reliability.mjs'
import { run as agentLoop } from './selftest/groups/05-agent-loop.mjs'
import { run as promptState } from './selftest/groups/06-prompt-state.mjs'
import { run as llmBody } from './selftest/groups/07-llm-body.mjs'
import { run as limits } from './selftest/groups/08-limits.mjs'
import { run as browser } from './selftest/groups/09-browser.mjs'
import { run as plugins } from './selftest/groups/10-plugins.mjs'
import { run as images } from './selftest/groups/11-images.mjs'
import { run as requires } from './selftest/groups/12-requires.mjs'
import { run as imagesTool } from './selftest/groups/13-images-tool.mjs'
import { run as taskContext } from './selftest/groups/14-task-context.mjs'
import { run as lifecycle } from './selftest/groups/15-lifecycle.mjs'
import { run as eventsBus } from './selftest/groups/16-events.mjs'
import { run as metrics } from './selftest/groups/17-metrics.mjs'
import { run as plan } from './selftest/groups/18-plan.mjs'
import { run as abortTrace } from './selftest/groups/19-abort.mjs'
import { run as streamBatch } from './selftest/groups/20-streambatch.mjs'
import { run as resume } from './selftest/groups/21-resume.mjs'
import { run as recovery } from './selftest/groups/22-recovery.mjs'
import { run as approval } from './selftest/groups/23-approval.mjs'
import { run as errorKinds } from './selftest/groups/24-errors.mjs'
import { run as autoRecover } from './selftest/groups/25-autorecover.mjs'
import { run as continueAfterFail } from './selftest/groups/26-continue.mjs'
import { run as continuity } from './selftest/groups/27-continuity.mjs'
import { run as fileCache } from './selftest/groups/28-filecache.mjs'
import { run as contextCache } from './selftest/groups/29-contextcache.mjs'
import { run as taskName } from './selftest/groups/30-taskname.mjs'
import { run as sessionRedact } from './selftest/groups/31-session-redact.mjs'
import { run as notify } from './selftest/groups/32-notify.mjs'
import { run as trayGroup } from './selftest/groups/33-tray.mjs'
import { run as taskOutcome } from './selftest/groups/34-outcome.mjs'
import { run as checkpoint } from './selftest/groups/35-checkpoint.mjs'
import { run as diagnose } from './selftest/groups/36-diagnose.mjs'
import { run as writeDiff } from './selftest/groups/37-writediff.mjs'
import { run as changesetDiff } from './selftest/groups/38-changesetdiff.mjs'
import { run as perf } from './selftest/groups/39-perf.mjs'
import { run as taskIndex } from './selftest/groups/40-taskindex.mjs'
import { run as budgetGroup } from './selftest/groups/41-budget.mjs'
import { run as loopGuard } from './selftest/groups/42-loopguard.mjs'
import { run as consoleGroup } from './selftest/groups/43-console.mjs'
import { run as steeringGroup } from './selftest/groups/44-steering.mjs'
import { run as pauseGroup } from './selftest/groups/45-pause.mjs'
import { run as acceptanceGroup } from './selftest/groups/46-acceptance.mjs'
import { run as purgeGroup } from './selftest/groups/47-purge.mjs'

const GROUPS = [
  basics,
  skillsMemory,
  fsSafety,
  reliability,
  agentLoop,
  promptState,
  llmBody,
  limits,
  browser,
  plugins,
  images,
  requires,
  imagesTool,
  taskContext,
  lifecycle,
  eventsBus,
  metrics,
  plan,
  abortTrace,
  streamBatch,
  resume,
  recovery,
  approval,
  errorKinds,
  autoRecover,
  continueAfterFail,
  continuity,
  fileCache,
  contextCache,
  taskName,
  sessionRedact,
  notify,
  trayGroup,
  taskOutcome,
  checkpoint,
  diagnose,
  writeDiff,
  changesetDiff,
  perf,
  taskIndex,
  budgetGroup,
  loopGuard,
  consoleGroup,
  steeringGroup,
  pauseGroup,
  acceptanceGroup,
  purgeGroup,
]

async function main() {
  setupSandbox()

  for (const run of GROUPS) await run()

  /* ── 清理 ── */
  rmSync(SANDBOX, { recursive: true, force: true })

  process.exit(report())
}

main().catch((error) => {
  console.error('\n测试自己崩了：', error)
  process.exit(1)
})
