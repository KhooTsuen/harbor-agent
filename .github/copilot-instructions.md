# 项目约定（给 VS Code 里的 agent）

> ⚠️ **先看 [`AGENT.md`](../AGENT.md)——它是这个项目的唯一真相源**，本文件只是一张索引。
>
> **为什么要有这个文件**：`AGENT.md`（注意没有 `s`）是**Harbor 应用自己**读取并注入
> 每轮对话的（见 `electron/core/project.cjs`）。但 VS Code 的 agent 只认标准名
> `AGENTS.md` 或本文件 —— **也就是说，在此之前 VS Code 里的 agent 看不到任何项目规矩。**
> 这里做桥接，不复制内容（复制就会漂 —— 这个月的 `101` 通道、`1500+` 项自检都漂过）。

## 动手前必须知道

- **[`AGENT.md`](../AGENT.md)** —— 六条硬约束 + 验证纪律 + 已踩过的坑。**改任何东西之前先读它。**
- **[`docs/安全模型.md`](../docs/安全模型.md)** —— 安全边界**实际**怎么实现的，含「这次没做什么」。
- **[`docs/踩坑记录.md`](../docs/踩坑记录.md)** —— 十条带真实报错的坑。改代码前扫一眼，能省几次返工。
- **[`docs/架构.md`](../docs/架构.md)** —— 一次对话从界面到模型再回来的完整路径。
- **[`docs/improvement-checklist.md`](../docs/improvement-checklist.md)** —— **还缺什么、以及别重复做什么**（逐条对代码核实过）。

## 硬约束（红线）

1. **类型零容忍** —— `tsc --noEmit` 必须 0 错误；禁 `any` / `@ts-ignore` / `eslint-disable`。
   ⚠️ **`.cjs` 不参与 tsc** —— 改 `electron/` 只跑 typecheck 等于没验，**必须**跑内核自检。
2. **单文件 ≤ 300 行**（`.ts/.tsx/.cjs/.mjs` 全算）—— 现在有自动检查了（见下）。
   拆的时候注意踩坑记录里那两个坑：**切片范围容易切多**、**拆一半留空占位**（后者 tsc 全绿但流式内容全不更新）。
3. **数据只落 `data/`** 4. **密钥绝不进 `config.json`**（走 `credentials.cjs`，落盘/外发一律过 `redact`）
5. **改数据结构必须写迁移**，且保留旧数据 6. **不轻易引原生依赖**（node-pty 的三个坑踩过一遍）

## 改完要跑

```bash
npm run verify          # typecheck → lint → 格式 → 行数红线 → 单测 → 内核自检 → 构建
```

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
