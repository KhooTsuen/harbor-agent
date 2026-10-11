# 安全与关键状态可见性（ui-safety-visibility）

> 只读调研。行号来自 HEAD `847cfc3`。本文件回答规范第 8 节的「默认可见性矩阵」。

## 1. 默认可见性矩阵

| 事件 | 必须要求 | 现状 | 证据 | 结论 |
|---|---|---|---|---|
| **授权请求** | 右栏折叠也能发现；有操作对象和风险说明 | 内核确认走 `PermissionBar`，挂在 **Composer 布局流**（输入框上方），**不是右栏**；不遮罩 | `PermissionBar.tsx:8,36-123`；`AboveInputCards.tsx:49-57` | ✅ 与右栏无关，折叠右栏不影响发现 |
| | | 风险说明：危险项 `danger` → 红底 + 警示图标 + 主按钮变 danger | `PermissionBar.tsx:43-51,116` | ✅ |
| **文件删除/覆盖** | 影响范围、是否可撤销、确认入口清晰 | 写文件类确认带 **diff 预览**（默认折叠「+N −M / 查看 Diff」）+ `diffNote` + `impact[]` | `PermissionBar.tsx:63-110`；`PermissionDialog.tsx:102-147` | ✅ 影响范围有 |
| | | 可撤销：写操作进「改动事务」，可在右栏「任务」→「可撤销的改动」回滚 | `TaskCenter.tsx:257-286`；`RightPanel.tsx:167-168` RollbackRecord | ✅（但入口在右栏，见 §3） |
| **工具失败** | 不得被成功事件聚合吞没 | `ToolLine` 失败单独计数「· N 个失败」并标红图标；**不并入成功** | `ToolLine.tsx:69,88-89,103-108` | ✅ |
| | | 事件名自带成败（`agent.tool.failed`），前端不再读 `ok` 判 | `chat-events.ts:41-42` | ✅ |
| **部分完成** | 不得误显示为完整成功 | 半截回复读回标 `interrupted`，界面明说「这条回复没写完」 | `session-read.cjs:84-91`；`MessageItem.tsx:155-159` | ✅ |
| | | 暂停/轮数用尽有专门返回值与文案（`paused:true` / `exhausted:true`） | `loop-result.cjs:21-32,35-65` | ✅ |
| **安全策略阻断** | 区分策略拒绝与普通运行故障 | ⚠️ **待验证**：工具失败统一为 `agent.tool.failed`，未见独立的「策略拒绝」事件类型 | `chat-events.ts:41-42`（无 policy-denied 形态） | ⚠️ 见 §4 |
| **暂停/取消/恢复** | 状态可追踪、不出现假进度 | 相位 + 语义色统一；**没有百分比进度条**（无假进度） | `statusLanguage.ts:61-76,170-195`；`ui-event-trace.md` §4 | ✅ |
| **敏感信息** | 日志/通知/截图/摘要不泄露密钥 | 全局 `redact.cjs`：落盘前精确+模式脱敏；会话/审计/导出/诊断都过它 | `redact.cjs`；`session-io.cjs:111` | ✅（注：本文件写作时该项目刚修过一处脱敏破坏 JSON 的问题，见仓库 CHANGELOG） |

## 2. 两条授权 UI 的分工（避免重复弹窗）

| 来源 | 组件 | 形态 | kind 判据 |
|---|---|---|---|
| 内核发起（跑命令 / 写文件 / MCP） | `PermissionBar` | 输入区上方内联条，**不遮罩** | `kind === 'run-command'`（`PermissionBar.tsx:19`） |
| 应用自身危险操作（删对话 / 清任务 / 清数据） | `PermissionDialog` | `Modal variant="anchored"`，`disableBackdropClose` | `kind !== 'run-command'`（`PermissionDialog.tsx:40`） |

两者**互斥**（各自 return null 掉对方那一类），不会同屏出现两套 UI。
澄清卡与权限条**只显示一张**，仲裁在 `lib/clarify.ts` 的 `pickAboveInput`：澄清让权限（权限 5 分钟超时即视为拒绝，不能被澄清压在后面）——`AboveInputCards.tsx:10-11,30-33`。
被压住的那张 **不卸载**，只 `hidden`（避免丢掉用户已勾选的选项）——`AboveInputCards.tsx:13-14,51-56`。

## 3. 右栏关闭时，关键信息还找得到吗？

| 关键信息 | 右栏关后是否可见 | 证据 |
|---|---|---|
| 授权请求 | ✅ 可见（在输入区上方） | `PermissionBar` 属 Composer 流 |
| 危险操作确认 | ✅ 可见（模态，anchored 贴输入区） | `PermissionDialog.tsx:49-56` |
| 当前消息出错 | ✅ 可见（中栏红块 + Toast） | `MessageItem.tsx:76-86`；`Toast.tsx:79-94` |
| 实时的活动文字 | ✅ 可见（顶栏 + 中栏） | `AppTitleBar.tsx:130-135` |
| **内核「错误」清单入口** | ⚠️ **不易发现** —— 右栏标签栏对 `errors` **没有角标**（只有 `diff` 计数、`browser` 圆点） | `RightTabs.tsx:89-102` |
| 「可撤销的改动」入口 | ⚠️ 在右栏「任务」里（TaskCenter 内），右栏关则看不到 | `TaskCenter.tsx:257-286` |
| 未完成任务 | ⚠️ 入口在右栏「任务」；对话顶部横幅已撤（AG-028），仅靠启动提示指向 | `App.tsx:243-247`；`TaskCenter.tsx` 文件头 |

**发现的问题（P2，证据确凿）**：`RightTabs` 只给「审查」标了数量、给「浏览器」标了「Agent 动过网页」的圆点；**「错误」标签没有任何角标**。当内核在出错现场记了一条错误、而用户正看着对话区（或右栏关着）时，**没有任何提示指向那个标签**。规范第 8 节明确要求「安全策略阻断要区分并可见」。

## 4. 「策略拒绝」与「普通故障」的区分（待验证）

- 现状：工具失败只有 `agent.tool.failed` 一种事件（`chat-events.ts:41-42`），前端据此把该条记录标红。
- 内核侧**有**能力边界提示（`boundary` 事件，`chat-events.ts:127-136`），但它明确是「**只是提示，不是拦**」。
- **未见**独立的「被安全策略拒绝」事件类型或状态。因此「策略拒绝」在 UI 上与「命令本身报错」**看起来一样**。
- ⚠️ 标记为**待验证**：需内核侧确认是否存在策略拒绝专用返回（如 `risk.cjs`/`capability.cjs` 的拒绝路径是否复用 `agent.tool.failed`）。本轮只读且未做真机，故不下定论。

## 5. 通知策略（规范第 7 节「通知」）

| 事件 | 通知方式 | 证据 |
|---|---|---|
| 后台任务完成/失败 | 系统通知（主进程判断窗口是否在前台）+ Toast | `useTaskNotifications`；`AG-029`（`subscriptions.ts:55-58`） |
| 需要用户确认 | 通知带 `kind:'confirm'`，点击跳回对话并亮卡片 | `subscriptions.ts:63-66`；`AboveInputCards.tsx:35-47`（聚焦+滚入视野） |
| Agent 动网页 | 通知带 `kind:'browse'`，跳回对话并落到浏览器标签；右栏标签加静态圆点 | `subscriptions.ts:66-68`；`RightTabs.tsx:97-102` |
| 生图完成/失败 | Toast（不打断） | `useBackendSubscriptions.ts:91-115` |
| 插件热插拔 | Toast | `useBackendSubscriptions.ts:55-62` |
| 轻提示自动消失 | 4.2s；带行动按钮 9s | `Toast.tsx:20-22` |

同类合并：**未见**「同一类事件合并同类项」的逻辑（如多条工具失败合并成一条通知）。属 P3 观察项。

## 6. 可访问性（本轮未实测 → NOT_TESTED）

可读到的实现（**未真机验证**）：

| 项 | 现状 | 证据 |
|---|---|---|
| 键盘导航 / 焦点顺序 | 顶栏按钮用 `IconButton`（带 `aria-label`）；权限条 `role="dialog"`；`Modal` 有焦点管理 | `PermissionBar.tsx:37-41`；`AppTitleBar.tsx:93-99` |
| 屏幕阅读器标签 | 侧栏 `aria-label="侧边栏"`、右栏 `aria-label="右侧面板"`、主区 `aria-label="对话区"` | `Sidebar.tsx:102`；`RightPanel.tsx:144`；`App.tsx:241` |
| 焦点可见性 | `Modal`/`Button` 有 focus 类；右栏标签 `aria-current` | `RightTabs.tsx:76` |
| 键盘快捷键 | 全局 10 个可配（`SHORTCUTS`） | `constants/index.ts:113-129` |
| 颜色对比 | 未测 | `NOT_TESTED` |
| 缩放 125%/150% | 未测（本轮仅用 853px 视口近似，见 baseline） | `NOT_TESTED` |
| 长文本截断 | 多处 `truncate`，但**截断后无 title 的地方**需逐处核（如顶栏标题 `AppTitleBar.tsx:121-123` 无 title） | 见 `ui-noise-audit.md` |
| 减少动态效果偏好 | 有 `animations` 与 `asciiReducedMotion` 设置；**未见**跟随系统 `prefers-reduced-motion` 的读取 | `useSettingsStore.ts` 默认值；`animations`/`asciiReducedMotion` |

| 项 | 状态 |
|---|---|
| 键盘导航实测 | `NOT_TESTED` |
| 屏幕阅读器实测 | `NOT_TESTED` |
| 150% 缩放实测 | `NOT_TESTED` |
| 减少动效偏好实测 | `NOT_TESTED` |
