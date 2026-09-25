# Harbor Agent AI 测试工具清单与接入指南

## 1. 文档定位

本文档说明 Harbor Agent 需要哪些测试工具、每个工具解决什么问题、如何安装、如何接入现有测试流程，以及如何让 AI 子代理安全调用这些工具。

本文档不替代测试用例和发布标准。完整测试用例、用户点击旅程、多代理规范和发布退出条件请参阅 [Harbor Agent 详细测试文档](./详细测试文档.md)。

相关章节：

- [分层测试计划](./详细测试文档.md#6-分层测试计划)
- [真实用户点击旅程](./详细测试文档.md#16-模拟真实用户使用测试)
- [详细测试用例](./详细测试文档.md#18-详细测试用例规格)
- [多代理测试执行方案](./详细测试文档.md#28-多代理测试执行方案)
- [模型质量评测](./详细测试文档.md#29-模型质量与非确定性评测)
- [发布退出标准](./详细测试文档.md#27-发布退出标准)

## 2. 工具分层

| 层级 | 目的 | 主要工具 | 主要输出 |
|---|---|---|---|
| T0 | 环境、版本和隔离 | Node.js 24、npm、PowerShell、Git、虚拟机 | 环境清单 |
| T1 | 类型、格式和静态质量 | TypeScript、ESLint、Prettier | 门禁日志 |
| T2 | 前端和状态测试 | Vitest、jsdom、Testing Library | 测试结果、覆盖率 |
| T3 | Electron 内核和文件安全 | `selftest.mjs`、Node、临时沙箱 | 分组结果、日志 |
| T4 | 实际界面点击 | Playwright、CDP、Windows UI Automation | 截图、录屏、步骤日志 |
| T5 | 真实模型任务 | `acceptance.mjs`、模型端点、产物校验器 | 任务报告、文件差异 |
| T6 | 安全和供应链 | Gitleaks、npm audit、OSV-Scanner、Semgrep | 安全报告 |
| T7 | 性能和耐久 | PowerShell、Procmon、Process Explorer、WPR/WPA | CPU、内存、句柄、耗时 |
| T8 | 发布和恢复 | signtool、certutil、Sandbox、虚拟机 | 哈希、签名、迁移报告 |
| T9 | AI 质量和 trace | Promptfoo、Langfuse/LangSmith、自定义评测器 | 质量、成本、trace |
| T10 | 子代理调度 | Codex 子代理、PowerShell、CI matrix | 子任务和汇总报告 |

## 3. 项目已有工具

`E:\CodexWorkbench` 已经包含以下能力，应优先复用：

| 入口 | 作用 |
|---|---|
| `npm run verify` | 类型、Lint、格式、行数、单元、自检和构建总门禁 |
| `npm run test:unit` | Vitest 前端单元测试 |
| `npm test` | Electron 内核自检，不联网 |
| `npm run build` | TypeScript 检查和 Vite 构建 |
| `npm run package` | 生成便携式发行包 |
| `npm run acceptance` | 真实模型任务验收 |
| `tools/acceptance.mjs` | CDP 驱动界面、读取任务账本和验证产物 |
| `tools/acceptance-cases.mjs` | T1-T8 真实任务定义 |
| `tools/shot-electron.mjs` | Electron 截图 |
| `scripts/selftest.mjs` | 内核安全、恢复和生命周期测试 |
| `data/sessions` | 会话持久化证据 |
| `data/tasks` | 任务账本证据 |
| `data/logs` | 应用和动作日志 |

基础执行：

```powershell
Set-Location E:\CodexWorkbench
npm ci
npm run verify
npm test
npm run package
```

真实验收前必须建立独立 `data`、`workspace`、端口和测试凭证。

## 4. T0：环境和隔离工具

### 4.1 Node、npm 和 Git

Node.js 24.x 是 CI 基线。每个测试批次记录版本、架构、提交和工作区状态：

```powershell
node --version
npm --version
node -p "process.platform + ' ' + process.arch"
git rev-parse HEAD
git status --short
npm ci
```

使用 `npm ci` 而不是随意 `npm install`，确保 lockfile 与依赖一致。测试报告必须写完整 commit SHA，不使用“最新版”描述。

### 4.2 PowerShell

PowerShell 用于启动进程、检查端口、创建隔离目录、采集哈希和清理测试资源：

```powershell
Get-Process Harbor, node, electron -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 9338,5273
Get-FileHash .\dist-portable\Harbor\Harbor.exe -Algorithm SHA256
```

清理只能针对当前 `run_id` 的绝对路径；禁止对 `E:\Harbor`、`E:\CodexWorkbench` 或用户目录递归删除。

### 4.3 隔离方式

测试按风险选择隔离级别：

1. 独立 `test-runs/<batch>/<run_id>` 目录。
2. 独立便携包、`data`、`workspace` 和端口。
3. Windows Sandbox、Hyper-V 或虚拟机快照。
4. 独立 Windows 用户账户。

真实模型、删除、升级、权限和灾难测试至少使用第 2 级隔离；多用户和断电测试建议使用第 3/4 级隔离。

## 5. T1：静态质量工具

### 5.1 TypeScript、ESLint、Prettier

```powershell
npm run typecheck
npm run lint
npm run check:format
npm run check:lines
```

用途分别是类型安全、代码规则、格式稳定和单文件行数门禁。AI 代理不得未经授权使用自动修复覆盖源码；若确需修复，必须留下 Git diff 并重新执行完整门禁。

注意：`electron/**/*.cjs` 不由 `tsc` 覆盖，修改内核后必须执行 `npm test`。

### 5.2 静态工具输出要求

每项保存命令、版本、退出码、完整输出和失败文件。静态检查通过不能代替真实 UI、文件产物和模型验收。

## 6. T2：单元和组件工具

### 6.1 Vitest

```powershell
npm run test:unit
npm run test:coverage
```

覆盖组件、hooks、Zustand stores、schema、迁移、Markdown、流式消息、权限差异、任务时间线和数据导出。代理必须先跑全量，再定位失败文件；不能删除、放宽或注释测试来消除失败。

### 6.2 jsdom 和 Testing Library

适合测试 DOM、输入、焦点、键盘事件、渲染状态和虚拟浏览器行为。它不能证明真实 Electron 窗口、字体、GPU、原生弹窗、文件系统或鼠标坐标，因此 UI 改动还必须进入 T4。

## 7. T3：Electron 内核和安全工具

### 7.1 内核自检

```powershell
npm test
```

`scripts/selftest.mjs` 覆盖路径、配置、会话、凭证、文件安全、Agent 循环、预算、恢复、浏览器、插件、审批、错误、暂停和生命周期。修改 `electron/**/*.cjs` 时必须保存全量结果。

### 7.2 沙箱和产物验证器

每个内核或真实任务代理需要：

- 明确沙箱根目录。
- 允许写入路径和禁止访问路径。
- 操作前后文件清单和 SHA-256。
- 任务账本、动作日志和会话文件。
- 失败现场和清理状态。

路径越界测试必须检查文件确实未被创建或读取，不能只检查错误文字。

### 7.3 IPC 检查

验证 IPC channel 与 `EXPECTED_CHANNELS` 一致；错误参数、窗口关闭、任务取消和未知 channel 不得造成悬挂请求、主进程崩溃或残留子进程。

## 8. T4：真实 GUI 点击工具

### 8.1 Playwright

Playwright 适合页面级点击、输入、键盘、等待、截图、录屏和 trace。推荐用可访问名称、label 或稳定 `data-testid` 定位控件，不依赖脆弱的 CSS 层级或坐标。

接入流程：

1. 用独立端口启动 Electron。
2. 连接 Electron 页面或 CDP 上下文。
3. 执行新建会话、输入、发送、停止、权限和恢复步骤。
4. 为每一步设置超时和失败截图。
5. 保存 trace、控制台错误和页面截图。
6. 由独立验证器检查磁盘产物。

### 8.2 Electron CDP

项目已有 CDP 验收脚本：

```powershell
node tools/acceptance.mjs --app=dist-portable/Harbor --port=9338
```

CDP 可连接页面、查询控件、等待状态、读取控制台和配合任务账本验证。直接调用 store、IPC 或 `Runtime.evaluate` 修改数据只能算诊断测试，不能算真实点击验收。

### 8.3 Windows UI Automation

文件选择器、原生权限弹窗、托盘、任务栏和窗口级操作可使用 WinAppDriver、FlaUI、pywinauto、AutoHotkey 或 Power Automate Desktop。必须固定屏幕、缩放和桌面会话，并记录窗口标题，避免误操作其他窗口。

### 8.4 视觉回归

使用 Playwright screenshot diff、Pixelmatch 或 ImageMagick 保存首次启动、空会话、流式、权限、失败、恢复、窄屏和高 DPI 基线。像素差异需要人工复核，不能自动把所有视觉变化判为缺陷。

## 9. T5：真实模型和任务工具

### 9.1 真实验收

```powershell
npm run package
npm run acceptance
node tools/acceptance.mjs --runs=5
```

验收脚本通过真实 UI 提交任务，并检查 `workspace`、`sessions`、`tasks` 和 `logs`。模型自报成功不能替代文件差异、测试退出码和任务账本。

### 9.2 模型端点要求

记录模型名/版本、端点、协议、超时、重试、token 上限、费用上限和工具权限。必须使用专用、可撤销、限额的测试凭证；不能使用生产 key 或真实隐私工作区。

### 9.3 AI 评测工具

| 工具 | 适合场景 | 接入 Harbor |
|---|---|---|
| Promptfoo | Prompt/模型回归和安全样例 | 读取固定任务集，对比模型结果 |
| LangSmith | Agent trace 和工具链 | 用 task/session ID 关联 trace |
| Langfuse | 自托管成本、token、延迟 | 接收脱敏模型事件 |
| OpenAI Evals | 基准任务 | 将 Harbor 任务作为评测样本 |
| DeepEval | 相关性、事实性、完整性 | 评估脱敏答案和参考答案 |
| 自定义验证器 | 文件、差异、退出码和账本 | 直接读取工作区和任务数据 |

模型质量至少统计任务完成率、事实正确性、工具正确性、修改精度、越权次数、P95 耗时和平均成本。

## 10. T6：安全和供应链工具

### 10.1 秘密扫描

推荐 Gitleaks 扫描源码、Git 历史、日志、截图、录屏、构建输出和报告：

```powershell
gitleaks detect --source E:\CodexWorkbench
```

发现真实密钥时立即停止批次、隔离证据并撤销凭证。

### 10.2 依赖漏洞和静态安全

```powershell
npm audit
osv-scanner scan source -r E:\CodexWorkbench
```

必要时使用 Semgrep 检查命令拼接、路径规范化、临时文件、明文凭证、危险 Electron 配置、未校验 IPC 和 HTML 注入。记录漏洞编号、严重级别、修复版本和例外批准人。

### 10.3 签名和哈希

```powershell
Get-FileHash .\dist-portable\Harbor\Harbor.exe -Algorithm SHA256
signtool verify /pa .\dist-portable\Harbor\Harbor.exe
```

没有签名证书时报告“签名未验证”，不能报告为通过。

## 11. T7：性能、进程和耐久工具

快速采样：

```powershell
Get-Process Harbor, node -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, CPU, WorkingSet64, Handles, StartTime
```

Process Explorer 用于进程树、句柄、DLL、CPU 和内存；Procmon 用于文件、注册表和进程访问；Windows Performance Recorder/Analyzer 用于启动慢、长任务和渲染卡顿。

重点检查：关闭后无 Harbor/Electron/Node/工具残留；凭证不被异常进程读取；临时文件、句柄和内存不持续增长；工作区外没有非预期访问。

## 12. T8：发布、更新、备份工具

| 工具 | 用途 |
|---|---|
| `signtool` | Windows 文件签名 |
| `certutil` | 哈希和证书 |
| 7-Zip | 压缩包清单和完整性 |
| Windows Sandbox | 干净首次启动 |
| Hyper-V/虚拟机 | 快照、断电和回滚 |
| PowerShell ACL | 检查文件权限 |
| robocopy | 保留属性复制测试 data |
| 自定义迁移验证器 | 比较升级前后清单和哈希 |

升级测试必须保留旧版 data 备份、迁移日志、失败现场和回滚结果。不能在无备份的真实用户目录测试破坏性升级。

## 13. T9：Trace、成本和模型质量

每次模型任务至少关联：

```text
run_id、task_id、session_id、model、model_version、prompt_hash
tool_sequence、token_usage、latency_ms、retry_count、error_kind
workspace_before_hash、workspace_after_hash
```

Trace 不得保存完整 API key、Authorization header 或未经脱敏的私人内容。评测工具必须支持固定数据集、重复运行、模型版本比较、人工复核、失败样本导出和 token/费用上限。

## 14. T10：多代理工具和调度

推荐角色：`ORCH` 协调、`STATIC` 静态检查、`UNIT` 单测、`KERNEL` 内核、`PACKAGE` 发行包、`GUI` 点击、`ACCEPT` 真实任务、`SECURITY` 安全、`EVIDENCE` 证据。

每个代理必须有唯一 `agent_id`、`run_id`、端口、data、workspace 和报告目录。GUI 窗口同一时间只能由一个代理控制；真实任务不能共享工作区；失败报告不得被重试覆盖。

建议统一结果格式：

```json
{
  "batch_id": "batch-001",
  "agent_id": "gui-001",
  "run_id": "gui-A-001",
  "commit": "<full-sha>",
  "cases": [
    {
      "case_id": "A07",
      "status": "passed",
      "duration_ms": 18400,
      "evidence": ["screenshots/A07-send.png"],
      "failure_reason": null
    }
  ],
  "cleanup_status": "passed"
}
```

允许状态为 `passed`、`failed`、`blocked`、`skipped`；`skipped` 必须说明原因和后续批次。

## 15. 工具与主测试文档对接

| 主文档章节 | 工具 | 执行代理 | 输出 |
|---|---|---|---|
| 第 6 章分层计划 | npm、TypeScript、ESLint、Prettier、Vitest、Electron | STATIC/UNIT/KERNEL | 门禁报告 |
| 第 7 章功能用例 | Vitest、Playwright/CDP、产物验证器 | UNIT/GUI/ACCEPT | 用例结果 |
| 第 8 章安全 | Gitleaks、OSV-Scanner、Semgrep、Procmon | SECURITY | 安全报告 |
| 第 9 章可靠性 | PowerShell、Procmon、WPR/WPA、虚拟机 | CHAOS | 故障时间线 |
| 第 10 章发行包 | Electron、signtool、certutil、Sandbox | PACKAGE | 包报告 |
| 第 16 章用户旅程 | Playwright、Windows UI Automation、录屏 | GUI | 点击记录 |
| 第 28 章多代理 | Codex 子代理、PowerShell/CI | ORCH | 批次报告 |
| 第 29 章模型质量 | Promptfoo、Langfuse、验证器 | ACCEPT/AI-EVAL | 质量报告 |
| 第 30-31 章发布/供应链 | signtool、npm audit、OSV-Scanner | PACKAGE/SECURITY | 发布安全报告 |
| 第 32-34 章隐私/权限/网络 | Gitleaks、Procmon、代理工具、虚拟机 | SECURITY/CHAOS | 隐私网络报告 |

## 16. 安装优先级

### 第一阶段：直接使用已有项目能力

```powershell
npm ci
npm run verify
npm test
npm run package
npm run acceptance
```

### 第二阶段：补充 GUI 和安全

安装 Playwright、Gitleaks、OSV-Scanner、Process Explorer、Procmon、signtool 和 certutil。此阶段覆盖真实点击、秘密扫描、依赖扫描、进程诊断和签名验证。

### 第三阶段：补充 AI 质量和隔离

按需求加入 Promptfoo、Langfuse/LangSmith、DeepEval、Windows Sandbox、Hyper-V 和 CI matrix。该阶段用于模型回归、成本追踪、多环境和多代理并行。

## 17. 工具引入验收标准

新工具进入发布门禁前必须说明：

- 它解决现有工具无法解决的哪个问题。
- 是否支持 Windows、Node 24 和当前 Electron。
- 是否读取凭证、屏幕、用户数据或网络。
- 输出是否可保存、脱敏、复现和机器汇总。
- 失败退出码、超时和重试行为是什么。
- 是否修改源码、data、注册表或系统设置。
- 如何在独立 `run_id` 目录运行和清理。
- 是否需要管理员权限、网络或付费服务。
- 依赖许可证和供应链是否审查。

没有这些信息的工具只能用于探索，不能作为发布通过依据。

## 18. 最小可用工具组合

资源有限时，推荐：Node.js 24、npm、PowerShell、Git、TypeScript、ESLint、Prettier、Vitest、jsdom、Electron、项目内核自检、CDP/`acceptance.mjs`、Playwright、Gitleaks、OSV-Scanner、Process Explorer、SHA-256/JSON 汇总脚本。

这套组合可以覆盖静态质量、单元、内核、真实点击、真实任务、安全基础、进程清理和证据汇总。模型质量评测、签名更新、虚拟机灾难恢复和长期 trace 可在第二阶段加入。

## 19. 工具报告模板

```text
工具名称/版本：
用途层级：T0-T10
关联主文档章节：
执行代理：
源码提交：
运行目录：
命令/参数：
开始/结束时间：
退出码：
输入数据版本：
输出文件：
是否包含屏幕或用户数据：
脱敏状态：
失败分类：
清理状态：
是否可重现：
```

## 20. 最终工具清单

正式发布级别建议至少具备：

- Node.js 24、npm、PowerShell、Git。
- TypeScript、ESLint、Prettier、Vitest、jsdom。
- Electron、内核 selftest、`acceptance.mjs`、CDP。
- Playwright 或等效 GUI 自动化工具。
- Windows UI Automation 工具，用于原生窗口和系统弹窗。
- Gitleaks、npm audit、OSV-Scanner，必要时加入 Semgrep。
- Process Explorer、Procmon，必要时加入 WPR/WPA。
- `signtool`、`certutil`、Windows Sandbox 或虚拟机。
- 自定义文件哈希、任务账本、日志脱敏和 JSON 汇总工具。
- Promptfoo、Langfuse/LangSmith 或等效 AI trace/评测工具。
- Codex 子代理或 CI 调度能力，用于多代理隔离执行。

所有工具必须按照 [详细测试文档](./详细测试文档.md) 的测试层级、证据要求和发布退出标准接入；只安装工具但没有对应用例、权限、隔离和清理规则，不构成测试通过。
