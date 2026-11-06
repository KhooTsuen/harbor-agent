# Harbor 新版设置工作区 —— 信息架构与旧功能覆盖核对（V2 修订 · 2026-11-07）

> 性质：**设计与实现映射核对**。本轮不改任何源码、不重构界面、不新增内核能力。
> 依据：`E:\CodexWorkbench` 当前工作区（HEAD `a0d4dcf`）源码 + 只读脚本统计。
>
> **版本**：V1（首轮全量核对）→ **V2 = 三个产品决策已定 + 六项归属修正 + 用量口径修正**。
> V2 只补查修订涉及的缺失证据，没有重做全仓架构审查；V1 的源码依据全部保留。
>
> **验证层级**（每条结论后面标一个）：
> - `L1` 源码确认 —— 指得住文件与行
> - `L2` 脚本统计 —— 用只读脚本扫全量组件/字段后得到的数字，可复跑
> - `L3` 运行时观察 —— 需要真机才能确认，**本轮未做**
> - `推断` —— 根据设计描述推断，源码未直接印证

---

## 0. 已确定的产品决策与修订后的迁移边界（V2 核心）

三条决策已定，**不再是待拍板项**。每条都写明它对 V1 结论的推翻/收窄。

### 决策 1：不保留全局「简洁/详细」切换

- **定的内容**：不把「简洁/详细」做成**隐藏整个页面**的机制。13 页全部可发现；页面内部的高级设置与危险操作**按需展开**（页内折叠）；实际安全约束仍由**运行时**负责。
- **推翻 V1 §3.6**：V1 把它列为「需要你拍板的设计取舍」并倾向保留 `detailedOnly`。**现按决策作废** —— `detailedOnly` 不再作为隐藏页面的机制。
- **边界（重要区分）**：

  | 保留 | 去掉 |
  |---|---|
  | 页内「高级 / 危险操作」可折叠（默认收起） | 整页从侧栏消失 |
  | 运行时拦截（`risk-gate` / `pre-write-gate` / `capability` / `STOP_PHRASES`） | 靠「用户看不见这页」来降低风险 |

- **源码影响**：`parts.tsx` 的 `detailedOnly` 标记 + `hiddenTabsOf` / `visibleTabsOf` 两函数（`SettingsModal.tsx:8` 在用）失去用途 → 归 **B 类**（删机制 + 页内折叠组件），不是 C。
- **安全不降级（L1 核对）**：三档权限、只读档、敏感文件授权、高风险确认全部在内核（`capability.cjs` / `risk-gate.cjs` / `pre-write-gate.cjs`），**与设置界面可见性无关**。所以去掉这层 UI 保护不改变任何实际约束 —— 这条是决策成立的依据。

### 决策 2：通知三档统一迁入「外观与通知」

- **定的内容**：三档统一在设置页管理；右栏通知中心**保留状态摘要与跳转入口**，不保留第二套独立编辑控件。
- **推翻 V1 §3.2 的两个选项**：V1 给了「迁走 / 双入口」两条路。**现定为迁走**（唯一编辑源）。
- **源码影响**（**B 类**）：
  - `src/components/layout/NotifyPanel.tsx:74` 起的 `ROUTE_OPTIONS` 三档单选 + `:120` 的 `updateSettings({ notifyRoutes })` → **移除**，换成一行摘要（「哪些进这里：出错与确认弹卡片，其余只进通知」）+ 一个「去设置调整」按钮（`openSettings('appearance')`）。
  - 三档编辑组件移到「外观与通知」页。数据源不变（`Settings.notifyRoutes`，localStorage）。
- **不能丢的东西**：`NotifyPanel` 的**其它**职责（通知列表、清空、未读）保留 —— 决策只说「不保留第二套独立编辑控件」，没说把通知中心本身砍掉。

### 决策 3：设置走 Harbor 应用内部完整主区工作区，不用 Modal

- **定的内容**：主区工作区；窗口与内容**动态自适应**；**不改变主窗口尺寸**；必须保留聊天、草稿、Agent 任务连续性。
- **推翻 V1 §3.8 的分支**：V1 给的是「扩 Modal / 改主区」二选一。**现定为改主区**。
- **⚠️ V2 新发现的技术风险（V1 没看到，这条是决策落地的最大坑）**：
  现在 Modal 能做「不打断聊天」是因为它在主区**之外**条件渲染：
  ```
  App.tsx:  <Sidebar /> + <main>聊天区</main> + <GlobalLayers><SettingsModal/></GlobalLayers>
  ```
  `{settingsOpen ? <SettingsModal /> : null}`（`GlobalLayers.tsx:49`）卸载的只是 Modal，**主区聊天组件一直挂着** → 草稿、滚动位置、流式状态自然保留。
  **改成主区视图后，如果也照抄这个条件渲染**（`settingsOpen ? <设置/> : <聊天/>`），聊天区会被**卸载** → `useThreadStore` 的 `drafts` 虽在 store 里（不丢字），但**滚动位置、正在流式的消息视图、Composer 内部状态**全没了，「保留连续性」直接不成立。
  - **要求（B 类实现约束）**：**优先**「两视图同时挂载 + CSS 显隐（`hidden` / `display:none`）」，**不用条件渲染**。也允许**等效实现**（如主区内的第三栏覆盖层、聊天仍在 DOM 里），但必须由下面的验收判据**证明等效** —— 验收不看实现方式。
  - **验收判据（唯一，与实现无关）**：从聊天切到设置、在设置里点 5 次不同页面、再切回聊天 —— ①草稿文字 ②滚动位置 ③**流式中的消息视图仍在更新** ④正在跑的任务进度条 —— **逐项还在**。这条要真机验（本轮 L3 未做）。
- **`onboarding` 同形**：`GlobalLayers.tsx:47` 也是条件渲染。设置改主区后要一并核对它是否会被新的布局分支误卸载。

### 决策 4：「模型与服务商」四个主标签 + `AssistantPanel` 拆分

- **定的内容**：四个主标签 —— **服务商** / **模型与场景** / **运行策略** / **双模型协作**。
- **要回答 V1 遗留的问题**：`AssistantPanel` 的字段要不要拆到两页？→ **要拆**。判据不是「页好看」，而是**谁读它、进哪一层**（L1）：

| 字段 | 读它的地方 | 所在层 | 归属 |
|---|---|---|---|
| `assistant.name` | `loop-prompt.cjs:212`（`assistantName` 进 environment 层）、`loop-prompt.cjs:215`、`diagnostics.cjs:85` | **提示词层**（「你是谁」） | **对话与任务**（全局默认·人设） |
| `assistant.systemPrompt` | `loop-prompt.cjs:277`（覆盖内置人设，内置那份才带环境与工具清单） | **提示词层** | **对话与任务**（同上） |
| `assistant.responseDepth` | `loop-prompt.cjs:213` → `prompt-stack.cjs:200`（写进系统提示「回答深度：…」）；**另有会话级覆盖** `ThreadSettingsTab.tsx:23` | **提示词层 + 会话覆盖** | **对话与任务**（同上） |
| `assistant.model` | `loop-model.cjs`（选哪个后端） | 路由层 | 模型与服务商 · 模型与场景 |
| `assistant.temperature` / `maxTokens` | `llm.cjs`（请求参数） | 请求层 | 模型与服务商 · 模型详情 |
| `assistant.historyLimit` | `history-window.cjs`（轮次预算，P1 已改「一轮算一位」） | 窗口层 | 模型与服务商 · 模型详情 |
| `planFirst` / `clarifyFirst` / `scaleFirst` / `scaleHardSeconds` / `verifyAfterEdit` / `strictMode` / `streamOutput` | `AssistantSwitches.tsx:70/78/98/112/129/138/146` → 各自内核模块 | **运行时行为** | 模型与服务商 · **运行策略** |

- **为什么不按组件整体搬**：这三类在代码里本来就是**三层**（提示词 / 路由 / 行为）。按层分页，以后改哪一层就去哪一页；按组件搬，人设和 `temperature` 会并排摆着，用户会以为调 `temperature` 也会改「性格」。
- **源码影响（B 类）**：`ProviderPanel.tsx` 的 `AssistantPanel` 拆成三段（人设 / 模型详情 / 运行策略）分别挂到两页；`AssistantSwitches` 整块进「运行策略」，**内部不动**。
- **必须一起写的说明**：`responseDepth` 有**会话级覆盖**，搬到「对话与任务」后要标「全局默认 + 本次会话可覆盖」，否则用户改了全局发现某条会话没变，会以为没生效。

### 决策 5：`pricing` 内置价目表不新增用户编辑入口

- **定的内容**：不提供单价编辑；**新版实际费用不依赖本地价格估算**；保留旧配置兼容（老盘上的 `pricing.*` 原样读回，不迁移、不丢）。
- **对 V1 §3.1 的收窄**：V1 把 `pricing.*`（15 个叶子字段）记成「半缺口，若要可编辑属 B」。**现明确为不新增入口** —— 价目表折算出来的数**不是实付金额**，让用户编辑只会造出更可信的错数。
- **落地口径（与 §3.3 的费用三分一起看）**：价目表折算值要么不显示，要么必须标「按内置价目表折算，不是实付」。旧展示按真实数据能力**逐步清理**，不一次性删（兼容期）。
- **源码影响**：`pricing-defaults.cjs` 不动；`CostBreakdown.tsx` 的**展示**要按 §3.3 改造（B 类），不是删。

### 决策 6：「系统」分组暂时保留单个「关于 Harbor」

- **定的内容**：不为数量对称新增页面。
- **对 V1 §6 第 4 条**：「系统组只有 1 页是否合理」→ **已定，不新增**。分组的意义是归类，不是「每组至少 N 项」。
- **源码影响**：无。

### 修订后的迁移边界（一句话版）

| 项 | V1 结论 | V3 修订 |
|---|---|---|
| 13 页可发现性 | 全列（`detailedOnly` 取舍待定） | **全列且不可整页隐藏**；高级项页内折叠 |
| 通知三档 | 双入口风险，待定 | **唯一编辑源在「外观与通知」**；通知中心只留摘要+跳转 |
| 设置容器 | Modal vs 主区待定 | **主区工作区**；优先两视图同时挂载 + CSS 切换，**允许等效实现**（验收判据与实现无关） |
| 危险操作保护 | 靠 `detailedOnly` 收起 | **靠运行时**（内核闸门），UI 只做页内折叠 |
| 双模型协作 | 归「工具与扩展」 | → **归「模型与服务商」· 双模型协作** |
| 定时任务 | 归「工具与扩展」 | → **归「对话与任务」** |
| 生图/下载目录 | 归「上下文与项目」 | → **归「数据与存储」**（文件输出位置） |
| 场景预算 | 整块随 `ScenesTab` 迁 | **拆四处**：8 场景模型 + 路由 + 重试归「模型与服务商」、压缩阈值归「上下文与项目」 |
| `taskScope` | 算「对话与任务」的一部分 | **不进设置页**（它是任务中心的视图过滤，不是设置） |
| **模型与服务商结构** | 5 块，分段待定 | **四主标签**：服务商 / 模型与场景 / 运行策略 / 双模型协作 |
| **助手人设归属** | 随 `AssistantPanel` 整体进模型页 | **拆**：`name` / `systemPrompt` / `responseDepth` → 对话与任务（提示词层）；model / temperature / maxTokens / historyLimit → 模型页；7 个行为开关 → 运行策略 |
| **`pricing` 价目表** | 半缺口，可考虑可编辑 | **不新增编辑入口**；折算值必须标「不是实付」或不予显示；旧配置保留兼容 |
| **「系统」组** | 只有 1 页，合理性待定 | **已定，不新增页面** |
| 用量页 | 三口径分层标注 | **用户可见的只用真实值**（最近请求实际 / 账单 / 余额）；内核估算只用于裁剪与安全预算；缺失标「无数据」，不回填估算 |


---

## 0.5 十句话结论（V3 定稿）

1. **现有 11 个设置分类能完整映射到新 13 页，没有功能无处安放**（L1/L2）。
2. **但「一对一」做不到**：6 处不是搬 —— `conversation` 拆 2 页、`datausage` 拆 2 页、通知迁入、`ScenesTab` 拆四处、`CollabPanel` 与 `SchedulesPanel` 改归属；**另加 1 处拆组件**：`AssistantPanel` 拆三段（人设 / 模型详情 / 运行策略）（L1，§2 与 §0 决策 4）。
3. **配置共 131 个叶子字段，其中「真缺口」8 组 / 16 个叶子**（L2 + V2 重数）。**但其中只有 8 个字段真该给可编辑入口**，2 组只该只读展示、1 组走任务卡片 —— 不要把「缺口数」当工作量（§3.1）。
4. **两套存储并存**：`localStorage`（界面偏好，`personal-agent:settings`）+ `data/config.json`（内核配置）。同一件事（如主题）两边都有，靠 `configMapping.ts` 的 6 条映射同步（L1）。新工作区若按页面重组，这条映射会成为**最容易漂的地方**。
5. **现在是覆盖层（Modal），所以聊天不会卸载**（L1，`GlobalLayers.tsx:49`）—— **但决策 3 改主区视图后，这条「天然好处」会消失**，必须靠「两视图同时挂载 + CSS 显隐」自己保住；照抄条件渲染会把聊天区卸载（§0 决策 3，这是本轮最大的实现风险）。等效实现可以，但验收判据不变。
6. **`tab` 状态在 `SettingsModal` 内部**（`useState('general')`）。改主区后语义从「关闭即丢」变成「切回聊天再切回来该还在原页」，必须把状态提到 `useUIStore`（L1）。
7. **通知三档原来只在右栏 `NotifyPanel`**（L1）—— **决策 2 已定迁入「外观与通知」**，通知中心只留摘要与跳转（见 §0）。
8. **`stats.cjs` 记的是真实 usage，但只覆盖一条路径**（V3 更正）：`loop.cjs:195` 是唯一记录点，codex-cli 归一后走同一条；**然而压缩、场景（标题/翻译/建议/OCR）、协作三条真实花 token 的路径都不传 `onUsage`**，完全不记。加上 `llm.cjs:259` 是 `if (usage)` 才回调，缺失时连"没记上"都留不下痕迹（§3.3 边界①②）。
9. **`detailedOnly` 机制按决策 1 作废**（不再整页隐藏），但**安全性不因此下降** —— 所有实际约束都在内核闸门里，与界面可见性无关（L1，见 §0）。
10. **C 类不是「一项」而是一个完整范围**（V3 扩写）：`模型用量 V1` = 数据正确性（C-1a~c）+ 用户可见口径（C-1d~e）+ **分析能力（C-1f~i：热力图 / 四维 / 分类 / 覆盖率）** + 性能（C-1j）。**只做完 a~e 不算 V1 完成**（见 §4）。

---

## 1. 现状：两套存储 + 一个覆盖层（L1）

### 1.1 数据落在哪

| 存储 | 内容 | 字段数 | 代码 |
|---|---|---|---|
| `localStorage` `personal-agent:settings` | 界面偏好：主题、宽度、折叠、快捷键、通知路由、开屏 | 40+ | `src/stores/useSettingsStore.ts` |
| `data/config.json` | 内核配置：供应商、权限、上下文、记忆、MCP | **131 个叶子字段** | `electron/core/config-defaults.cjs` → `config.cjs` |
| `data/avatars/` | 头像文件 | — | `handlers/profile.cjs` |
| `credentials.json`（系统加密） | API Key（配置里只有 `credentialRef`） | — | `credentials.cjs` |

**两套之间的桥只有 6 个字段**（`src/lib/configMapping.ts:23-31`）：
`theme` / `glassmorphism` / `animations` / `fontScale` / `sendOnEnter` 双向，`defaultModel` 只读不写。

> ⚠️ `defaultModel: cfg.assistant.model` 是**单向镜像** —— `settingsToConfig` 不写回，而 `defaultModel` 在 UI 里零引用（L2）。它是个死字段，别在新页面里给它做入口。

### 1.2 设置怎么挂上去的

```
App.tsx
  <Sidebar />                                    ← 始终挂载
  <GlobalLayers config showOnboarding>           ← 覆盖层容器
      {settingsOpen ? <SettingsModal /> : null}  ← 关闭即卸载
```

- **覆盖层**：主界面不卸载 → 聊天/草稿/任务连续性不受影响（L1）
- **`settingsOpen` 在 `useUIStore`**，无 persist（刷新归 false，符合预期）
- **`tab` 在 `SettingsModal` 内**，`useState('general')` → 关闭即丢（L1）
- **外部跳转**：`openSettings(tab)` 可指定落点（AG-042 加），打开时同步一次

### 1.3 现有 11 个分类（L1，`src/components/settings/parts.tsx:59-93`）

| # | id | 标题 | 分组 | 默认收起 |
|---|---|---|---|---|
| 1 | `profile` | 个人资料 | 常用 | |
| 2 | `general` | 通用 | 常用 | |
| 3 | `appearance` | 外观 | 常用 | |
| 4 | `conversation` | 对话 | 常用 | |
| 5 | `models` | 模型 | 常用 | |
| 6 | `access` | 权限与安全 | 高级 | ✅ `detailedOnly` |
| 7 | `datausage` | 数据与用量 | 高级 | |
| 8 | `extension` | 扩展 | 高级 | |
| 9 | `memory` | 记忆 | 高级 | ✅ `detailedOnly` |
| 10 | `experience` | 经验与规则 | 高级 | ✅ `detailedOnly` |
| 11 | `about` | 关于 | — | |

界面是居中浮层：`width="2xl"` = `max-w-[min(1180px,92vw)]`，`height="h-[min(880px,88vh)]"`（L1，`ui/Modal.tsx:47` + `SettingsModal.tsx:107-112`）。

---

## 2. 旧分类 → 新 13 页 映射表（L1/L2）

> 「实装组件」列是从源码 import 关系抠出来的，不是猜的。

### 第 1 组：基础

| 新页面 | 承接的旧分类 | 实装组件 | 状态 |
|---|---|---|---|
| **个人资料** | `profile` 全部 | `ProfileTab`（昵称 + 头像，`profile:setName/pickAvatar/clearAvatar`） | **A 直迁** |
| **通用与快捷键** | `general` 全部 | `GeneralTab`（回车发送/默认模式/数据/对话浏览/窗口托盘/退出）+ `ShortcutsTab` | **A 直迁** |
| **外观与通知** | `appearance` 全部 + **通知三档（唯一编辑源，决策 2）** | `AppearanceTab`（字体/主题/开屏/提示/材质/布局 6 段）+ 通知三档组件（从 `NotifyPanel` 迁出） | **B 适配**（见 §0 决策 2 / §3.2） |

### 第 2 组：Agent 与模型

| 新页面 | 承接的旧分类 | 实装组件 | 状态 |
|---|---|---|---|
| **模型与服务商** | `models` 全部 + `CollabPanel` + `ScenesTab` 的场景模型 / 模型路由 / 失败重试 + **`AssistantPanel` 的「模型详情」「运行策略」两段（V3 拆入）** | **四个主标签**：① **服务商** = `ProviderCard` + `CodexCliCard`；② **模型与场景** = `ModelField` + `temperature` + `maxTokens` + `historyLimit` + 8 场景选择器 + `router.enabled` / `router.roles.*` + `fallback.attempts`；③ **运行策略** = `AssistantSwitches` 的 7 个开关（`planFirst` / `clarifyFirst` / `scaleFirst` / `scaleHardSeconds` / `verifyAfterEdit` / `strictMode` / `streamOutput`）；④ **双模型协作** = `CollabPanel` | **B**（四标签 + 拆分，见 §0 决策 4） |
| **对话与任务** | `conversation` 的**全局层**（默认工作目录 + 对话体验）+ `SchedulesPanel` + **人设三项（V3 拆入）** | `WorkdirRow` + `ConversationExperienceTab` + `SchedulesPanel`（定时任务 + 授权上限）+ **`assistant.name` / `systemPrompt` / `responseDepth`**（提示词层：`loop-prompt.cjs:212` / `:277` / `:213`） | **B 适配** |
| **上下文与项目** | `conversation` 的项目层与会话层（项目上下文 / 本次会话设置）+ **`context.*` 的压缩阈值（V2 拆入）** + `context.*` 缺口 | `ProjectContextTab` + `ThreadSettingsTab` + `ScenesTab` 的 `context.compactAt` / `autoCompactAt`，**缺 `baseTokens` / `budget.*`** | **B 适配 + 补缺口** |

> **V2 变更说明（逐条对应用户要求）**
> - `CollabPanel` → **模型与服务商**。依据：它只做「开关 + 能力只读展示」，判断全部来自主进程（`collabStatus` / `collabSet`），运行入口在聊天框（`chat/composer/CollabPicker.tsx`，见 `CollabPanel.tsx:6-8`）。本质是「用哪些后端承担角色」→ 模型页（L1）。
> - `SchedulesPanel` → **对话与任务**。依据三条：① 运行单位是任务（专属会话 + `task_*` 台账，`SchedulesPanel.tsx:40` 原话「每次跑都开在一个专属会话里」）；② 「授权上限」是**该任务自身**的属性（没人在场一律拒绝，`:39`），与 `task.budget` 同级，不是全局安全策略；③ 它的性质是「**触发方式**」，`MCP`/技能是「能力来源」—— 并列会混淆（L1）。归「权限与安全」不成立：那是全局策略页，放一条任务的授权上限会让人误以为改了全局。
> - `ImageSaveTab` / `DownloadSaveTab` → **数据与存储**（见第 4 组）。
> - `ScenesTab` → **不整体迁**，按字段拆四处：
>   | 拆出的块 | 字段（L1，`ScenesTab.tsx`） | 去处 |
>   |---|---|---|
>   | 8 个场景模型 | `scenes.chat/title/prompt/translate/suggest/compact/ocr/image` 的 `providerId` / `model`（16 叶子） | 模型与服务商 |
>   | 模型路由 | `router.enabled` + `router.roles.{fast,reasoning,coding,vision,cheap}`（6 叶子） | 模型与服务商 |
>   | 失败重试 | `fallback.attempts`（`retryOn` 是内部字段，不给 UI） | 模型与服务商 |
>   | 上下文压缩 | `context.compactAt` / `autoCompactAt`（2 叶子） | 上下文与项目 |
> - `taskScope` → **不进设置页**。依据：`useSettingsStore.taskScope: 'project' | 'all'`（`types/settings.ts:107`）只在 `TaskCenter.tsx`（`:61-64`、`:170`、`:188-194`）使用，是**任务中心列表的视图过滤**（`scopeLabelOf` / `scopeWorkdirOf`），既不是全局默认、也不是当前任务控制。它现在住在 `useSettingsStore` 只是「顺便持久化」，不应因此在设置页给它一个入口 —— 那才是重复管理（L1）。
> - **三级覆盖关系**：全局在「对话与任务」（`WorkdirRow`）、项目在「上下文与项目」（`ProjectContextTab`）、会话在「上下文与项目」（`ThreadSettingsTab`）。**这条关系必须两页都写**（V1 §3.4 已论证，V2 保留该结论）。
> - **（V3）人设三项不进模型页**：`assistant.name` / `systemPrompt` / `responseDepth` 都是**提示词层**（进系统提示，见 `loop-prompt.cjs:212/213/277` 与 `prompt-stack.cjs:200`），换模型不改变它们 → 归「对话与任务」。模型页留下的是「换模型才有意义」的四项（model / temperature / maxTokens / historyLimit）与「运行时行为」的七项开关。判据与逐字段依据见 §0 决策 4。
> - **（V3）`responseDepth` 有会话级覆盖**（`ThreadSettingsTab.tsx:23`）：这是「全局 → 会话」两级里的一个实例，落到「对话与任务」时必须写明，否则用户改全局后发现某条会话没变会以为失效。

### 第 3 组：能力与安全

| 新页面 | 承接的旧分类 | 实装组件 | 状态 |
|---|---|---|---|
| **权限与安全** | `access` 全部（含联网搜索） | `ToolsPanel`（权限三档）+ `SearchPanel` + `SecurityTab`（文件范围 / Shell 三档 / `NetworkPolicyPanel` / `SessionCryptoPanel` / `GrantsPanel` / `ApprovalHistory` / `AuditPanel`） | **A 直迁**（页内 9 块偏重，见 §3.5） |
| **工具与扩展** | `extension` **减去 `CollabPanel` 与 `SchedulesPanel`** | `BrowserExtCard` + `SkillsTab` + `McpTab`（`ServerList` / `CodexMcpPanel` / `ProjectTestsPanel`） | **A 直迁**（页内 3 个子系统，比 V1 减轻） |
| **模型用量** | `datausage` 的**用量半** | `UsageTab`（`BudgetLimit` / `GateStatus` / `BalanceCard` / `CostBreakdown` / `StatCard`） | **B + C-1**（口径重构，见 §3.3） |

### 第 4 组：数据与知识

| 新页面 | 承接的旧分类 | 实装组件 | 状态 |
|---|---|---|---|
| **数据与存储** | `datausage` 的**数据半** + **`ImageSaveTab` / `DownloadSaveTab`（V2 移入，文件输出位置）** | `DataTab`（`DataPortPanel` 导出/分档删除 + `BackupPanel` + 导出导入 + 诊断 + 重置设置）+ `ImageSaveTab`（`image.dir`）+ `DownloadSaveTab`（`downloads.browserDir`） | **A 直迁**（两个目录项是普通 `Row`，挂上去即可；默认值说明另计 B-11） |
| **记忆** | `memory` 全部 | `MemoryTab`（列表 / 增删 / `MemoryExplainPanel` / `autoWrite` / `injectLimit` / `retrieve`） | **A 直迁** |
| **经验与规则** | `experience` 全部 | `ExperienceTab`（统计 / 候选审批 / 反例 / 停用） | **A 直迁** |

> **V2 变更说明**：两个目录项归「数据与存储」的「文件输出位置」，依据（L1）：
> - `image.dir`（`ImageSaveTab.tsx:18`，`patchImage`）：**全局**键，留空 = **当前工作目录**的 `generated/` 子目录
> - `downloads.browserDir`（`DownloadSaveTab.tsx:18`，`patchDownloads`）：**全局**键，留空 = **当前会话工作目录**
> - **项目级覆盖：没有**。核对结果：这两个键只在各自 Tab 里写，`config.patch` 走全局深合并，`ProjectContextTab` / `ThreadSettingsTab` 都不碰它们（L1）。
> - ⚠️ 但**默认值依赖会话**：留空时 `browserDir` 跟着当前会话工作目录走 —— 页面上必须写清，否则用户会以为「留空 = 固定放在某处」。

### 第 5 组：系统

| 新页面 | 承接的旧分类 | 实装组件 | 状态 |
|---|---|---|---|
| **关于 Harbor** | `about` 全部 | `AboutTab`（版本 / 数据位置 / 更新日志 / 开源许可） | **A 直迁** |

### 覆盖结论（L1/L2）

**11 个旧分类 → 13 页，全部有归属，零遗漏。** V2 修订后共 **6 处是「拆/改归属」而不是「搬」**：

| # | 旧来源 | 修订后 | 类型 |
|---|---|---|---|
| 1 | `conversation`（1 页 7 子块） | 拆成「对话与任务」（全局层）+「上下文与项目」（项目/会话层） | 拆页 |
| 2 | `datausage`（1 页 2 子块） | 拆成「模型用量」+「数据与存储」 | 拆页 |
| 3 | 通知三档（原在右栏面板） | 迁入「外观与通知」，右栏只留摘要 | 迁入（决策 2） |
| 4 | `ScenesTab`（1 组件 4 类字段） | 拆四处：场景模型/路由/重试 → 模型与服务商；压缩阈值 → 上下文与项目 | 拆块 |
| 5 | `CollabPanel` | 「工具与扩展」→「模型与服务商」 | 改归属 |
| 6 | `SchedulesPanel` | 「工具与扩展」→「对话与任务」 | 改归属 |

**另有 2 项不进设置页**（V1 曾误列）：
- `taskScope` —— 任务中心的视图过滤，不是设置（§2 第 2 组说明）
- `ImageSaveTab` / `DownloadSaveTab` 不是「上下文」的一部分，而是文件输出位置 → 已改归「数据与存储」

---

## 3. 遗漏、重复、归属冲突、兼容风险

### 3.1 【缺口】48 个配置字段没有界面入口（L2）

脚本 `node .tmp/coverage-v2.cjs` 扫全部 69 个设置组件，对 131 个叶子字段逐个查引用。**未引用的 48 个**，按性质分三类：

**① 「真缺口」—— 8 组 / 16 个叶子字段（V2 更正了两个数）**

> **「8 项」是 8 组，不是 8 个字段。** V1 的写法容易被读成「只有 8 个字段缺入口」。
> 按下表逐行数：1 + 4 + 1 + 1 + 2 + 1 + 5 + 1 = **16 个叶子字段**（L1，按 `config-defaults.cjs` 逐个点）。
>
> ⚠️ **不要拿「48」减这张表来核对**：48 是脚本「按字段名扫引用」的原始结果，里面同时混着
> ②类被整体对象引用的误报（pricing 15 + router.roles 5 + scenes 16）、②′走专用通道的漏报、
> ③类内部字段，还有若干只在 `parts/` 子组件里被间接读到的。**这三类的精确分解本轮没有重算**
> （V1 也没算过），要写死就得重跑脚本 —— 所以这里只陈述「真缺口 8 组 = 16 个叶子字段」这个
> 能逐行点出来的事实，不硬凑等式。

| # | 字段组 | 叶子数 | 现状 | **是否该暴露给用户（V2 判断）** |
|---|---|---|---|---|
| 1 | `context.baseTokens` | 1 | 无入口 | **该**。P1 刚重做上下文链路，用户看得见用量却调不了基准，会以为是 bug |
| 2 | `context.budget.*`（memory/project/task/conversation 四个有效键） | 4 | 无入口 | **该，但只给「高级」折叠组**。它是「为什么工具输出挤掉对话」的唯一解释入口 |
| 3 | `tools.outputLimit` | 1 | 无入口 | **不该**。2MB 是安全上限，用户改小会丢诊断、改大没收益 → 只读展示即可 |
| 4 | `audit.retentionDays` | 1 | 无入口 | **该（低优先）**。牵涉合规与磁盘，但一年改不了一次 → 「数据与存储」的高级组 |
| 5 | `changeset.maxFileBytes` / `maxFiles` | 2 | 无入口 | **不该**。改小会让撤销失效，改大只影响磁盘 → 只读展示 |
| 6 | `cache.prewarm` | 1 | 无入口 | **该**。默认关且**会产生费用**，用户必须能关掉 |
| 7 | `budget.maxSteps` / `maxToolCalls` / `maxRuntime` / `maxRetries` / `softRatio` | 5 | 无入口 | **该，但优先走任务级而非全局**。它是「这个任务最多跑多久」—— 全局默认已经在 `budget` 顶层且默认全不限 |
| 8 | `memory.maxItems` | 1 | 无入口 | **该（低优先）**。默认 800，超了会提示清理 |

**结论（回应「不要求全部新增可编辑入口」）**：
- **需要可编辑的只有 5 组**（#1、#2、#4、#6、#8），共 8 个字段
- **#3、#5 只读展示**（2 组 3 个字段）—— 它们的安全默认值比用户随便调更可靠
- **#7 共 5 个字段走「任务卡片上按任务改」**，不进全局设置页（现在任务预算本来就在任务卡片里）
- 所以「补缺口」的工作量不是 16 个入口，而是 **8 个输入控件 + 2 处只读说明 + 1 处复用现有任务预算入口**

**② 被整体对象引用（扫描误报，实际有入口）—— 算正常**

`pricing.*`（15 个价目表字段，通过 `pricing` 整个对象传给 `CostBreakdown`）、`router.roles.*`（5 个，`ScenesTab` 整体读）、`scenes.*`（16 个，`ScenesTab` 逐项读写）。

**②′ 走专用通道、不写字面量的（扫描漏报，实际有入口）**

| 字段 | 真实链路 | 为什么脚本漏了 |
|---|---|---|
| `security.encryptSessions` | `SessionCryptoPanel` → `sessionCryptoApi` → `security:setSessionCrypto`（`handlers/extras.cjs:261`）→ `config.patch({ security: { encryptSessions } })`；读取方 `session-crypto.cjs:56` | 前端写的是通道名与 `fetchSessionCrypto`，**没有一个地方写 `encryptSessions` 字面量** |

> 这条是「按字段名扫引用」这个方法本身的盲区：**设置项走专用 IPC 通道时，字段名不出现在前端**。核对其余 47 项时按同一思路复查过，只有这一处是这种形状。

> ⚠️ `pricing` 的**具体单价**确实没有编辑 UI —— 只有 `currency` 和 `peakMode` 被读。价目表写死在 `pricing-defaults.cjs`，用户改只能手改 `config.json`。这是「半缺口」。

**③ 内部字段，本就不该有 UI —— 正常**

`version`、`updatedAt`、`general.onboarded`、`general.onboardingDismissed`、`assistant.topP`、`assistant.clarify*`（3 个）、`assistant.scale*`（3 个）、`codexMcp.writeRoot`、`search.credentialRef`、`fallback.retryOn`。

> **V2 判断（这 6 个的归属）**：`assistant.clarify*`（3 个）和 `scale*`（3 个）是「先问再动」与「规模预检」的阈值 —— 改错的后果是**流程卡死**（例如 `clarifyMaxWaitMs` 调太小 → 每轮都超时；`scaleMaxFiles` 调太大 → 预检失效）。按「不要求全部新增可编辑入口」的口径，**只给只读展示 + 一句当前值说明**，放在「对话与任务」页的高级折叠组里，不给输入框。理由：这层属于运行时保护阈值，与 `tools.outputLimit` 同类 —— **看得见就够，改了只会有风险**。

### 3.2 【已定】通知三档只有一处编辑源（决策 2）

- 现在：「哪些通知进这里（弹卡片 / 只进这里 / 都不要）」在 **`src/components/layout/NotifyPanel.tsx:74`**，右栏「通知」标签顶部
- **决策 2 已定**：三档迁入「外观与通知」，右栏只留**状态摘要 + 跳转入口**，不再有第二套编辑控件

**风险已消除**：V1 担心的「两处各写一套 UI、改 A 处 B 处不刷新」不再成立 —— 只有一个编辑点。
**落地要求（B 类）**：
1. `NotifyPanel` 里 `ROUTE_OPTIONS` 那组单选（`:74`）与 `updateSettings({ notifyRoutes })`（`:120`）**删掉**，换成一行摘要文案
2. 摘要必须**如实用当前值生成**（读 `Settings.notifyRoutes`），不能写死一句「默认配置」—— 否则用户改过之后摘要会撒谎
3. 「去设置调整」按钮调 `openSettings('appearance')`（`useUIStore.openSettings` 已存在，`useUIStore.ts:200`）
4. 通知中心**其余职责不动**：列表、清空、未读、任务完成/下载完成条目

### 3.3 【已定】用量只认真实数据源（L1 + V2 修正）

**先纠正 V1 的一个事实错误。** V1 把 `stats.cjs` 归成「服务端返回」是对的，但没说清**它已经是唯一记录点**，也没说 CLI 后端算不算。V2 补查结论：

| 事实 | 证据（L1） |
|---|---|
| `stats.cjs` 记的就是**服务端返回的 usage**，本地不估算 | `stats.cjs:9-10` 文件头；`addInto` 只读 `prompt_tokens` / `completion_tokens` / `total_tokens` / 缓存字段（`:93-114`） |
| **唯一记录点**是 `loop.cjs:195` 的 `onUsage` 回调，每次 LLM 调用记一笔 | `loop.cjs:191-199`；`grep` 全仓 `stats.record` 只有这一处调用 |
| **codex-cli 也算真实用量**：它的 usage 经 `codex-jsonl.mapUsage` 归一成 OpenAI 形状后走**同一条** `stats.record` | `codex-jsonl.cjs:91-109`（`input_tokens`→`prompt_tokens` 等，注释明确写「直接把 codex 的 input_tokens 递下去会记成 0」）；`codex-cli.cjs:170` `onUsage` 透传 |
| **缺失 usage 时静默不记** | `stats.cjs:137-140`：无 usage 返回 `{ok:false,error:'没有 usage'}`，`loop.cjs:195` 的 try 里不看返回值 → **既不记也没人告诉用户** |
| `token-metrics.jsonl` 是**并行第二条路径**，不进任何 UI 数字 | `token-metrics.cjs` 写 `data/logs/token-metrics.jsonl`，含缓存命中率；`UsageTab` 只读 `statsSummary`（`UsageTab.tsx:70`） |
| `ContextGauge` 是**纯本地估算** | `contextUsage.ts`（P1 刚重做的「请求体口径」），与 Provider 返回无关 |

**V3 定稿口径（六条，取代 V2 的五条）**：

1. **ContextGauge 默认显示「当前主模型最近一次请求的实际用量」** —— 取 Provider / CLI 返回的 `usage.prompt`，标注「最近一次请求 · 实际」。它与「模型用量」页**同一数据源**。
2. **生成期间显示「统计中…」；usage 缺失显示「无数据（供应商未返回）」** —— 两种状态下**都不显示数字**，更不显示估算值。
3. **本轮 / 这个任务的累计按需展开**（点一下才拉），不占主位。
4. **内核本地 Token 估算不进入用户可见的 Token 监控** —— 它只服务上下文裁剪与安全预算（`contextUsage.ts` / `context-builder.cjs` 的用途不变，但不再是用户可见数字的来源）。
5. **不采用 V2 提出的「上一轮实际 + 本轮估算」双数字方案**（那条现作废 —— 双数字要求用户自己判断该信哪个，而其中一个根本不是实测）。
6. **「最近请求的实际输入」不得标成「当前上下文占用」**。

**为什么第 6 条单独列**：`message.usage.prompt` 是「上一次请求**实际输入**了多少 token」，它已经把系统提示、展开的工具记录、裁剪后的历史都算进去了。标成「当前上下文占用」会让人以为「下一轮大概也这么多」—— 而下一轮可能因为新增几条工具结果直接翻倍。也不能标「剩余容量」。准确说法只有一个：**最近一次请求的输入 token**。

**三类费用必须分开**（合并成一个「花费」就是错的）：

| 数字 | 来源（L1） | 是什么 | 能叫「实付」吗 |
|---|---|---|---|
| **请求级费用** | `stats` 的 token × 单价；若 Provider 直接返回 cost 则优先用它 | 按 token 折算的单次/单日成本 | ❌ **折算，不是账单** |
| **账单级实际支出** | Provider 账单接口 | 真的扣了多少钱 | ✅ **是** |
| **账户余额** | `provider:balance`（`BalanceCard.tsx`，用户点才请求、不轮询） | 还剩多少可用 | ❌ **余额不是消费** |

> 价目表折算（`CostBreakdown`，`pricing-defaults.cjs` 内置价）× token 得出来的数是**估算**，按决策 5 不提供单价编辑入口，所以它**只能标「按内置价目表折算，不是实付」**，否则就是给用户一个更可信的错数。

**现有 `stats` 的能力边界（V3 补查，五条 —— 直接决定 C-1 的规模）**：

| # | 边界 | 证据（L1/L2） |
|---|---|---|
| ① | **`stats.record` 只有一个调用点，不等于所有模型请求都被记录** | 补充：全仓 `stats.record` 确实只有 `loop.cjs:195`。但**真实花 token 的三条路径完全不经过它**：<br>· 压缩摘要 `compact-chunked.cjs:92`（`llm.chatStream`，最多 24+1 次调用）<br>· 场景调用 `scene.cjs:122` / `:169`（标题 / 翻译 / 建议 / OCR / 看图）<br>· 协作工作模型 `collab-executor-codex.cjs:103`（`chatStream`）<br>三处**都没有传 `onUsage`**（脚本 `.tmp/v3-usage-scan.cjs` 扫证） |
| ② | **没有 `onUsage` 回调时，改 `stats.record` 也记不到 unknown** | `llm.cjs:259` 是 `if (usage) onUsage?.(usage)` —— **usage 为空时回调根本不触发**。所以「在 `stats.record` 里补一个 unknown 计数」只对「回调触发了但字段全空」有效；对「回调没触发」完全无效。**必须同时改请求生命周期**（在调用点无条件回报一次结果，含「没拿到」）。 |
| ③ | **`stats` 没有 provider / task 维度** | `stats.cjs:37` 只有 `{ total, byDay, byModel }`；`record(usage, model)`（`:136`）只接模型名。所以「按 Provider 分析」「按任务分析」做不出来 —— 这是 V1 目标里明确要的维度，属新增落盘形状。 |
| ④ | **旧历史里无法恢复的缺失必须保持未知** | 现在 `addInto` 遇到缺字段按 0 累加（`:94-113`）。**不能反向用估算补齐** —— 那会把「不知道」变成「一个看起来精确的错数」。已落盘的历史只能标「这段时期的覆盖率未知」。 |
| ⑤ | **`token-metrics.jsonl` 有消费者，不能直接删** | 写：`llm.cjs`（`logLlm`）、`prewarm.cjs`（`recordRequest`，`:68`/`:90`）。读：自检 `210-llm-attribution`（`summarize`/`logLlm`/`file`）、`85-token-opt`（`cacheFields`/`hitRate`）、`178`/`150`（`summarize`）、单测 `batch4Retention`（`file`）。`data-retention.cjs:185` 还专门管它的 6MB 轮转。<br>→ **它是「给排查与自检用的可观测日志」，不是 UI 数据源。** 要动它得先说清「自检里那几条断言搬到哪」。 |

**流式用量去重（③的补充，L1）**：`llm.cjs:259` 在**一次请求结束时**用最终 `usage` 触发一次 `onUsage`，不是每个 SSE 分片都触发 —— 所以**没有重复计数**。但 `loop.cjs:191-199` 的 `mergeUsage` 是把多轮调用的 usage 累加给「本轮总计」，而 `stats.record` 是**每次调用各记一笔**。两者口径不同（一轮可能有 N 笔），读数时不能混。

**缺口（C-1 → 拆成 C-1a~e，V3 扩成「模型用量 V1」的最小集）**：

| # | 缺什么 | 为什么必须做 |
|---|---|---|
| C-1a | 缺失 usage 时**显式记「未返回」**，且**在请求生命周期层**回报（不只改 `stats.record`） | 边界②：回调没触发时改 record 无效 |
| C-1b | 补齐**未记录的调用路径**（压缩 / 场景 / 协作） | 边界①：这三条现在完全不进统计，用户看到的总量系统性偏低 |
| C-1c | `stats` 落盘加 **provider / taskId 归属**（新形状，要迁移） | 边界③：没有它做不出 Provider / 任务维度 |
| C-1d | ContextGauge 接真实 usage（最近一次请求）+ 三种状态（统计中 / 无数据 / 有数字） | §3.3 口径 1、2 |
| C-1e | 旧估算路径清理（`contextUsage.ts` 只留内核裁剪用途）；`CostBreakdown` 标「折算非实付」 | 口径 4、5、6 + 决策 5 |

> **「模型用量 V1」的完整范围不止 C-1a~e**（用户本轮明确补充）。完整清单见 §4 的 C-1 表 —— 只做完 a~e **仍不能判 V1 验收完成**。

### 3.4 【兼容风险】`conversation` 拆分是最大的一块（L1）

`ConversationPanel` 现在有 7 个子块，顺序有语义：

```
全局默认(SectionTitle) → WorkdirRow
ConversationExperienceTab      ← settingsView / taskSummary
ScenesTab                      ← scenes / router / fallback / context.compactAt
生图 → ImageSaveTab            ← image.dir                    → V2 改归「数据与存储」
下载 → DownloadSaveTab         ← downloads.browserDir         → V2 改归「数据与存储」
项目上下文 → ProjectContextTab + ThreadSettingsTab   ← 按项目/按会话覆盖
```

**V2 修订**：这张 7 块清单只剩 4 处进新页，且分散到 3 个页面（`WorkdirRow`+`ConversationExperienceTab` → 对话与任务；`ScenesTab` 拆成 3 块进模型与服务商、1 块进上下文与项目；两个目录项进数据与存储；两个项目/会话项留在上下文与项目）。

页面顶部写着一句关键提示（`ConversationPanel.tsx:35`）：
> 「影响所有对话；下面「项目上下文」里的两项可以按项目 / 按对话覆盖它」

**这句话是「全局 → 项目 → 会话」三层覆盖关系的唯一说明。** 拆开后**必须两页都写**，否则覆盖关系断掉 —— 用户会以为改的是全局。

**要求（B 类）**：拆页时把「覆盖关系」做成**两页都看的提示条**，并在「上下文与项目」页明确写「这里覆盖『对话与任务』里的全局默认」。

### 3.5 【页内过重】权限与安全一页 9 块（V3：模型页改四标签后减轻）

| 页 | 子系统数 | 明细 | V3 变化 |
|---|---|---|---|
| 权限与安全 | **9 块** | 权限三档 / 联网搜索 / 文件范围 / Shell 三档 / 网络策略 / 会话加密 / 授权记录 / 审批历史 / 审计日志 | 不变 |
| 工具与扩展 | **3 块** | 浏览器插件 / 技能 / MCP（含 Codex 桥、项目测试） | V2 减负：双模型协作→模型页、定时任务→对话与任务 |
| 模型与服务商 | **4 标签 / 6 块** | 服务商（2 块）· 模型与场景（模型详情 + 8 场景 + 路由/重试）· 运行策略（7 开关）· 双模型协作 | **V3 改四标签**：不再是一页堆 5 块，而是按层分成四个主标签 |

新设计要求「复杂管理操作使用独立详情」。按现在内容直接搬，**滚动会超 5 屏**（L3 未测）。要求（B 类）：页内二级分段 + 重块用抽屉详情。
**V3 的连带效应**：四标签本身就是一次「二级分段」，模型页的过重问题**基本被结构解决**；但「权限与安全」9 块仍是单页，它是 P3 里唯一必须做抽屉/分段的页。

### 3.6 【已定】`detailedOnly` 作废，替代方案是页内折叠（决策 1）

现有机制：`settingsView: 'simple' | 'detailed'` + `detailedOnly` 标记 → 简洁视图下 3 页收起（`SettingsModal.tsx:216-229`，理由在 `parts.tsx:66-73`）。

**决策 1 已定：不做整页隐藏。** 所以这套机制的**隐藏页面**部分作废，替代为：
- 13 页一律可发现
- 页内「高级 / 危险操作」分组默认收起、点击展开（`<details>` 或等价组件，**不持久化到跨会话**也行，但建议按页记）
- **安全性不下降的依据（L1）**：三档权限、只读档、敏感文件授权、高风险确认全在内核（`capability.cjs` / `risk-gate.cjs` / `pre-write-gate.cjs` / `user-constraints.cjs` 的 `STOP_PHRASES`），**与 UI 可见性无关**。UI 收起从来不是安全边界。

**源码影响（B 类）**：`parts.tsx` 的 `detailedOnly` 字段 + `hiddenTabsOf` / `visibleTabsOf`、`SettingsModal.tsx:8` 的 import 与 `:45/59-79/204/223/244` 的处理、`settingsView` 字段本身、以及 `ConversationExperienceTab.tsx:38-53` 那个「设置页视图」下拉 —— **整套一起删**（已核实：`settingsView` 没有别的消费者，删完无功能损失，见 §6.1）。同一页的「每轮结束显示结果摘要」（`taskSummary`）**保留**。

### 3.7 【状态】关闭设置会丢「上次在哪页」（L1）

`tab` 在 `SettingsModal` 内部 `useState`。当前行为：每次打开都回 `general`（除非 `openSettings(tab)` 指定）。

**V2 变化**：改成主区工作区后，「设置停在哪页」的载体也变了 —— 不再有「打开/关闭」，而是「切到设置 / 切回聊天」。所以这条从「关闭即丢」变成「**切回聊天再切回来，应该还在原页**」。

**要求（B 类）**：`settingsTab` 提到 `useUIStore`（该字段已存在，`useUIStore.ts:66/177/200`，目前只用于「打开时指定落点」），**切回聊天不清空** → 再切回来回到原页。

### 3.8 【已定】设置改主区工作区（决策 3）

- 现在：`max-w-[min(1180px,92vw)]` × `h-[min(880px,88vh)]`，居中浮层（`ui/Modal.tsx:47` + `SettingsModal.tsx:107-112`）
- **决策 3 已定**：主区工作区，动态自适应，**不改主窗口尺寸**

**落地形态（B 类）**：`App.tsx` 的主区从「只有聊天」变成「聊天 / 设置两个视图」，`GlobalLayers` 里的 `{settingsOpen ? <SettingsModal/> : null}` 摘掉。
**⚠️ 最大风险已写在 §0 决策 3**：两视图必须**同时挂载 + CSS 显隐**，不能用条件渲染 —— 否则聊天区被卸载，草稿之外的一切（滚动位置、流式视图、Composer 内部状态）全丢，直接违反「保留连续性」。
**自适应要求**：不再受 `Modal` 的 5 档尺寸限制；窄窗口下侧栏可折叠成图标条，13 页导航换行或收进下拉 —— 具体断点本轮**未测**（L3）。

---

## 4. A / B / C 分类（V3 定稿）

**分类判据（V3 收紧，回应「不要仅因旧组件可挂载就判成纯搬迁」）**：

| 类 | 判据 | 反例（不算 A） |
|---|---|---|
| **A** | 组件**原样挂载**，交互与页内结构都不变 | 需要页内分段、需要拆块、需要新入口、需要换交互 → 都不是 A |
| **B** | 必须重新设计**界面结构或交互**，但不动内核能力 | 只加一行文案不算 B；换布局/换交互/加新控件/加分段算 B |
| **C** | 需要新增**采集 / 持久化 / 改 Agent 内核** | 只是读已有配置 → 不是 C |

**⚠️ V3 新增一条元判据（这条是本轮最容易被忽略的）**：

> **「组件或数据接口可以复用」≠「页面交互已经完成」。**

两者必须**分开记录**。一个页面完全可能「组件能挂、接口通」，但仍然达不到新版交互要求（分段、折叠、空状态、加载态、错误态、覆盖关系说明）。所以每页要记**两列**：

| 记录项 | 含义 |
|---|---|
| **接口复用度** | 组件与配置读写通道能否直接复用（A/B/C 的判据） |
| **交互完成度** | 是否达到新设计的页内结构（A 类默认「未达」，因为 A 的定义就是"不改交互"） |

**具体后果**：P1 搬完 6 页 A 类之后，这 6 页的**交互完成度仍是「未达」** —— 它们的页内折叠、空状态、说明文案属于 P3。**不能因为 P1 绿了就宣布这 6 页做完了。**

### A：可复用现有组件与配置读写接口（6 页）

| 页 | 组件 | 为什么是 A | 交互完成度 |
|---|---|---|---|
| 个人资料 | `ProfileTab` | 组件原样，`profile:*` 通道不变 | 未达（P3 接入折叠/空状态） |
| 通用与快捷键 | `GeneralTab` + `ShortcutsTab` | 两组件拼接就是一个 `<div>` 包裹（`GeneralPanel.tsx` 现在就是这么做的） | 未达 |
| 数据与存储 | `DataTab` + `ImageSaveTab` + `DownloadSaveTab` | 三个组件原样；两个目录项是 `Row`，挂上去即可 | 未达（含 B-11 说明） |
| 记忆 | `MemoryTab` | 原样 | 未达 |
| 经验与规则 | `ExperienceTab` | 原样 | 未达 |
| 关于 Harbor | `AboutTab` | 原样 | 未达 |

> **工具与扩展**：组件原样（`BrowserExtCard` / `SkillsTab` / `McpTab`），V2 减负后只剩 3 块 → **算 A**，但页内仍需二级分段（那是 B-7，不影响它先搬）。**交互完成度：未达。**

### B：必须重新设计界面结构或交互（不动内核）

| # | 事项 | 为什么是 B 不是 A | 涉及文件 |
|---|---|---|---|
| B-1 | 通知三档迁入「外观与通知」，`NotifyPanel` 换成摘要+跳转 | 要在两处改结构，且摘要要按当前值如实生成 | `NotifyPanel.tsx` / `AppearanceTab.tsx` |
| B-2 | `conversation` 拆两页 + 覆盖关系提示条（两页都写） | 跨页保留语义 | `ConversationPanel.tsx` 及其子块 |
| B-3 | 模型与服务商**四主标签**（服务商 / 模型与场景 / 运行策略 / 双模型协作）+ 接收 `CollabPanel` + `ScenesTab` 三块 | 从 2 块变 4 标签 6 块，必须重排 | `ModelsPanel.tsx` / `CollabPanel.tsx` / `ScenesTab.tsx` / `ProviderPanel.tsx` |
| B-12 | **`AssistantPanel` 拆三段**：人设（`name`/`systemPrompt`/`responseDepth`）→ 对话与任务；模型详情 + 运行策略 → 模型页 | 跨两页拆分，且要写清 `responseDepth` 的会话级覆盖 | `ProviderPanel.tsx` / `ConversationPanel.tsx` |
| B-4 | 对话与任务接收 `SchedulesPanel` | 页内结构变化 | `ConversationPanel.tsx` / `SchedulesPanel.tsx` |
| B-5 | 主区工作区（两视图同时挂载 + CSS 显隐 + 自适应断点） | 动渲染分支与布局 | `App.tsx` / `GlobalLayers.tsx` / `SettingsModal.tsx` |
| B-6 | `settingsTab` 提到 `useUIStore` 并在切回聊天时不丢 | 状态提升 | `useUIStore.ts` / 新壳 |
| B-7 | `detailedOnly` 机制拆除（含 `settingsView` 字段与 `ConversationExperienceTab` 的视图下拉）+ 替换成页内「高级/危险」折叠组 | 删一套机制、加一套组件 | `parts.tsx` / `SettingsModal.tsx` / `ConversationExperienceTab.tsx` / 各页 |
| B-8 | 补缺口：**8 个输入控件 + 2 处只读说明**（见 §3.1 判断结论） | 新增控件，接口已有 | 新组件 + `context` 页 |
| B-9 | `assistant.historyLimit` 文案改口径（P1 已改「按轮」，文案仍写「历史轮数」） | 一处文案，但改错会误导 | `ProviderPanel.tsx:145` |
| B-10 | `SETTINGS_INDEX` 按 13 页重排（40+ 条重新归属） | 纯手写表跟着页面改 | `settingsIndex.ts` |
| B-11 | 「数据与存储」写清两个目录项的**默认值依赖当前会话工作目录** | 新说明，且必须准确 | `DownloadSaveTab.tsx` |

### C：需要新增采集 / 持久化 / 改 Agent 内核（需单独授权）

**`模型用量 V1` 的完整范围（V3 定稿）** —— 用户本轮明确：不只 a~e。分三组：

**第一组：数据正确性（C-1a ~ C-1c，内核层）**

| # | 事项 | 为什么是 C |
|---|---|---|
| **C-1a** | 缺失 usage 时**显式记「未返回」**，且**在请求生命周期层**回报（不只改 `stats.record` —— 回调没触发时改 record 无效，见 §3.3 边界②） | 改统计落盘形状 + 调用点契约 |
| **C-1b** | 补齐**未记录的调用路径**：压缩（`compact-chunked`）/ 场景（`scene.cjs`）/ 协作（`collab-executor-codex`） | 三条路径现在完全不进统计（§3.3 边界①） |
| **C-1c** | `stats` 落盘加 **provider / taskId 归属**（新形状 → 要迁移，且**必须保留旧数据**） | 没有它做不出 Provider / 任务维度 |

**第二组：用户可见口径（C-1d ~ C-1e，界面 + 收敛）**

| # | 事项 | 为什么是 C |
|---|---|---|
| **C-1d** | ContextGauge 接真实 usage（最近一次请求）+ 三状态（统计中 / 无数据 / 有数字）；「本轮/任务累计」按需展开 | 渲染层要拿内核的 usage，且要改状态机 |
| **C-1e** | 旧估算路径清理（`contextUsage.ts` 只留内核裁剪用途）；`CostBreakdown` 标「折算非实付」；三类费用分开 | 涉及内核与渲染层口径收敛 |

**第三组：分析能力（C-1f ~ C-1i，本轮新增范围）**

| # | 事项 | 为什么是 C |
|---|---|---|
| **C-1f** | **每日 Token 热力图** | 要有按天 × 按量级的完整数据；`byDay` 只留 90 天（`stats.cjs:21`），热力图要决定窗口 |
| **C-1g** | **Provider / 模型 / 任务 / 时间四维分析** | 依赖 C-1c 的归属字段；现在只有 `byModel` 一维 |
| **C-1h** | **输入 / 输出 / 缓存 / 思考 token 分类展示** | 字段已有（`emptyBucket` 的 7 个键），但要处理「供应商没给 → 未知」而不是显示 0 |
| **C-1i** | **请求统计覆盖率与缺失状态**（这个月的调用里多少有 usage、多少没有） | 依赖 C-1a；这是「数据可不可信」的唯一诚实交代方式 |

**第四组：性能（C-1j）**

| # | 事项 | 为什么是 C |
|---|---|---|
| **C-1j** | **异步加载 + 增量汇总**（打开页面不卡） | `stats.json` 随天数增长（`byDay` 90 天 × `byModel` N 个 → 读全量再算会卡）；增量汇总要新落盘结构 |

> **验收判定**：
> - 只做完第一组 = **数据对了但用户看不到** → 不算 V1 完成
> - 只做完第一 + 第二组 = **能看见真实值，但没有分析能力**（V3 明确：这仍**不算**全部 V1）
> - **V1 完整验收 = 第一 + 第二 + 第三 + 第四组都完成**，且旧统计口径已清理、验收后不留双套数字
>
> 用户明确「真实用量采集可以独立分阶段授权」→ C-1 单独列期（P4 拆成 P4a/P4b），**不绑在 A/B 重构节奏上**；但**任何一阶段做完都不能宣布 V1 完成**。

**其他 C 项**：

| # | 事项 | 是否属于 V1 |
|---|---|---|
| C-2 | 设置变更「影响预览」（改预算前告诉你现在用了多少） | 否（可延后） |
| C-3 | Provider 专有压缩能力适配 | 否（本轮不做） |

---

## 5. 最小实施分期与依赖（V3 定稿）

### P0：壳 + 主区视图（**一切的前提**）

1. 13 页导航结构（替换 `SETTINGS_TABS` 的 11 项；`SETTINGS_INDEX` 同步重排 = B-10）
2. **主区两视图切换 + 自适应断点**（B-5）：优先「同时挂载 + CSS 显隐」，**允许等效实现**，但必须过下面的验收
3. `settingsTab` 提到 `useUIStore`，切回聊天不丢（B-6）
4. `detailedOnly` 拆除（B-7），页内折叠组件先只做外壳（各页接入放 P3）

**验收（真机，缺一不可 —— 与实现方式无关）**：
- 13 页都能打开；切走再切回**还在原页**
- 窄窗口不溢出、不出现横向滚动条
- **切到设置、在设置里点 5 页、再切回聊天：①草稿文字 ②滚动位置 ③流式中的消息视图仍在更新 ④正在跑的任务进度条 —— 逐项还在**（决策 3 的硬门槛）
- ⚠️ 第 ③ 项特别容易被漏：只验「草稿还在」不够 —— 流式期间切走再回来，若消息视图被卸载重建，用户会看到半截停住的回答

### P1：纯搬 6 页（A 类接口，可并行）

`个人资料` / `通用与快捷键` / `数据与存储` / `记忆` / `经验与规则` / `关于 Harbor` + `工具与扩展`（减负后 3 块）

**验收**：逐页对照旧页 —— 每个设置项都在、读写都通（真机逐项点一遍）。
**⚠️ 注意**：这一期绿了只代表**接口复用完成**，**不代表交互完成**（见 §4 的元判据）。这 7 页的页内折叠、空状态、说明文案仍在 P3。

### P2：归属调整（B-2 ~ B-4、B-11、B-12）

| 顺序 | 事项 | 依赖 |
|---|---|---|
| 1 | 模型与服务商**四主标签** + 接收 `CollabPanel` + `ScenesTab` 三块（B-3） | P0；**与 P3 的 `ScenesTab` 拆除同批做**（拆一次不留过渡态） |
| 2 | `AssistantPanel` 拆三段（B-12）：人设 → 对话与任务；模型详情 + 运行策略 → 模型页 | 与第 1 条同批（`ProviderPanel` 只大改一次） |
| 3 | 对话与任务接收 `SchedulesPanel` + 人设三项（B-4 / B-12） | P0 |
| 4 | 上下文与项目接收压缩阈值 + 覆盖关系提示（B-2） | P0，与第 3 条同批（两页提示条要一起写） |
| 5 | 工具与扩展减负（移除两处） | 与 1、2、3 同批 |
| 6 | 两个目录项的默认值说明（B-11） | P1 |

> **这一批必须整批做完再验**：拆一半会出现「双模型在两页都有入口」「定时任务两页都挂」「人设和 temperature 还并排摆着」的中间态。
> **验收**：模型页四个标签都能打开且各自内容正确；对话与任务里的人设三项改动**真的进系统提示**（可用 `prompt-diag` 或一条真机会话确认）；`responseDepth` 的会话级覆盖写得清楚。

### P3：页内分段 + 通知迁入 + 折叠接入

1. 页内二级分段 / 抽屉详情（B-7 的接入部分）—— 优先「权限与安全」（9 块）和「模型与服务商」（4 标签 6 块）
2. 通知三档迁入 + `NotifyPanel` 改摘要（B-1）
3. 各页高级/危险分组接入折叠组件（**含 P1 那 7 页的交互补齐**）

**验收（真机）**：三档在设置里改完，右栏摘要**立刻跟着变**（同一 store）；右栏不再有第二套编辑控件。

### P4：用量口径（C-1，**单独授权，分两段**）

**P4a：数据正确性（第一组，无 UI 依赖，可先做）**
1. C-1a 缺失 usage 显式记「未返回」（含请求生命周期）
2. C-1b 补齐压缩 / 场景 / 协作三条路径
3. C-1c `stats` 加 provider / taskId（**要迁移，保留旧数据**）

**验收（P4a）**：跑一段含压缩 + 场景 + 协作的会话，`stats` 的 `calls` 与「内核实际发出的请求数」**相等**（可先用日志数出来对账）。

**P4b：用户可见口径（第二组）**
4. C-1d ContextGauge 接真实 usage + 三状态
5. C-1e 旧估算路径收敛 + 费用三分

**验收（P4b）**：真实会话里，「最近一次请求」显示的 `prompt` 与 Provider 返回的 `prompt_tokens` **逐字相等**；断网 / 中转站不返 usage 时显示「无数据」，**不显示 0、不显示估算**；`CostBreakdown` 与 `BalanceCard` 分开标注且都不称「实付」（除非 Provider 返回）。

**P4c：分析能力（第三 + 第四组，可再分）**
6. C-1f 热力图 / C-1g 四维 / C-1h 分类 / C-1i 覆盖率
7. C-1j 异步加载 + 增量汇总

**验收（P4c）**：打开「模型用量」页耗时 < 1s（真机量，`stats.json` 用真实体量）；覆盖率明确显示「本月 N 次请求中 M 次无 usage」。

> **V1 完成判定**：P4a + P4b + P4c **全部完成**才算。任何单段做完都不能宣布 V1 完成（见 §4 C 表）。

### P5：补缺口（B-8，可延后）

**8 个输入控件**（`context.baseTokens` / `context.budget`×4 / `cache.prewarm` / `audit.retentionDays` / `memory.maxItems`）
**+ 2 处只读说明**（`tools.outputLimit` / `changeset.*`）
**+ 1 处复用**（任务预算走任务卡片，不进全局页）
**+ 1 处只读**（`assistant.clarify*` / `scale*` 六个阈值 —— 按 §3.1 判断：看得见就够，不给输入框）

---

## 6. 仍未定的事项 + 剩余技术验证事项（V3）

### 6.1 设计问题：全部已定

| 原问题 | 结论 |
|---|---|
| `settingsView` 是否还有非 `detailedOnly` 的用途 | **已核实（L1），没有别的用途** —— 全仓只有 `parts.tsx:113-126` 的 `visibleTabsOf`/`hiddenTabsOf`、`SettingsModal.tsx:45/59-79/204/223/244`（同一机制的门面）、以及 `ConversationExperienceTab.tsx:38-53`（这个开关自己的 UI 入口）。决策 1 落地时可**整套删掉**（`taskSummary` 那条保留），删完无功能损失。 |
| 「模型与服务商」怎么分段 | **已定**：四主标签 —— 服务商 / 模型与场景 / 运行策略 / 双模型协作（决策 4） |
| `pricing` 价目表要不要可编辑 | **已定**：不新增编辑入口（决策 5） |
| 「系统」组只有 1 页是否合理 | **已定**：不为了数量对称新增页面（决策 6） |

**→ 设计层面没有待定项了。**

### 6.2 剩余技术验证事项（实施前必须验，本轮均未做）

| # | 要验什么 | 为什么必须先验 | 怎么验 |
|---|---|---|---|
| T-1 | **`stats.json` 真实体量下的读取与渲染耗时** | C-1j（异步加载）是否必需，取决于打开「模型用量」页要多久。现在 `summary()` 读全量文件再算（`stats.cjs:158`） | 拿真实 `stats.json`（Dev 版 161 个任务量级）计时 `stats.summary()` |
| T-2 | **unknown 的实际占比**（有多少请求没拿到 usage） | C-1a 的收益大小取决于这个数；若只有 1%，优先级可降 | 读真实 `stats.json` 的 `calls` 与内核日志里的实际请求数对账 |
| T-3 | **三条未记录路径占多少调用**（压缩 / 场景 / 协作） | C-1b 的工作量排序依据 | 日志里按 `label` / `scene` 统计（`llm.cjs` 有 `label` 字段） |
| T-4 | **`token-metrics.jsonl` 与 `stats.json` 同一批请求的数字是否一致** | 若不一致，说明两套口径有一处错；删任何一边之前必须知道 | 取同一天的 `token-metrics` 行与 `stats.byDay`，按 `calls` 对账 |
| T-5 | **DeepSeek / 中转站在流式下到底返不返 `usage`** | 决定「无数据」状态出现的频率，直接影响 ContextGauge 的默认观感 | 真机发一次流式请求，看 `llm.cjs:259` 的 `usage` 是否为空 |
| T-6 | **两视图切换的真实开销**（内存 / 重渲染 / 首次打开延迟） | 决策 3 要求「不改变主窗口尺寸」，但两视图同时挂载会增加常驻内存 | 真机量切换耗时与 JS heap 前后差 |
| T-7 | **13 页在窄窗口（< 1200px / < 900px）的实际溢出** | P0 验收要求「不出现横向滚动条」，但没人测过 9 块内容同页的极端情况 | 真机拉窄窗口逐页看 |
| T-8 | **`assistant.clarify*` / `scale*` 六个阈值暴露给用户的风险** | §3.1 判断「只给只读」，但没验证「显示当前值」会不会诱导用户去手改 `config.json` | 实施时看真机反馈，不预设 |

> 这八项**都不需要改代码**就能先验，建议在 P0/P2 开始前各花半小时做掉 —— 它们决定的是「工作量估得准不准」，而不是「能不能做」。

---

## 7. 本轮没做 / 没验证的（V3）

| 项 | 状态 |
|---|---|
| 真机逐项点一遍所有设置 | **未做**（本轮是映射核对，不动界面） |
| 13 页在窄窗口的实际溢出情况 | **未测**（L3，见 T-7） |
| **「切到设置再切回聊天」的连续性** | **未测（L3）** —— 决策 3 的硬门槛，必须真机验草稿 / 滚动 / 流式 / 任务进度四项 |
| **`stats.json` 里 unknown 占比** | **未统计（L3）** —— 见 T-2 |
| **`token-metrics.jsonl` 与 `stats.json` 的口径对比** | **未对齐** —— 见 T-4 |
| **三条未记录路径（压缩 / 场景 / 协作）各占多少调用** | **未统计** —— 见 T-3；本轮只确认了它们**不传 `onUsage`**（L1，脚本 `.tmp/v3-usage-scan.cjs`） |
| **流式下 DeepSeek / 中转站是否返 usage** | **未验（L3）** —— 见 T-5；零真实 API 调用 |
| **两视图切换的开销** | **未测** —— 见 T-6 |
| **V1 范围内的分析能力（热力图 / 四维 / 覆盖率 / 性能）** | **只做了范围定义，未做实现** —— 属 C，需单独授权 |
| **本轮未改任何应用源码** | 已确认（`git status` 只多这一份报告） |

---

## 8. 最终结论（V3）

### 8.1 功能归属

**13 页接得住全部 11 个旧分类，零遗漏。但「搬」只有 6 页 —— 其余是「改」。**

| 归类 | 页 | 说明 |
|---|---|---|
| **A（接口可原样复用）** | 个人资料 / 通用与快捷键 / 数据与存储 / 记忆 / 经验与规则 / 关于 Harbor + **工具与扩展** | 7 页。**但交互完成度全部「未达」** —— 页内折叠/分段属 P3 |
| **B（要重设结构或交互）** | 外观与通知 / 模型与服务商 / 对话与任务 / 上下文与项目 / 模型用量 / 权限与安全 | 6 页。含 3 处拆页、1 处拆块（`ScenesTab` 四处）、3 处改归属（`CollabPanel`/`SchedulesPanel`/两个目录项）、**1 处拆组件（`AssistantPanel` 拆三段）** |
| **C（要动内核）** | 模型用量（C-1 全范围） | 单独授权，分 P4a/P4b/P4c |

**「模型与服务商」的四个主标签**（决策 4）：服务商 / 模型与场景 / 运行策略 / 双模型协作。
**人设三项（`name` / `systemPrompt` / `responseDepth`）不在模型页** —— 它们进系统提示，换模型不改变它们。

### 8.2 真实用量差距（这是本轮最实质的结论）

用户可见的 Token 数字离"真实"还有**三道坎**，不是一道：

| 坎 | 现状 | 后果 |
|---|---|---|
| ① 路径没覆盖 | `stats.record` 只接主循环；**压缩、场景（标题/翻译/建议/OCR）、协作三条真实调用完全不记**（L1：三处都不传 `onUsage`） | 用户看到的总量**系统性偏低**，且低多少不知道 |
| ② 缺失不可见 | `llm.cjs:259` 是 `if (usage) onUsage?.(...)` —— usage 空时**回调不触发**；`stats.record` 的 `{ok:false}` 也没人看 | 不知道「这个月有多少次没记上」 |
| ③ 维度不够 | `stats` 只有 `total` / `byDay` / `byModel`，**没有 provider、没有 taskId** | 做不出「按 Provider / 按任务」分析（V1 明确要的） |

**所以「模型用量 V1」不是「把 ContextGauge 接上真实 usage」就完事** —— 那只是第三坎的一半。完整范围见 §4 的 C-1f~j。

### 8.3 推荐实施依赖顺序

```
P0 壳 + 主区视图（切页四件事都不丢：草稿/滚动/流式/任务进度）
 ├── 卡：B-5 的实现约束（优先双视图同时挂载，允许等效实现但要过验收）
 ├── 卡：settingsTab 提状态（B-6）
 └── 卡：detailedOnly 整套拆除（B-7）
      ↓
P1 纯搬 7 页（接口复用；交互完成度仍「未达」）
      ↓
P2 归属调整（整批做，拆一半会出现双入口/双份人设的中间态）
 ├── 模型与服务商四主标签（B-3）← 与「ScenesTab 拆除」同批
 ├── AssistantPanel 拆三段（B-12）← 与 B-3 同批（ProviderPanel 只大改一次）
 ├── 对话与任务接收 SchedulesPanel + 人设三项（B-4 / B-12）
 ├── 上下文与项目接收压缩阈值 + 两页覆盖提示（B-2）
 └── 工具与扩展减负
      ↓
P3 页内分段 + 通知迁入 + 折叠接入（含补齐 P1 那 7 页的交互）
      ↓
P4 用量口径（C-1，单独授权，与 P2/P3 无耦合，可提前）
 ├── P4a 数据正确性：C-1a 生命周期回报 / C-1b 补三条路径 / C-1c 归属字段
 ├── P4b 用户可见：C-1d ContextGauge 三状态 / C-1e 旧路径收敛 + 费用三分
 └── P4c 分析能力：C-1f 热力图 / C-1g 四维 / C-1h 分类 / C-1i 覆盖率 / C-1j 性能
      ↓
P5 补缺口（8 控件 + 2 只读说明 + 1 复用 + 6 个阈值只读）
```

### 8.4 四条硬门槛（不满足就不算做完）

1. 切到设置再切回聊天 —— **草稿 / 滚动位置 / 流式中的消息仍在更新 / 任务进度条** 逐项还在
2. 通知三档**只有一处**能编辑，右栏摘要随设置实时变
3. 「模型用量」页与 ContextGauge 的数字**没有一个是本地估算**；缺失 usage 显示「无数据」，**不显示 0**
4. **「最近一次请求的输入」不得标成「当前上下文占用」**；余额不得标成「消费」；价目表折算不得标成「实付」

---

## 附：可复跑的核对脚本

本轮用的只读脚本在 `.tmp/`（不进仓库）：

```bash
node .tmp/coverage-v2.cjs      # 131 个配置字段 × 69 个组件的引用矩阵
node .tmp/mount-check.cjs      # 每个设置组件被谁挂载
node .tmp/orphan-settings.cjs  # 只在 store 里出现、无 UI 引用的设置
node .tmp/tab-compose.cjs      # 每个 tab 的实际组成（SectionTitle / 子组件）
node .tmp/ipc-modal.cjs        # 175 个 IPC 通道命名空间 + Modal 尺寸档
node .tmp/v3-usage-scan.cjs    # 本轮新增：哪些调用点传了 onUsage、token-metrics 的消费者
node .tmp/check-report.cjs     # 报告自身一致性（V 标志锚点 + 旧措辞残留）
```

> `tmp/` 被 `.gitignore` 挡在仓库外（`tmp/*`），换台机器就没有。要长期保留请移到 `tools/dev/`。
