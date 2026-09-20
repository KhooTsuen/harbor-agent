# AGENT.md —— 在这个仓库里干活之前先读

> 这份文件是给**任何要改这个项目的 AI 助手**看的（ChatGPT / Claude / 本应用自己的 Agent）。
>
> 本应用也会**自动读它并注入到每轮对话**（见 `electron/core/project.cjs`），
> 所以它同时是「项目规矩」的唯一来源 —— **改规矩就改这里，别在别处再写一份。**

---

## 这是什么

本地优先的个人 AI Agent 工作台。Electron 主进程 + React/TypeScript 渲染层，
模型走任何 OpenAI 兼容接口。

它**不是** Codex 的仿制品，也不隶属于任何厂商。产品标识统一是
`personal-agent` / `Personal Agent`。老代码里可能残留 `codex` 字样，
那**只在迁移常量和 CHANGELOG 里**（迁移要用旧名识别旧数据），别往新代码里带。

## 一句话原则

> 本地优先、透明、可恢复、可回滚。**用户永远拥有数据、密钥和最终控制权。**

拿不准怎么做时，按这个原则推：宁可多问一次、多记一条日志、多留一个回滚点，
也不要"为了流畅"替用户做决定。

---

## 先读这四份（它们是唯一真相源）

| 文件 | 回答什么 |
|---|---|
| `README.md` | 有哪些功能、目录结构、怎么跑、已知取舍 |
| `docs/安全模型.md` | 安全边界**实际**怎么实现的（含**「没做什么」**） |
| `docs/改造任务/PROGRESS.md` | 改造做到哪一步、P0/P1/P2 逐条状态、验收自查 |
| `CHANGELOG.md` | 最近改了什么、**为什么**这么改 |

---

## 硬约束（红线，别越）

1. **类型零容忍** —— `npm run typecheck` 必须 0 错误。
   禁 `any`、`@ts-ignore`、`eslint-disable`。外部数据（磁盘 / 网络 / localStorage）
   进来先过 `src/lib/schemas.ts` 的 zod 校验。
2. **单文件 ≤ 300 行**（`.ts` / `.tsx` / `.cjs` / `.mjs` 都算）。

   - **现在一个超标的都没有了**（`electron/`、`scripts/`、`tools/`、`src/` 全算），
    不许再破。加新代码前先想清楚它该住在哪个文件里。
   - 2026-09-14 之前那批历史欠债（`main.cjs` 611、`loop.cjs` 576、
     `selftest.mjs` 1193…）已经拆完，拆法与踩到的坑见
     [`docs/踩坑记录.md`](docs/踩坑记录.md)。

   拆的时候注意两个坑（都踩过）：
   - **切片范围容易切多** —— 一次替换把相邻的函数一起搬走了，而且 tsc 照样过
   - **拆一半比不拆更糟** —— 我曾在主流程里留个空函数占位就以为拆完了，
     tsc 全绿但流式内容、工具过程全都不再更新。**层与层之间的接线，测试照不到**
3. **数据只落 `data/`** —— 见 `electron/core/paths.cjs`。任何持久化之前先问：
   它该不该在 `data/` 下。不写 C 盘、不写系统目录。
4. **密钥绝不写进 `config.json`**。走 `electron/core/credentials.cjs`（系统加密），
   配置里只留 `credentialRef`。任何要落盘或外发的内容
   （日志 / 会话 / 导出 / 诊断 / 审计 / 错误信息）**必须**过 `electron/core/redact.cjs`。
5. **改数据结构必须写迁移**。用户已经有真实数据（会话、记忆、配置），
   让他的数据消失是不可接受的。迁移要**保留旧数据**，不要就地删。
6. **不要轻易引入新的原生依赖**。引之前先读 README 里 node-pty 那段 ——
   装不上 / 打包漏拷 / ABI 不对，三个坑都踩过一遍。
   能用 Electron 内置的（比如 `safeStorage`）就别引第三方。

---

## 验证纪律（最容易偷懒、后果最严重的一环）

改完至少跑：

```bash
npm run typecheck && npm run lint && npm run test:unit && npm test && npm run build
npm run package && (cd dist-portable/Harbor && ./Harbor.exe --self-test)
```

**三条必须知道的事：**

- **`.cjs` 不参与 `tsc`。** 只跑 typecheck 等于没验内核。
  改 `electron/` 下的东西**必须**跑 `npm test`（脚本名叫 selftest，
  它直接 require 内核模块，不需要 Electron、不联网）。
- **打包后必看 `channelsOk`。** `--self-test` 会清点 101 个 IPC 通道 ——
  handler 注册块中间抛错时，后面的会**静默不注册**（窗口照开、只弹个错误框）。
  这条就是被真实踩中之后加的。
- **测试全绿 ≠ 能用。** UI / 会话 / 发送 / 权限相关的改动，
  **必须真的走一遍**。这条不是"最好这样"—— 有过两次教训：一次是
  `config.hasKey is not a function`（发不出消息），一次是拆函数留空占位
  （流式内容全不更新），**两次都过了 tsc、lint 和全部测试**。
  项目里有工具：

  ```bash
  npm run shot:electron                        # 给打包版截图
  npm run shot:electron -- --type="python"     # 往终端敲真键盘事件再截图
  npm run shot:electron -- --js="..."          # 先执行一段 JS（点按钮/填输入框）再截图
  ```

  它用 CDP 连**打包后的真应用**，能点标签、填输入框、读回 DOM 文本。
  浏览器预览用 `npm run shot`（vite preview + headless Chrome）。
- **看不到的就说看不到。** 渲染效果、别人的机器、真实网络行为 ——
  没观察到就不要断言。声明的每一件事，要么指得住一个可跑的验证，
  要么指得住一次实际观察。

---

## 已经踩过的坑（别重复踩）

**完整清单在 [`docs/踩坑记录.md`](docs/踩坑记录.md)** —— 十条，每条带真实报错信息。
改代码前扫一眼，能省掉几次返工。

最常踩的三条：

- **`tsc` 查不到 `.cjs`** —— 改内核只跑 typecheck 等于没验
- **测试全绿 ≠ 能用** —— 两次事故（发不出消息、流式内容不更新）都过了全部测试
- **重构时"漏内容"** —— 分层/拆分保证了结构，但内容可能掉了
- **搬走的函数引用了留在原地的常量** —— `.cjs` 不过 tsc，`node --check`
  只查语法不查未定义变量，所以这类错误只能靠真跑一遍才发现

## 关键文件在哪

```
electron/core/       内核（不依赖 Electron，可单独测）
  paths.cjs            数据目录（一切路径从这里来）
  config.cjs           配置读写（默认值/校验在 config-defaults / config-normalize）
  credentials.cjs      凭证库（safeStorage / DPAPI）
  redact.cjs           全局脱敏（记名 + 模式两道）
  capability.cjs       文件访问范围（默认只给工作目录）
  risk.cjs             Shell 风险分级（低/中/高/危急）
  audit.cjs            工具调用审计
  task.cjs             任务 + 检查点 + 续做
  changeset.cjs        改动事务 + 整批回滚
  llm.cjs / loop.cjs   模型请求 / Agent 循环
  tools/               模型能调的工具（一个文件一个）
electron/handlers/   IPC 分组
src/stores/          zustand（app / thread / settings / ui / config）
src/components/      渲染层（ui / chat / layout / settings）
src/constants/       设计值的唯一来源
docs/                安全模型 + 改造进度
scripts/selftest.mjs 内核自测（改内核必跑）
tools/shot*.mjs      截图 / 驱动真应用（改 UI 必用）
```

---

## 改完要做的收尾

- **`CHANGELOG.md` 加一节**：写清「为什么改」而不只是「改了什么」。
  踩过的坑也写进去 —— 那是这个项目最值钱的部分。
- **数值只在唯一文档定义**，其他地方只引用、不复制。
  复制了就会漂（README 里的测试项数就漂过一次）。
- 改到 UI 时截图放 `shots/`，别只写"已修复"。
- 改到安全边界时**同步更新 `docs/安全模型.md`**，包括「这次没做什么」。

---

## 给「另一个模型」的交接说明

要把这个项目交给别的模型协助时，把这几份一起给它（按重要性）：

1. **`AGENT.md`**（这份）—— 规矩和坑，先看这个
2. **`docs/安全模型.md`** —— 安全边界，避免它写出破坏边界的代码
3. **`docs/改造任务/PROGRESS.md`** —— 做到哪了、哪些还没做（省得它重复做或漏做）
4. `README.md` + `CHANGELOG.md` 最近几节 —— 结构和近期改动

**不要**只给它「帮我改个功能」这样一句话：这个项目里很多约束
（密钥不外泄、每句话可回滚、单文件 300 行、改内核要跑 selftest）
是踩坑换来的，不写进上下文它就会重新踩一遍。
