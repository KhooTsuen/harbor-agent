# 真实使用场景与 UX Golden Tasks（现状基线）

> 只读调研。规范要求观察 UX-01~UX-10，每项记录：操作步骤 / 耗时 / 点击数 / 滚动次数 / 关键状态可见性 / 失败困惑点 / 截图索引。
> **本轮只建立现状基线，不宣称改进后指标。** 预览版 mock 数据无法复现真实后台任务，故多项标 `NOT_OBSERVED` / `BLOCKED` —— 不以想象替代实测。

## 观察条件

- 环境同 `ui-baseline.md`。截图来自浏览器预览版（mock 数据）。
- 真实后台任务 / 授权 / 失败 / 完成 / 重启恢复 需要**真实模型 + 真实 data/**，本轮**不具备**（见 `ui-baseline.md` §4）。

## 逐场景

| ID | 场景 | 状态 | 观察结果 / 说明 | 截图 |
|---|---|---|---|---|
| **UX-01** | 新建对话并发送普通问题 | **部分观察** | 新建对话入口：侧栏 header（`SidebarHeader`）/ 顶栏「新建」由 `createThread`（`App.tsx:59,164`）触发；空对话渲染 `LaunchScreen` 开屏（`App.tsx:248-251`、`MessageList.tsx:138-142`）。预览版 `sendChat` 返回「浏览器预览不支持真实模型」（`backend.ts:81`），故**发送后链路未观察**。首次负担：空对话首屏 = 开屏（状态层+性格层+灯塔）+ 输入区；`EMPTY_THREAD_PROMPTS` 给 4 条示例（`constants/index.ts:188-193`） | `02-空对话.png`、`19-首次启动引导.png` |
| **UX-02** | 执行多步骤文件任务 | `NOT_OBSERVED` | 需真实任务。代码层：工具一行摘要 + 默认折叠（`ToolLine.tsx:17-19`）；「当前步骤」靠 `activityLabel`（`AppTitleBar.tsx:130-135`） | — |
| **UX-03** | 查看文件修改与 Diff | `NOT_OBSERVED`（UI 已可点） | 右栏「审查」标签 + diff 折叠（`RightPanel.tsx:165-207`）；授权时 diff 默认折叠（`PermissionBar.tsx:76-107`）。无真实改动可看 | `research-*`（审查为默认标签，见 `06`/`01` 场景） |
| **UX-04** | 运行长任务并持续输出工具事件 | `NOT_OBSERVED` | 滚动稳定性：设计层已证「FREE 模式不被新事件推走」（`useAutoScroll.ts:20-27`）——见 `ui-noise-audit.md` N-IX-01；**行为层未真机验证** | — |
| **UX-05** | 处理高风险授权请求 | `NOT_OBSERVED`（UI 已读） | 内核确认走输入区上方 `PermissionBar`（不遮罩）；应用级危险操作走 `PermissionDialog`（anchored）；两者互斥。见 `ui-safety-visibility.md` §2 | — |
| **UX-06** | 工具失败并重试 | `NOT_OBSERVED` | 失败单独计数不并吞（`ToolLine.tsx:103-108`）；未见「策略拒绝 vs 普通故障」的区分（`ui-safety-visibility.md` §4） | — |
| **UX-07** | 后台任务运行时切换会话 | **部分观察（代码层）** | 「在跑」按对话记（`sendingThreads` 数组，`useAgentActive.ts:23-25`）；切走不影响别的对话（`App.tsx` 注释 `:223`）。预览版无后台任务 | — |
| **UX-08** | 应用重启后返回任务 | `NOT_OBSERVED` | 恢复摘要依赖任务台账 + 会话；未完成任务由启动提示指向右栏（`TaskCenter.tsx` 文件头）；`interrupted` 回复有提示（`MessageItem.tsx:155-159`） | — |
| **UX-09** | 任务部分完成并交付文件 | `NOT_OBSERVED` | 成果在右栏「成果」（`ArtifactsPanel`）；消息内成果块 + 「打开」（`MessageItem.tsx:174-195`）。**无「交付完成」独立态**（`ui-event-trace.md` §6） | — |
| **UX-10** | 窄窗口 / 缩放 / 键盘操作 | **部分观察** | 窄窗口：1024×720 右栏关/开均可用；853px（近似 150% 缩放）下仍可用。键盘：10 个全局快捷键（`constants/index.ts:113-129`），未做键盘实操 | `research-05/06/07` |

## 汇总

| 状态 | 数量 | 场景 |
|---|---|---|
| 部分观察 | 4 | UX-01、UX-03、UX-07、UX-10 |
| `NOT_OBSERVED` | 6 | UX-02、UX-04、UX-05、UX-06、UX-08、UX-09 |

> 6 项未观察的共同原因：**预览版无真实模型与真实后台任务**。
> 要补齐，需**真实打包版 + 隔离数据目录**（避免碰真实会话/密钥）跑一轮，且部分场景（授权、失败）需要人为构造 —— 这属于下一轮方案，本轮不做。
