# 信息架构与页面地图（ui-component-map）

> 只读调研。所有「文件:行号」均来自 HEAD `847cfc3`。

## 1. 信息架构图

窗口 `titleBarStyle:'hidden'`，界面自绘，结构如下（`src/App.tsx:205-297`）：

```
┌───────────────────────────────────────────────────────────────────────┐
│ AppTitleBar  高40px，**横跨整个窗口**（不属任何一栏）        App.tsx:212 │
│  [折叠侧栏] ⌘Harbor  当前对话标题   ·活动·  +N−M   [继续/停止][底部][右栏] │
├──────────┬────────────────────────────────────────────┬────────────────┤
│ Sidebar  │ main（flex-1，aria-label="对话区"）         │ RightPanelHost  │
│ 240/48px │  App.tsx:241                                │ 360px 默认      │
│          │                                             │                 │
│ Sidebar  │  ① MessageList（可滚动，flex-1）            │ RightTabs       │
│ Header   │      空对话→LaunchScreen（开屏）            │  审查/文件/      │
│          │  App.tsx:250                                │  浏览器/成果/    │
│ 项目组   │                                             │  任务/下载/状态/ │
│ 线程行   │  ② Composer（输入区，贴底）                 │  错误            │
│ 空线程   │  App.tsx:255                                │ RightPanel.tsx  │
│          │                                             │  :146-156       │
│ Sidebar  │  ③ BottomPanel（可关，默认关）              │                 │
│ Branch   │  App.tsx:259-265                            │ 内容区按标签切换 │
│ Tree     │                                             │ :164-257        │
│ footer   │                                             │                 │
│ [归档][设置]                                            │                 │
├──────────┴────────────────────────────────────────────┴────────────────┤
│ StatusBar 高28px：[● 就绪/生成中] mode model reasoning [头像] ↑↓tokens    │
└───────────────────────────────────────────────────────────────────────┘
GlobalLayers（叠加层，GlobalLayers.tsx）：
  Onboarding / CommandPalette / SettingsModal / HarborStatsModal / ImageLightbox
  PermissionDialog / ToastViewport / HarborEggs
```

顶栏取代了旧的「每列各一条顶栏」：原因（`AppTitleBar.tsx:20-36`）——窗口隐藏了系统标题栏，界面自己顶到最上沿，原生按钮浮在右上角；顶栏若仍分栏，「三块面板顶栏 + 一层系统边框」不像整体。故顶栏**不做卡片、不加圆角**，背景 `--bg-canvas` + 一条发丝线。

## 2. 逐区域明细

### 2.1 顶栏 `AppTitleBar`（`src/components/layout/AppTitleBar.tsx`）

| 元素 | 行号 | 数据源 | 展示规则 |
|---|---|---|---|
| 折叠侧栏按钮 | :92-100 | `settings.sidebarCollapsed` | 恒在 |
| 品牌标 ⌘Harbor | :103-118 | `BRAND_NAME`；点击=夜航彩蛋（连点5次） | 恒在 |
| 当前对话标题 | :121-123 | `thread.title` | 无对话时「没有打开的对话」；`truncate` |
| 活动文字「正在…」 | :130-135 | `useAgentActive` + `activityLabel(toolRuns, phase)` | **仅运行时出现**，`max-w-[38vw]` |
| 改动统计 +N −M | :137-145 | `useTaskStore.diff`（与右栏"审查"**同源**，`sumDiff`） | 有未提交改动才显示；`hidden sm:flex` |
| 继续/停止 | :159-167 | `sending` | 运行中=停止；否则=继续 |
| 底部面板 / 右栏 | :169-181 | UI store | 恒在 |

> 顶栏右侧四个按钮**刻意不挂 Tooltip**（`hint=""`，`:147-157`）：提示会盖住右栏标签栏。无障碍靠 `aria-label`。

### 2.2 左栏 `Sidebar`（`Sidebar.tsx`）

结构：`SidebarHeader` → 主体（四形态：批量选择 / 骨架 / 已归档 / 正常两栏）→ `SidebarBranchTree` → footer 图标。

| 数据源 | 行号 |
|---|---|
| 项目 `projects` / 线程 `threads` | `Sidebar.tsx:33-35` |
| 折叠态 `settings.sidebarCollapsed` | :37 |
| 搜索 `searchQuery`（含远端消息搜索 `searchSessions`） | :38, :47-59, :134-149 |
| 分组：`grouped`（项目）/`looseThreads`（无项目）/`archivedThreads` | :62-90 |

宽度 `LAYOUT.sidebar`：默认 240 / 最小 220 / 最大 320 / 折叠 48（`constants/index.ts:134`）。折叠后为 `CollapsedSidebar`（:97）。

### 2.3 中栏：消息 + 输入

**MessageList**（`src/components/chat/MessageList.tsx`）：分片渲染最近 N 条（`visibleMessages`），带「载入更早」（:162-171）、自动滚动、分支面包屑。空 `messages` 时：加载中→`MessageSkeleton`，否则→`LaunchScreen`（:138-142）。

**MessageItem**（`src/components/chat/MessageItem.tsx`）：
- 用户消息右对齐气泡；助手左对齐无气泡；系统消息居中（文件头 :24-27）。
- 出错 → 红底块（:76-86）**下面仍排时间线**（:88-95，2026-10-04 改）。
- 只读澄清卡 `message.clarify`（:110-127）。
- `MessageRounds` 时间线（:132-138）。
- `interrupted`（半截回复）提示（:155-159）。
- 代码块 / diff / 终端输出 / 成果 / 来源引用 / 生成图片（:161-238）。
- 回答版本切换 `AnswerVersions`（:245）、操作条 `AssistantActions`（:247-249）。

**MessageRounds → 每一轮**（`message/MessageRounds.tsx:56-96`）：
- `ThinkBlock`（思考，默认折叠，:67-69）
- `ToolLine`（工具，**一行说完**，:74）
- `StreamingMarkdown`（最后一轮流式）/ `Markdown`（历史轮次）
- 打字光标**整条消息只挂一个**（:112-114）。

**Composer**（`src/components/chat/Composer.tsx`）：结构三段（文件头 :23）：
① 输入区 `textarea`（:132-170，高度可拖 `LAYOUT.composer`）
② 工具行：`ToolsMenu` / 加图 / 加附件 / `ModePicker` ‖ 字数计数 / `ModelPicker` / `SendControls`（:173-235）
③ 上下文行 `ComposerContextRow`（:251-255）
输入框上方：`AboveInputCards`（权限条/澄清卡，:74-75）、`PlanBar`（:129）、`NextSteps`/`SuggestionChips`（:245-249）。

### 2.4 右栏 `RightPanel`（`RightPanel.tsx` + `RightTabs.tsx`）

**八个标签**（`RightTabs.tsx:31-41`）：审查 / 文件 / 浏览器 / 成果 / 任务 / 下载 / 状态 / 错误。
标签栏规则（`RightTabs.tsx:61-108`）：**只有当前标签显示文字**，其余仅图标 + `aria-label`/`title`；`diff` 标签带改动文件数；`browser` 标签带「Agent 动过网页」静态圆点。

各标签内容（`RightPanel.tsx:164-257`）：

| 标签 | 组件 | 数据源 |
|---|---|---|
| 审查 diff | `DiffViewer` + `RollbackRecord` | `useTaskStore.diff`（改动事务快照，:111） |
| 文件 | `FileTree` / `FilePreview` | `fsTree(effectiveProject.path)`（:117-135） |
| 浏览器 | `BrowserTab`（`<webview>` **不随标签卸载**，:234-256） | `useBrowserStore` |
| 成果 | `ArtifactsPanel` | artifact API |
| 任务 | `TaskCenter` | `useTaskStore`（:229） |
| 下载 | `DownloadsPanel` | downloads API |
| 状态 | `StatePanel` | 当前对话长期状态 |
| 错误 | `ErrorsPanel` | 内核错误清单（只读） |

**TaskCenter**（`chat/TaskCenter.tsx`）：分组列表 `groupTasks`（:78），只显示非空分组（:80-83），每组标题「标签 · 数量」；`running`/`waiting_user` 两组**不给「清空」**（:31, :226）；下方「可撤销的改动」列表（changesets，:257-286）。

### 2.5 底栏 `StatusBar`（`StatusBar.tsx`）

`[● 就绪/生成中]`（:51-57，读 `sendingThreads.length>0`）· 生图进度（:63-72）· mode · model · reasoning · [头像]（:83-98）· ↑↓ tokens（:102-109）。工作目录**不在**状态栏显示（:33-36，避免与 Composer 重复）。

### 2.6 弹层与覆盖层

`GlobalLayers.tsx:44-57`：Onboarding / CommandPalette / SettingsModal / HarborStatsModal / ImageLightbox / **PermissionDialog**（应用级危险操作）/ ToastViewport / HarborEggs。
另有两类内联确认：**PermissionBar**（内核发起的确认，属于 Composer 布局流，`PermissionBar.tsx:36-123`）、`GateCard` / `ClarifyCard`（澄清与计划闸门）。

## 3. 信息重复矩阵

规范要求的「重复展示同一事实」核对（★ 为重点）：

| 事实 | 出现处 A | 出现处 B | 是否真重复 |
|---|---|---|---|
| 当前在跑（活动文字） | 顶栏 `活动`（AppTitleBar:130-135） | 中栏流式文字/圆点（MessageItem:145-148；MessageRounds:77-80） | 部分重复（措辞不同、位置不同） |
| 改动统计 +N −M | 顶栏（AppTitleBar:137-145） | 右栏「审查」头（RightPanel:184-187） | ★ **同一份数据两处显示**（注释自称「同源」），非竞争源 |
| 任务列表 | 右栏「任务」TaskCenter | 输入区上方 `PlanBar`（Composer:129） | 部分重复（PlanBar 只当前任务计划） |
| 任务进度/相位 | 右栏 TaskCenter → TaskRow | `ProgressTimeline`（对话内） | 同一台账两个视图 |
| 工作目录 | Composer 上下文行（ComposerContextRow） | （状态栏已刻意移除，StatusBar:33-36） | 已收敛 |
| token 用量 | 状态栏 ↑↓（StatusBar:102-109） | 任务行 `TaskTokenBadge` / 设置·用量 | 视角不同（会话 / 任务 / 全局） |
| 错误 | 中栏出错红块（MessageItem:76-86） | 右栏「错误」ErrorsPanel | 视角不同（本条消息 / 内核清单） |
| 未完成任务 | （对话顶部横幅**已撤**，App.tsx:243-247） | 右栏「任务」（启动提示指向它） | 已收敛（AG-028） |
| 「Agent 动过网页」 | 右栏标签角点（RightTabs:97-102） | — | 单点 |
| 模型 / 推理 | 状态栏（StatusBar:74-76） | 输入区 ModelPicker（Composer:215-224） | ★ 同一设置两处显示 |

> 区分：以上多为「**同一实体的多个视图**」（读同一 store），未见「多个互相竞争的状态源」。见 `ui-event-trace.md` 第 4 节。

## 4. 窄屏行为

| 断点表现 | 位置 |
|---|---|
| 顶栏标题 `truncate`；活动文字 `max-w-[38vw]` | AppTitleBar:121, :131 |
| 顶栏改动统计 `hidden sm:flex` | AppTitleBar:139 |
| 状态栏 reasoning / tokens `hidden sm:inline` / `md:inline` | StatusBar:76, :104 |
| 右栏标签非活动态 `sr-only` 文字 | RightTabs:88 |
| 侧栏可折叠到 48px | App.tsx:220 |
| 右栏最小 320 / 最大 480 | constants/index.ts:135 |
