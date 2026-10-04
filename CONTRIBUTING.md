# 贡献指南

先说清楚这个项目的形状：**它是个人的工作台，不是团队产品。**
所以它没有路线图投票、没有多平台承诺，但**对 bug 报告和小的、明确的改进非常欢迎**。

> 如果你（或未来的 AI 会话）要改代码，**先读 [`AGENT.md`](AGENT.md)**
> —— 那份是硬规矩、验证纪律和踩过的坑，本应用还会把它注入每轮 Agent 对话。规矩以它为准。
>
> 动手时按 [`docs/开发流程.md`](docs/开发流程.md) 走：先分级（小修 / 修 Bug / 新功能 / 大改造），
> 再走对应的主路；发布动作按 [`docs/发布检查.md`](docs/发布检查.md) 逐条勾。

## 环境

- **Node 22.19 或更高**（依赖里好几个包写着 `^22.13.0 || >=24.0.0`；CI 与开发机都在 24 上跑）
- Windows 10/11（开发与打包以 Windows 为主；macOS / Linux 能跑开发版，打包与托盘未验）
- 首次 `npm install` 会装 Electron 与 `node-pty`（后者要现场编译，Windows 上需要 VS Build Tools；仓库里带了 prebuild）

> `node_modules` 的 install scripts 被 npm 拦下时（npm 11+ 默认行为会警告），
> 如果 PTY 起不来，跑一次 `npm approve-scripts node-pty` 或 `npm approve-scripts --allow-scripts-pending`。

## 常用命令

```bash
npm run dev            # Vite + Electron（热更新）
npm run build          # tsc --noEmit + vite build
npm run package        # 打便携版 → dist-portable/Harbor/

npm test               # 内核自检（不联网、不需要 Electron；项数每版都会涨，看输出）
npm run test:unit      # 前端单元测试（vitest）
npm run test:app       # 无窗口跑一遍，打印主进程与渲染层真实状态
npm run pty:check      # 验 node-pty（纯 Node 与 Electron ABI 都要过）

npx tsc --noEmit                                   # 类型（零容忍）
npx eslint src --ext .ts,.tsx                      # 风格
npx prettier --check "src/**/*.{ts,tsx}"           # 格式
```

## 改代码时的硬规矩

这几条不是建议，是**会被守门测试拦下**的：

| 规矩 | 为什么 |
| --- | --- |
| **单文件 ≤ 300 行** | 超了就拆。全仓零例外 |
| **改了行为就改测试**，并做一次**变异测试**（把实现改坏，测试必须变红） | 绿的测试不等于有效的测试 |
| **断言针对行为，不针对字符串**（源码守卫只用于"这东西还在、接线没断"） | 注释被当成代码、守卫搬家失效都踩过 |
| **跨模块传结构时，形状本身要有断言** | 踩过两次：内核返回单个对象、渲染层按数组收；字段名读错但测试用桩编了错的形状 |
| **没实际跑过的代码，不许说"应该没问题"** | 要显式说明哪里没验过 |
| **`scripts/` 不要跑 `prettier --write`** | 检查范围只含 `src/**`，格式化它会白白撑爆行数 |

## 加一个工具

1. 实现放 `electron/core/tools/`，按现有工具的形状导出（`name` / `description` / `parameters` / `run`）
2. 在 `electron/core/tools/registry.cjs` 里登记
3. **风险等级与权限**：写文件 / 跑命令 / 删除必须在 `electron/core/risk.cjs`（或工具自己的声明）里标清楚
4. 加自检：`scripts/selftest/groups/` 里补一组，覆盖"正常调用 / 被权限拦下 / 参数非法"三条
5. 如果它会写文件，确认走 `changeset`（这样用户能整批回滚）

## 提交与 PR

- 一个改动一个提交，提交信息写**为什么**（"修 xxx 因为 yyy"），不只是"改了什么"
- **不要提交**：`data/`（会话、记忆、凭证、审计）、`.env`、`node_modules`、`dist-portable/`、任何密钥
- PR 请说明：改了什么、怎么验证的（跑了哪些命令）、有没有已知边界
- 涉及安全的改动（权限、文件边界、命令执行、MCP、密钥处理）请在描述里**显式点名**

### 提交标题的格式

`<前缀>：<一句话>` —— 前缀从下表挑，**冒号用全角 `：`、后面不空格**；标题一句话说完，
为什么这么改 / 怎么验证的写进正文：`git commit -m "标题" -m "为什么" -m "验证"`。

| 前缀 | 用在 | 以前那些写法，以后都归到左边 |
| --- | --- | --- |
| `功能：` | 新增用户看得见的能力 | 功能：、`feat:` |
| `修：` | 修 bug、修回归、改格式 | 修：、`fix:`、`style:` |
| `拆：` | 只挪结构、行为不变（拆文件、抽模块） | 拆： |
| `检查：` | 测试 / 自检 / 检查脚本 / CI / 钩子 | 测试：、自检：、`test:` |
| `文档：` | 只动 `.md` | `docs：`、`docs:` |
| `规矩：` | `AGENT.md`、流程、约束机制 | 规矩：、`chore:` |
| `收尾：` | 一批活的收口（台账、验证数字） | 收尾：、补上： |
| `杂项：` | 兜底：仓库卫生 / 依赖 / 环境配置 | 加 .gitattributes…、初始提交 |

例：`修：新建对话那条路也要收澄清卡（补漏，真机发现的）`

- 这条只管**以后**：历史那几十笔（`修：` / `测试：` / `test:` / `style:` 混着来）**故意不重写** ——
  重写要强推，`v1.21.0` 那个 tag 和已有克隆都会对不上。
- **已知缺口**：这条**没有机械检查**（提交时不会拦，靠自觉）。要拦就加一个 `commit-msg` 钩子，
  做法见 [`docs/约束机制说明.md`](docs/约束机制说明.md) 第 5 节「怎么加一条新规矩」。

## Issue

- Bug：版本 + 复现步骤 + **脱敏后**的日志（见 [`SECURITY.md`](SECURITY.md) 的"不要贴什么"）
- 功能建议：说清使用场景（"我想在 X 情况下做 Y"），别只说"加个功能"
- **安全漏洞**不要开公开 Issue，走 [SECURITY.md](SECURITY.md) 里的私密渠道
