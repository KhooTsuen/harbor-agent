# M02 侧边栏 UI 面 · 设计

> 规格：《Harbor Agent Browser Extension》M02 —— 侧边栏主界面（对话 / 任务 / 当前网页 / 历史 / 设置）
> + 流式 / Markdown / 代码块 / 复制 / 重新生成 / **停止生成** / 错误重试
> + 任务进度与**等待确认 / 取消 / 暂停 / 接管** + 当前页面上下文**显式开关**
> + 快捷入口（工具栏图标 / 右键菜单 / 选区工具栏 / 快捷键）
>
> 现状：对话区 + 流式 + 会话抽屉已完成（Phase 3b/3c）。这份文档定**剩下的**。

## 0. 一条贯穿全批的判断：先问「数据从哪来」

侧边栏是**扩展**，它拿不到主进程内存里的状态。所以每一项先回答「数据走哪条路」，
再谈 UI。查证结果（`electron/core/ext-chat.cjs` + `src/types/chat-events.ts`）：

| 想显示的 | 数据在哪 | 现在到侧边栏了吗 |
|---|---|---|
| 回复正文（流式） | 渲染层 `chat:event` | ✅ 已有 |
| **正在跑的步骤**（工具名 / 进度） | 同一批事件里的 `tool_start` / `tool_end` / `agent.tool.progress` | ⚠️ **部分**：`PUSH_TYPES` 已含 `tool_start`/`tool_end`，**但 ChatPanel 没接**；`progress` / 相位**没推** |
| **等待确认**（权限卡 / 澄清卡） | 渲染层 `confirm_request` / `askUser` | ❌ 没推 |
| 当前网页（标题 / 能否读） | **扩展自己**（`chrome.tabs`） | ✅ 自己就能拿，不必经主进程 |
| 会话列表 | 主进程 `session:list` | ✅ 已有 |

**结论**：小批 A/B **零新增 IPC 通道**都能做 —— 已有的事件够用，缺的是「扩展侧没用它们」。

## 1. 分批（按价值 / 风险，一步步来）

### 小批 A：Markdown 渲染 + 停止生成（本轮）

**A1 Markdown**：回复正文从 `whitespace-pre-wrap` 纯文本换成真正的渲染。

- ★ **解析必须复用**（硬约束 #9 的实质）：用主应用的 `@/lib/markdown` 的 `parseBlocks` ——
  否则侧边栏与主窗口对同一段文字解析出不同结果（块划分、代码围栏、表格），必然漂。
- 渲染层**先试整块复用** `@/components/chat/Markdown`，用 `lazy()` 动态加载
  （它的链里有 katex 静态 import + `CodeBlock → @/lib/backend`，首屏不该背这个包袱）。
- **退路（真机挂了才走）**：只复用 `parseBlocks`，侧边栏写窄面板用的轻量块渲染
  （纯文本 / 行内代码 / 代码块 / 标题 / 列表 / 表格 6 种），并在文件头如实写「不做
  mermaid / katex / 图片」。**不做的理由**：400px 宽的面板里，公式与图表没有可用性。

**A2 停止生成**：规格点名「**停止按钮真正取消相关请求**」。

链路（**复用渲染层唯一一处实现**，不新增 IPC 通道）：

```
侧边栏「停止」按钮（流式中才出现）
  → SW 新消息 chat-abort
  → host 转发（既有 requestHost）
  → 主进程 ext-chat.handleAbort(sessionId)
      · 没在跑 → {ok:false, error:'这条对话没有正在跑的回复'}（如实，不假装停了）
      · 在跑   → send('chat:event', {type:'ext:abort', sessionId}) + {ok:true}
  → 渲染层 useExtBridge 接住 → stopActiveRequest(sessionId)   ← ★ 现成的，不另写
  → 真实中断后主进程推 aborted 分片 → 侧边栏收到（已有路径）
```

★ 为什么走 `chat:event` 而不是新开 IPC 通道：`ext:send` / `ext:new` 已经这么走
（见 `useExtBridge.ts` 文件头），再加一条同形状的即可 —— 零新增通道。

★ **不**用「侧边栏自己停掉显示」冒充停止：那只是放弃接收，主进程还在跑（规格要求的是
「真正取消」）。所以按钮的回执必须来自主进程。

### 小批 B：任务卡 + 当前网页卡

- **任务卡**（对话区上方，有任务时才出现）：显示
  · 相位（`agent.started` / phase 事件 —— **要把 `phase` 加进 `PUSH_TYPES`**）
  · 当前工具（已在推的 `tool_start` / `tool_end`）
  · 「等待确认」状态（加推 `confirm_request` / `confirm_resolved` 两类）
  · 停止按钮（复用 A2 那条链路）
- **当前网页卡**：**扩展自己**读 `chrome.tabs.query({active,currentWindow})` ——
  显示标题 / 域名 / **能不能读**（activeTab 是否授予，用「读不到 url」当判据，与 M03 同一口径）。
  · 上下文**开关**：一个 checkbox，决定「读当前页 / 观察页面」是否默认带上 —— 状态存
    `chrome.storage`（本地，不进 Harbor）。

### 小批 C：设置区 + 快捷入口

- **设置区**：抽屉形态（与会话抽屉同款，从左侧滑出）。内容：
  · 连接信息（host 名 / 连接状态 / 重试）
  · 本扩展**能力清单**（哪些动作可用 —— 从 `manifest` 的 permissions 现算，不手写）
  · 「站点权限」等**归主应用**的项：只**指路**（写清去主应用哪个设置页），
    不在这里做一个半吊子的第二套（那正是 M07 要做的，别提前分裂）。
- **快捷入口**：工具栏图标已有；右键菜单 / 选区工具栏 / 快捷键要改 `manifest`
  （`commands` + `contextMenus` + `content_scripts`）。**到这一小批时单独评估**：
  content script 是新的权限面（会注入每个页面），与 M07「最小权限」有张力 ——
  先报告再决定，不擅自加。

## 2. 工程约束（这批的头号成本）

**贴线现状**（加代码前必须先腾）：

| 文件 | 行数 | 这批要加什么 | 对策 |
|---|---|---|---|
| `electron/core/ext-chat.cjs` | 298 | `handleAbort` | 先把它已有的一段挪出去（候选：快照管理） |
| `electron/core/ext-ops.cjs` | 297 | 分派表 +1 行 | 压注释 |
| `harbor-edge/extension/service-worker.js` | 300 | `chat-abort` 消息分支 | 把消息分派表挪到 `lib/messages.js` |
| `harbor-edge/src/sidepanel/ChatPanel.tsx` | 299 | Markdown + 停止按钮 | 拆出 `TurnBubble.tsx`（一轮的显示） |

**验收脚本锚点**（改了必须同步 `harbor-edge/lib/ext-probe-panel.cjs`）：
- 现有：`消息输入框` / `回复正文` / `发送提示` / `选择对话` / `当前对话` / `会话抽屉` / `读当前页` / `观察页面`
- **新增（本批）**：`停止生成`（图标按钮 → 只能按 aria-label 找）
- ⚠️ 不变量：`[role=status][aria-live=polite]` **全文档只能有一个**（就是「发送提示」那条）——
  新的卡片**不许**带 `aria-live`（要报告状态用 `role="group"` 或纯文本）。

## 3. 验收方式（每小批各一次）

- 真机（真 Edge + 真扩展 + 真 host）：A → 「发一条 → 看 Markdown 真的渲染出标题/代码块」
  + 「流式中点停止 → 主进程回执 stopped=true + 侧边栏收到 aborted + 主窗口那条真的停了」。
- **反向验证**（比正向更重要）：没有在跑的回复时点停止 → 必须**明确说没停**，不许假装成功。
- 回归：phase2 / 3a / 3b / 3c / m03 / m04a–m04f，零退步。
- 自检：新组 `164-m02-panel.mjs`；`verify` 全绿。
