# 安全策略

## 报告漏洞

**请用 GitHub 的私密渠道**：仓库页 → `Security` 标签 → `Report a vulnerability`（Private vulnerability reporting）。
别开公开 Issue —— 那等于把细节先交给所有人。

报告里尽量带上：

- 版本（设置 → 关于，或 `package.json` 的 `version`）
- 复现步骤（哪一步、什么配置）
- 期望行为 vs 实际行为
- **脱敏后**的日志片段（见下）

我会尽快回。这个项目是个人维护，没有 SLA，但安全问题会优先看。

## 请**不要**贴这些东西

| 别贴 | 为什么 | 替代做法 |
| --- | --- | --- |
| API Key / Token | 公开 Issue 是永久的 | 只描述"用了哪家的 key"，值用 `sk-***` |
| 完整 `data/` 目录 | 里面有会话、记忆、审计、改动快照 | 只贴必要文件，且先删掉正文 |
| 未脱敏的日志 | 日志里有你的工作目录与文件路径 | 用下面的"脱敏日志"做法 |
| 会话 / 诊断包原文 | 诊断包含对话摘要 | 只贴相关那几行 |

**脱敏日志的做法**：日志在 `<应用目录>/data/logs/`。
用编辑器把 `C:\Users\<你的名字>\...` 这类路径替换成 `<path>`，再贴。
应用自带的诊断包（任务 → 详情 → 诊断 → 复制全文）**已经过 `redact` 处理** ——
API Key / Token / Authorization / 私钥一律替换成占位符，只报长度与前后几位。

## 支持范围

只支持**最新 release**。老版本的问题请先升级再看是否仍存在。

## 已知问题

### dev 依赖的安全告警（不影响发布产物）

`npm audit` 会报 5 条（1 critical / 1 high / 3 moderate），全部落在**开发链**上：

```
vitest（critical，路径穿越）· vite（high，dev server 路径穿越）
esbuild / vite-node / @vitest/mocker（moderate）
```

**影响面**：只影响"跑 `npm run dev` 的开发服务器"和"跑测试的环境"，**不进发布产物**
（它们是 `devDependencies`；打包出来的 exe 里 `resources/app/node_modules` 不含它们 —— 可以自己
`ls dist-portable/*/resources/app/node_modules | grep -E 'vite|esbuild|vitest'` 验证）。

**为什么没顺手升**：修它们要跨主版本（vite 5 → 8、vitest 3 → 5），会牵动整条构建与测试链，
属于"要单独验证一轮"的改动，不适合和发布准备混在一起。计划在发布后的版本里做。

## 这个应用的安全设计（供报告者判断边界）

| 面 | 设计 |
| --- | --- |
| 数据 | 全部在本机 `data/`；除模型接口外不发网络请求；无遥测、无账号、无云同步 |
| 密钥 | 主进程用系统凭证库（Windows DPAPI / macOS Keychain）加密存 `data/credentials.json`；**不下发给渲染层** |
| 渲染层 | `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`；只能通过 preload 暴露的白名单 IPC 访问主进程 |
| 文件 | 默认限定工作目录；软链接/联接点用 realpath 校验；敏感文件单独授权；删除需要更高权限 |
| 命令 | 四档风险（low / medium / high / critical）；`critical` **即使把策略设成"直接执行"也会拦** |
| MCP | 子进程默认只拿白名单环境变量；即使用户显式开启"继承环境"，也会过滤密钥类变量 |
| 日志 | 全局 `redact` 脱敏；会话落盘前也会 scrub |
