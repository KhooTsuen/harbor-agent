# 项目约定（给 VS Code 里的 agent）

> ⚠️ **先看 [`AGENT.md`](../AGENT.md)——它是这个项目的唯一真相源**，本文件只是一张索引。
>
> **为什么要有这个文件**：`AGENT.md`（注意没有 `s`）是**Harbor 应用自己**读取并注入
> 每轮对话的（见 `electron/core/project.cjs`）。但 VS Code 的 agent 只认标准名
> `AGENTS.md` 或本文件 —— **也就是说，在此之前 VS Code 里的 agent 看不到任何项目规矩。**
> 这里做桥接，不复制内容 —— 复制就会漂：IPC 通道数、「内核自检 N 项」这类数字，
> 这个月各漂过一次（有一条还写在 CI 里，红了十几次才被发现）。

## 动手前必须知道

- **[`AGENT.md`](../AGENT.md)** —— 硬约束、硬禁区、验证纪律、已踩过的坑。**改任何东西之前先读它。**
- **[`docs/README.md`](../docs/README.md)** —— **文档地图**：想知道某件事该读哪份文档，先看它。
- **[`docs/开发流程.md`](../docs/开发流程.md)** —— 一件事分几阶段、开工前问什么、收工报告写什么。
- **[`docs/约束机制说明.md`](../docs/约束机制说明.md)** —— 这套规矩**靠什么强制**（检查脚本 + git 钩子），以及误报怎么办。
- **[`docs/安全模型.md`](../docs/安全模型.md)** —— 安全边界**实际**怎么实现的，含「这次没做什么」。
- **[`docs/踩坑记录.md`](../docs/踩坑记录.md)** —— 带真实报错的坑。改代码前扫一眼，能省几次返工。
- **[`docs/架构.md`](../docs/架构.md)** —— 一次对话从界面到模型再回来的完整路径。
- **[`docs/improvement-checklist.md`](../docs/improvement-checklist.md)** —— **还缺什么、以及别重复做什么**（逐条对代码核实过）。

## 硬约束（红线）

**完整清单只在 [`AGENT.md`](../AGENT.md)，本文件不复制。**
这份索引开头就写过「复制就会漂」，而它自己确实漂过：AGENT.md 后来加了新的硬约束，
这里还停在旧的条目上。**以后再加约束，只往 AGENT.md 加，不要往这里补编号清单。**

想一次看有没有踩线，直接跑：

```bash
node scripts/check-rules.mjs   # 行数 / 依赖两侧 / 明文密钥 / TODO / AGENT.md / 改动文件数 / 约束机制在位
```

## 改完要跑

```bash
npm run preflight              # 一站式：verify（七步）→ 应用自检 → 打印剩下必须人做的几件事
npm run preflight -- --skip-app # 不想开窗口时（只跑 verify）
node scripts/check-rules.mjs   # 不跑全链时的快速自查
```

想把上面这两件变成「忘了也会被拦住」：`node scripts/hooks/install.mjs`（一次就够）——
它把 git 钩子指向 `.github/hooks`：提交前跑规范检查 + 内核自检，推送前跑全链 `verify`。

`AGENT.md` 里那条链是纯文本，这里是**一条命令**（步骤与 CI 逐项对齐）。另外：

```bash
node tools/line-limit.mjs --all        # 看哪些文件快贴到 300 行了（含 --code-only 开关）
npm run acceptance                     # 真机验收（真模型跑 5 类任务，按产物判定成败）
npm run shot:electron -- --exe=dist-portable/Harbor/Harbor.exe   # 给真机截图（改 UI 必用）
```

> **「测试全绿 ≠ 能用」** —— 本项目有两次事故（发不出消息、流式内容全不更新）**都过了 tsc + lint + 全部测试**。
> 改 UI / 会话 / 发送 / 权限，**必须真跑一遍**。

## 这个仓库的特殊之处

- **`AGENT.md` 是活的**：Harbor 应用每轮对话都会读它并注入。**改规矩就改它**，别在别处再写一份。
- **`.vscode/` 被 gitignore**（本地方便，不是团队约定）；能被团队共享的放 `.github/` 或 npm scripts。
- **行数红线现在有强制**：`.github/hooks/line-limit.json`（本地即时提醒）+ CI 一步。
  以前它靠自觉 —— 2026-09-23 实测破了 3 个文件、**没有任何测试报出来**。
