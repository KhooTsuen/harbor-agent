# harbor-edge —— Harbor 浏览器扩展（Edge）

这个目录是 **Harbor 接入本地 Edge 浏览器**的那一摊东西。它**不是**主应用的一部分：
主应用是 Electron 窗口，这里是浏览器侧的扩展 + 让两者说话的 native host。

> 阶段与实测记录见 `docs/research/edge-extension-*.md`。
> 当前状态：**P0 功能已接线并通过自动化与隔离 Edge 验收**。当前页阅读、页面操作、会话流、停止、重新生成入口和站点临时拒绝均已验证；重新生成的真实模型返回及需要人工点击的产品工具栏入口仍须用户试用确认。
> 侧边栏能**发消息**、看**流式回复**，且与主窗口**同一条会话**。
> 布局经用户要求返工为「**顶栏 + 对话区 + 输入框 + 会话抽屉**」（会话列表不再常驻）。
> **Phase 3c 完成** —— 抽屉里点一条 = 侧边栏切过去（**主窗口不动**，用户拍板）；
> 没选会话时发消息会**自动新建一条**；顶栏 ＋ 也是真的。
> **M03 网页感知补完**（按《Harbor Agent Browser Extension》模块体系）—— 选区 / 可交互元素列表
> （带引用与状态）/ iframe 能力检测（读不到如实报，不捏造）/ **页面版本号**；敏感字段一律不读。
> **M04 第 1 步完成** —— `browser.getElements`（元素列表 + **引用失效判定**）。
> **M04 第 2 步完成** —— `browser.click` + `browser.verify`：**「点了」≠「生效」**（返回
> URL / 标题 / 节点数 / 正文字数的**前后对比**做状态证据）；点击**前**先校验版本号，
> 失效即 `STALE_REF` + 人话（**根本不发指令**）；verify 四类期望（文本 / 选择器 / URL）。
> **M04 剩余 + M05 完成** —— `type` / `select` / `scroll` / `wait` / `navigate` +
> `tabs.list` / `tabs.activate` / `tabs.search`；**M04/M05 补齐**（2026-10-16）：
> `clear` / `focus` / `key` + `tabs.create` / `tabs.close`。
> · **敏感字段（密码 / 信用卡）拒绝而非遮蔽** —— **一个字节都不写进页面**；
> · **提交 / 支付 / 删除类按钮先弹确认卡**（复用 Harbor 既有确认卡），
>   **拒绝或超时就根本不发点击指令**；没接线时保守拒绝；
> · `tabs.activate` / `tabs.close` 的 id 必须在 list 里出现过（防编 id），且**回读确认**；
>   拿不到 url 的标签**如实标 `urlHidden`**（manifest 刻意没有 `tabs` 权限）。
> **★ 已接成 Harbor 工具**（2026-10-16）—— 上面这些能力**在对话里调得到**了：
> `edge_page` / `edge_click` / `edge_type` / `edge_select` / `edge_scroll` / `edge_wait` /
> `edge_key` / `edge_focus` / `edge_tabs`（操作用户**自己的 Edge**；只读网页仍用 `browse_*`）。
> **M02-A 完成**（2026-10-19）—— 回复正文**真渲染 Markdown**（复用主应用同一份解析 + 渲染，
> `lazy()` 载入，katex / CodeBlock 不进侧边栏首屏）+ **停止生成**（真取消：`chat-abort` →
> 主进程 → 渲染层 `stopActiveRequest`；没在跑时**如实回绝**，不做「本地停显示」冒充）。
> 依据：`tools/accept-m02a.cjs`（真机，**正向 + 反向**）· 自检 `164-m02-panel`。
> 这两处**本轮（2026-10-20）未复跑**，所以不写判据条数 —— 要精确值就跑一遍。
>
> **P0 续修**（2026-10-20）：重新生成走 Harbor 真实回合；选区右键、快捷键和用户触发的选区按钮只填草稿，不自动发送。未申请全站 `host_permissions`，也不常驻注入脚本。
> · （**M02 小批 B / C 已完成 2026-10-20**：任务卡 · 当前网页卡 · 上下文开关 · 设置抽屉 ——
>   真侧栏 `accept-m02b` 36/36 · 自检 `176`/`177`）
> · **M03**：阅读模式正文、选区周边上下文和 SPA 稳定等待已接线。
> · **M06/M07**：去重覆盖页面版本变化；站点默认允许，可在同一主进程策略中临时拒绝与撤销。
> · **M08–M12**：截图 / extract / 跨页编排等，全部未开工
>
> 📍 **完整进度表与每条依据**在 `docs/research/edge-extension-roadmap.md`（本文件不重复列，
> 免得两处各写一套、然后漂）。
>
> ⚠️ **验收脚本的锚点**（改了渲染层必须同步，否则脚本**静默失效**、照跑不误）：
> `[aria-label="…"]` 的**归属表**在 `lib/ext-probe-panel.cjs` 的文件头（唯一真相源）。
> 两条最容易忽略的：「读当前页」是**图标按钮**（只能按 `aria-label` 找）；
> `STATUS_TEXT_EXPR` 取文档里**第一个** `[role=status][aria-live=polite]`
> （所以顶栏的连接文字是**纯文本**、抽屉里的提示用 `role=alert`）。
> 会话列表在**抽屉里**（默认不挂载），读之前要先点顶栏 ☰ 的 `[aria-label="选择对话"]`；
> 抽屉自己叫 `会话抽屉` —— **不能**叫「选择对话」，否则脚本会点到抽屉自身（假绿）。
> 锚点唯一真相源：`lib/ext-probe-panel.cjs`（`ext-probe.cjs` 再导出它）。

## ★ 已知缺口（别忘）

### ✅ 3c 已解决：侧边栏可以有自己的「选中会话」

**Phase 3c 起**，侧边栏维护**自己**的选中会话（主进程 `ext-chat.cjs` 的 `selectedSessionId`）：

| 动作 | 结果 |
|---|---|
| 抽屉里点一条 | **只切侧边栏**，主窗口不动（用户 2026-10-16 拍板） |
| 一条都没选时发消息 | **自动新建一条**再发（两侧都出现） |
| 顶栏 ＋ | 新建一条，**两侧都切过去** |

> ⚠️ 「读当前页」**仍然**落进「主窗口当前打开的那条」（`ext:activeSession` 报的）——
> 那是 Phase 2 起的语义，**本次没动**。两者目标不同：**发消息**看侧边栏的选中，
> **读页面**看主窗口的当前会话。

**兜底行为（内容不会丢）**：渲染层没报过、或报的那条会话已被删时，
`electron/core/ext-ops.cjs` 的 `ingestPage()` 会**新建一条专用会话**把内容装进去。

### ★ 3b 的一条硬约束：主窗口不在就没法发（C-α 的代价）

侧边栏发消息的执行者是**渲染层**（落盘只在那边，见 `core/ext-chat.cjs` 文件头）。
所以 `minimizeToTray=false` **且窗口真被销毁**时，侧边栏会被拒（人话「Harbor 主窗口不在」）。
默认配置下关窗口 = 藏到托盘（`main.cjs:135`），渲染层还在，**不会命中**。

### ⏭ 待办：旧 host 的回包，扩展侧认不出（会显示成「超时」）

> **2026-10-20 复核：仍在。** 复核方式：看 `extension/lib/native.js` 的 `port.onMessage`
> 回调 —— 它只有两个出口：`msg.push === true`（推送帧）与 `typeof msg.id === 'string' && pending.has(msg.id)`
> （按 id 兑现）。旧 host 回的是**既无 id、又无 push** 的 `{error:…}`，两个出口都不进 → 干等 15 秒。

**实测现象**（2026-10-16 真机手点）：Edge 里装的是 **3a 新扩展**，而那个副本里跑的还是
**Phase 2 旧内核**（旧 host + 旧主进程）→ 点「刷新」显示 **「Harbor 没有响应（超时）」**。

根因：旧 host 收到不认识的 kind 时，回的是**不带 `id`** 的 `{error:…}`；
扩展侧按 `id` 匹配 pending，匹配不到 → 只能干等到自己的 15s 超时。

> ⚠️ 顺带一提：「已连接」**不等于**「会话列表能用」—— ping/pong 是 **host 自己**回的，
> 根本不经过主进程。所以旧内核下顶部照样绿灯，列表却超时。

**要做的**：扩展侧对「收到不带 id 的回包」加一条更快的判据，文案改成
「Harbor 版本较旧」之类，而不是让它干等到超时。
（设计说明 §6.1 的组合矩阵里预期过这一格，但当时预想的文案与实测不符 —— **以实测为准**。）

### ⏭ 待办：`pipeName()` 没归一化路径

> **2026-10-20 复核：仍在。** 复核方式：看 `electron/core/ext-protocol.cjs` 的
> `pipeName()`，仍是 `crypto.createHash('sha1').update(String(dataDir ?? ''))`，
> **没有** `path.resolve()`、**没有** 小写归一。

`electron/core/ext-protocol.cjs` 的 `pipeName()` 直接对数据根字符串做 `sha1`。
现在 host 与主进程**恰好**算出同一个名字（两边字符串逐字符相同），但路径里
多一个结尾反斜杠、或盘符大小写不同，管道名就会**静默对不上**
（症状：永远「Harbor 没有在运行」，而两边其实都活着）。

**要做的**：算 hash 前先 `path.resolve()` + 统一小写（Windows 路径大小写不敏感）。

### ⏭ 待办：删 `main.cjs` 那条兼容分支（A4，独立小提交）

> **2026-10-20 复核：仍在。** 复核方式：`findstr /n "isHostArgv" electron\main.cjs` —— 还有命中。

`electron/main.cjs` 有一行 `if (isHostArgv()) run()` —— 它是 **Phase 1a 的兼容形态**
（Edge 直接拉 `Harbor.exe`，不经 `.cmd`）。Phase 3a 起主驱动是
`core/ext-host-loop.cjs` 的 `runInteractive()`，`run()` 只剩这一条分支在用。

**为什么没在 3a 删**：删它是**行为变更**（Edge 若真直接拉 `Harbor.exe`，将来会「开一个窗口」
而非「假装 host 然后失败」），超出 3a 范围。用户 2026-10-15 裁决：**留作独立小提交**。

要删的四处：`main.cjs` 那行 · `native-host.cjs` 的 `run()` · `isHostArgv` 的形态③（`--parent-window=`）
· 154 自检里对应的断言。

## 目录

| 路径 | 是什么 |
|---|---|
| `extension/` | **真扩展的源**（`manifest.json` + `service-worker.js` + `lib/native.js`）—— 构建时原样拷进产物 |
| `extension/lib/native.js` | 扩展侧**通道层**（Phase 3a）：连 host / 重连 / **按 id 匹配的 pending Map** / 状态广播 / **推送帧广播**（3b） |
| `src/sidepanel/` | 侧边栏的 React 源：`index.html` / `main.tsx` / `App.tsx`（**顶栏三区：☰ / 状态区 / 设置+新建**）/ `ChatPanel.tsx`（**对话区**）/ `TurnBubble.tsx`（**一轮的显示 + Markdown**）/ `SessionDrawer.tsx`（**会话抽屉，从左侧滑出**）/ `ReadPageButton.tsx`（读当前页，**图标按钮**）/ `ObserveButton.tsx`（观察页面） |
| `src/sidepanel/ChatPanel.tsx` | 侧边栏**对话区**（3b）：发消息 + 流式回复显示（按 `seq` 丢弃重排的旧片）+ **停止生成**（M02-A） |
| `src/sidepanel/TurnBubble.tsx` | **一轮的显示**（M02-A）：`lazy()` 载入主应用那份 `Markdown`（katex / CodeBlock 不进首屏）；加载中 / 失败退回**纯文本** |
| `src/sidepanel/ObserveButton.tsx` | 「观察页面」按钮（**M03**）：读结构（选区 / 元素 / 版本号）—— 与「读当前页」是两个动作 |
| `extension/lib/observe.js` | **M03 采集器**（注入页面跑）：★ 必须**自包含**（见该文件头），产出选区 / 元素 / iframe / **页面版本号** |
| `extension/lib/observe-run.js` | **M03**：执行「观察页面」那一步（注入 → 送主进程 → 落快照） |
| `extension/lib/act.js` | **M04-2 注入函数**（`clickElement` / `verifyPage`）：★ **必须自包含**（`executeScript` 会 `toString()` 注入） |
| `extension/lib/command-run.js` | **M04**：SW 侧收下行指令 → 注入执行 → 回执 `page-result`（含**导航型点击**的判定） |
| `extension/lib/active-tab.js` | 「拿前台标签 + 判受限页」**唯一实现**（读正文与观察页面共用；那两句人话别改） |
| `vite.config.ext.ts` | 扩展的独立 Vite 配置（root / postcss / outDir / alias 都跟主应用不同） |
| `postcss.config.js` | 扩展的 Tailwind 配置（theme 继承主 config、content 只扫扩展 + 用到的 UI 组件） |
| `harbor-host.cmd` | **native host 包装器**（纯 ASCII）——`ELECTRON_RUN_AS_NODE=1` + `Harbor.exe` + `native-host.cjs` |
| `install-host.cmd` / `uninstall-host.cmd` | 装 / 卸 native host（注册表 + 清单，幂等） |
| `lib/driver.cjs` | 验收共用的 Edge 驱动（隔离 profile / 注册表 / 读扩展 ID） |
| `lib/ext-probe.cjs` | 验收共用：CDP 求值 / 找 SW / 喂帧（**再导出**下一条） |
| `lib/ext-probe-panel.cjs` | 面板 **DOM 锚点**（**可访问文案的唯一真相源**，文件头带**归属表**）：状态行 / 读页面 / 观察页面 / ☰ / 当前会话名 / 抽屉 / 会话列表 |
| `lib/ext-stage.cjs` | 验收共用的**装/卸隔离 host**（真 exe + 真机制 + 隔离数据根） |
| `tools/` | 验收脚本（见下） |
| `ext/` | Phase 1b 的**探针扩展**（历史验收资产，**不要动**） |
| `phase0/` `exp/` | Phase 0 / 三组实验的脚本与产物（历史资产） |
| `dist/sidepanel/` | 构建产物 —— **这个目录本身就是可加载的扩展** |

## 构建

在**项目根**跑（不是在这个目录）：

```cmd
npx vite build --config harbor-edge/vite.config.ext.ts
```

产物落 `harbor-edge/dist/sidepanel/`：`index.html` + `assets/` + `manifest.json` + `service-worker.js` + `lib/`。
Edge 里「加载已解压的扩展」直接选这个目录。

> ⚠️ SW 是 **ESM**（`manifest.background.type = "module"`）—— 删了那句，`import` 会直接失败。

## 验收脚本

| 脚本 | 验什么 | 跑法 |
|---|---|---|
| `tools/accept-sidepanel.cjs` | 构建产物**能当扩展页加载**（Phase 1c 第一步） | `node harbor-edge/tools/accept-sidepanel.cjs` |
| `tools/accept-extension.cjs` | 真扩展 + native host **端到端**：能读到哪些状态（Phase 1c 第二步） | `node harbor-edge/tools/accept-extension.cjs` |
| `tools/accept-phase2.cjs` | 「读当前页 → 包装 → 落会话」（Phase 2） | `node harbor-edge/tools/accept-phase2.cjs` |
| `tools/accept-phase3a.cjs` | **双向通道 + 会话列表**（Phase 3a） | `node harbor-edge/tools/accept-phase3a.cjs` |
| `tools/accept-phase3b.cjs` | **侧边栏发消息 + 流式回复 + 两端同一条**（Phase 3b） | `node harbor-edge/tools/accept-phase3b.cjs` |
| `tools/accept-phase3c.cjs` | **选会话（只切侧边栏）/ 未选中自动新建 / ＋**（Phase 3c） | `node harbor-edge/tools/accept-phase3c.cjs` |
| `tools/accept-m03.cjs` | **M03 网页感知**（选区 / 元素 / **密码遮蔽** / 跨域 iframe / **版本号稳定与变化** / 落盘） | `node harbor-edge/tools/accept-m03.cjs` |
| `tools/accept-m04a.cjs` | **M04-1 元素列表 + 引用失效判定** | `node harbor-edge/tools/accept-m04a.cjs` |
| `tools/accept-m04b.cjs` | **M04-2 点击 + 验证**（真点击 / 状态证据 / 旧引用被拒 / 导航型点击如实说清） | `node harbor-edge/tools/accept-m04b.cjs` |
| `tools/accept-m04c.cjs` | **M04-3 不打开侧边栏也能推指令**（主进程主动连 + 真推） | `node harbor-edge/tools/accept-m04c.cjs` |
| `tools/accept-m04d.cjs` | **M04 剩余 + M05**（34 条）：type 拒密码/信用卡 · select · scroll · wait · navigate · **提交按钮弹确认卡 + 拒绝不点** · tabs 三件 | `node harbor-edge/tools/accept-m04d.cjs` |
| `tools/accept-m04f.cjs` | **工具链路 + 补齐动作**（32 条）：**从 `tools.execute()` 调 `edge_*`**（「能被调用」的判据）· 清空/聚焦/按键 · tabs 新建/关闭 · 风险档与只读档 | `node harbor-edge/tools/accept-m04f.cjs` |
| `tools/accept-m02a.cjs` | **M02-A**：**Markdown 真渲染**（回复里给标题/代码块/表格，面板必须真出 `<h2>`/`<pre>`/`<table>`）+ **停止生成**（没在跑时**如实回绝**；在跑时主进程真推 `ext:abort`）。⚠️ 面板仍是**扩展页标签**，尚未改真侧栏（见硬规则三） | `node harbor-edge/tools/accept-m02a.cjs` |
| `tools/accept-ownership.cjs` | **本批**（19 条，**真侧栏**）：会话归属（侧边栏选 A、主窗口开 B → 读当前页落 A，反向落 B）· 站点黑名单（拉黑后不允许）· **重复指令去重**（同引用连点两次 → 页面只计一次，且第二次回执明说 `duplicate`） | `node harbor-edge/tools/accept-ownership.cjs` |
| `tools/accept-m02b.cjs` | **M02-B / C**（36 条，**真侧栏**）：任务卡（相位 / 工具 / **等你确认**）· 当前网页卡（显示的是用户那一页 + 能不能读的判据）· **上下文开关三步闭环**（开着读→计数增 · 关掉→一个字节都不进 + 人话 · 开回来→又能读）· 设置抽屉（能力清单从 manifest 现算 · 站点权限只指路） | `node harbor-edge/tools/accept-m02b.cjs` |
| `tools/accept-toolbar-entry.cjs` | **工具栏入口**（人在真 Edge 里点图标、脚本自动判定）：点图标触发 `action.onClicked`（`harborInvoke` 只有它才写）· 侧栏真出现 · **activeTab 链路端到端**（拿到 url + `executeScript` 读到正文）。★ 用**产品 manifest**，不加 `host_permissions` | `node harbor-edge/tools/accept-toolbar-entry.cjs --timeout=300` |
| `tools/accept-host.cjs` | Phase 1b 探针那条链路（native host ping/pong） | `node harbor-edge/tools/accept-host.cjs` |
| `tools/read-extid.cjs` | 起一次隔离 Edge、读**真实**扩展 ID | 由 `install-host.cmd` 调 |

全部脚本都**自己起隔离 Edge**（独立 `--user-data-dir` + 隔离数据根），**不碰**你正在用的那个。

**自检组**（纯 Node、不需要 Edge，`npm test` 就会跑）：
`154` native-host · `155` install · `156` ext-bridge · `157` ext-protocol · `158` ext-chat ·
`159` observe（M03）· `160` ext-command · `161` act · `162` m04-rest · `163` edge-tools ·
`164` m02-panel（M02-A）· `174` 归属 + 真侧栏口径 · `175` 站点策略 + 去重 · `176` M02-B 两张卡 · `177` M02-C 设置抽屉。
它们钉的是**源码接线**（少了哪一环会让按钮点了没反应、而界面不报错），真机那一段才归上面的脚本 ——
两者互补，缺一不可。

> ⚠️ **写注册表的脚本必须串行跑，绝不能并行。**
> 判定方法（比背名单可靠）：**凡 `import` 了 `lib/ext-stage.cjs` 的都算**。
> 2026-10-20 核实：这样的脚本共 **11 个**（phase2 / 3a / 3b / 3c / m02a / m03 / m04a / m04b /
> m04c / m04d / m04f），其中 10 个走 `snapshotRegistry` / `restoreRegistry`。
> `accept-sidepanel` / `accept-extension` / `accept-host` 是早期探针，不写注册表。
> 查实时名单：`findstr /m /c:"ext-stage.cjs" harbor-edge\tools\accept-*.cjs`
> 它们都写同一个全局键 `HKCU\...\NativeMessagingHosts\com.harbor.agent`
> （`finally` 里「摘 → 装隔离 → 恢复真原值」）—— 并行会互相踩，**键可能被删掉**。
> 而且**最好的做法是一条一条单独跑**：它们各自起真 Edge，前一个的残留会抢前台，
> 后一个就报「读不到当前页地址」（2026-10-16 实测：串行跑时 m03 红 14 条、
> m04a 红 9 条，**单独跑都是全绿**）。
>
> ⚠️ **原值必须来自外部备份**（2026-10-16 修，六脚本统一）：它们原来都用「开跑时现读
> 一次」当原值 —— 上一轮没恢复成功的话，读到的就是**隔离值**，于是「恢复成隔离值 +
> 回读一致」→ 打印「✓ 一致」，而用户手工装的那条**早被覆盖了**。现在走
> `lib/ext-stage.cjs` 的 `snapshotRegistry` / `restoreRegistry`：**第一次**读到的真值
> 记进 `tmp/.native-messaging-registry.json`，之后以它为准；恢复后**回读比对**、
> 不一致判失败。`accept-phase2.cjs` 原来是**只删不恢复**（它还会故意删一次验判据 ⑰），
> 现在也纳入。
>
> ⚠️ 改验收脚本时注意：**别把 `regSnap` 声明写在 `try` 里面** —— `finally` 里 `const`
> 取不到，会 `ReferenceError`，恢复那步直接抛异常（实测：注册表被删）。
>
> ⚠️ `accept-phase2/3a/3b/3c/m04a/m04b.cjs` 会**临时写 `com.harbor.agent` 注册表**（指到
> 隔离清单），跑完 `finally` 里**恢复真原值** —— 如果你之前手动装过 host，跑完那条还在。
> 另：3b / 3c 那一跑需要**源码树实例**（改的是渲染层，打包版里是旧的）—— 脚本自己拉
> `vite + electron .`，并把数据根指到 `data/unit-test-data`。

---

## ★ 硬规则二：同一 profile 二次启动 Edge，扩展**不会**自动启用

**改了 `extension/` 或 `src/sidepanel/` 后要真机验，必须换一个全新 profile 起 Edge。**

Phase 2 手点验收时踩到（2026-10-15）：`--user-data-dir=<同一个 profile>` + `--load-extension`
首次启动能装并跑起来；**重启同一个 profile，Edge 不再启用那个 unpacked 扩展** —— 症状是
CDP 里**找不到我们扩展的 service_worker**（别的扩展的 SW 都在），点图标毫无反应。

```bat
rem ✗ 错：改完扩展后拿旧 profile 重启 —— SW 根本不启动
msedge.exe --user-data-dir=harbor-edge\profiles\profile-manual --load-extension=harbor-edge\dist\sidepanel

rem ✓ 对：换一个新 profile（ID 由**加载路径**决定，所以 ID 不变、host 清单不用改）
msedge.exe --user-data-dir=harbor-edge\profiles\profile-manual2 --load-extension=harbor-edge\dist\sidepanel
```

**排查手法**：别猜「是不是代码坏了」，直接问 Edge —— 带 `--remote-debugging-port` 起，
然后 `GET http://127.0.0.1:<port>/json/list`，看有没有
`type=service_worker` 且 url 含我们扩展 ID 的 target。**没有 = 扩展没启用**（而不是代码错）。

## ★ 硬规则三：验收侧边栏必须走**真侧栏**，不许新开扩展页冒充

**「先打开一个页面，再从侧栏入口点开侧栏插件」—— 这是唯一合格的路径。**

2026-10-20 用户当场指出：在此之前 **14 个 accept 脚本全都在用「新开一个
`chrome-extension://<id>/index.html` 标签」冒充侧边栏**。那不是用户看到的东西：

| | 真侧栏（side panel） | 新开扩展页标签（错误做法） |
|---|---|---|
| 位置 | 浏览器**右侧面板**（实测 `innerWidth=382`） | 占一个标签位、整页 |
| 在 `chrome.tabs` 里 | **不在** | 在 |
| 用户怎么打开 | 点工具栏图标 / 右键 / 快捷键 | 根本打不开（用户没有这条路） |

### 正确做法（已抽成共用件 `lib/ext-panel.cjs`）

1. 先开**用户页面**（普通 http 页）
2. 开一个扩展页当**触发页**，打 marker（`window.__harborTrigger`）
3. 在触发页上注入按钮 → 用 CDP `Input.dispatchMouseEvent` 派**真实鼠标事件**点击
   → 按钮里调 `chrome.sidePanel.open({ windowId })`
4. `sidePanel.open()` 成功后会多出一个独立 `page` target，**URL 与触发页完全相同**
   → 只能靠 marker 区分：**有 marker 的是触发页，没 marker 的才是真侧栏**
5. 关掉触发页、把用户页面切回前台（否则侧栏里 `chrome.tabs.query({active})`
   拿到的是扩展页自己）

### 两个实测事实（别再自己猜）

- **`Runtime.evaluate({ userGesture: true })` 骗不过它** —— `sidePanel.open()` 会抛
  `may only be called in response to a user gesture`。必须用真实的
  `Input.dispatchMouseEvent`（它会产生 transient user activation）。
- **CDP 点不到浏览器工具栏**，所以自动化里拿不到 `activeTab`。实测在真侧栏中：
  `chrome.tabs.query` 的 url 全空、`chrome.scripting.executeScript` 直接被拒
  （`Cannot access contents of the page. Extension manifest must request permission...`）。
  所以验收要给**副本**临时加 `host_permissions: ['http://127.0.0.1/*']`
  ——那只是为了把「权限不足」这个噪声排除掉，**不是产品行为**；
  产品靠 `activeTab`（用户点图标才授予）。脚本会复核产品 manifest 没被改。

### 工具栏入口（「点图标」那一下）只能人工 ——— 2026-10-20 实测四种手段

| 手段 | 结果 |
|---|---|
| CDP `Input.dispatchMouseEvent` | ❌ 只作用于**页面内容**，点不到浏览器 UI |
| UIA 枚举工具栏按钮 | ✅ 能枚举（`EdgeExtensionsHubButton` / `ToolbarActionView`），但 |
| └ `InvokePattern` | ❌ **不支持**（`Unsupported Pattern`） |
| └ `ExpandCollapsePattern.Expand()` | ❌ 抛空错（`BEFORE=Collapsed` 之后就失败） |
| 鼠标注入 `SetCursorPos` + `SendInput` | ✅ 对工具栏**有效**（点「设置及其他」真弹出菜单，截图 `tmp/edge/uia7-settings.png` 可证） |
| 但 Harbor 图标在不在工具栏 | ❌ `--load-extension` 装的扩展**默认不在**（气泡消失后 `ToolbarActionView` 列表为空） |
| 自动固定图标 | ❌ `edge://extensions` 的 DOM 在 CDP 里读不到（`bodyLen: 0`） |

**所以这一步必须人点、脚本判** → `tools/accept-toolbar-entry.cjs`。
判据是硬的：`chrome.storage.local.harborInvoke` **只有 `chrome.action.onClicked`
被触发才会写**（见 `extension/service-worker.js` 的 `bindAction`），
它一出现就证明「点的确实是扩展图标、走的是 action 入口」。

★ **2026-10-20 真人工点了一次：8/8 全过**（`action.onClicked` 触发 → 侧栏 `innerWidth=382`
→ `hasUrl=true url=https://example.com/` → 侧栏里「读当前页」真读到 917 字符）。
这一条以前**验不到**：产品 manifest 没有 `host_permissions`，只靠 `activeTab`，
而 `activeTab` 只在「用户点扩展图标」那一刻授予 —— 旧脚本用「新开扩展页标签」
冒充侧栏时这条链路根本不触发。跑法见验收脚本表（`--timeout=300`）。

⚠️ **两个必须记住的坑**：

1. **Edge 会在图标位置贴一个权限提示气泡**，UIA 名字是
   「Harbor 希望访问此站点 / 包含边栏体验」，Class **也是** `ToolbarActionView`。
   只判「名字含 Harbor + 是 ToolbarActionView」会把它**误报成图标**。
   必须排除气泡文案（`希望访问|边栏体验|访问此站点`）。
2. **UIA 跨进程枚举会看到用户自己正在用的 Edge**（2026-10-20 探测 8 踩到：
   一次 dump 里冒出了用户那扇窗口的篡改猴 / YouTube 条目）。
   所有 UIA 查询**必须按我们起的 pid 过滤**，绝不跨 pid。

> ⚠️ 旧的 `accept-*` 脚本多数还没改（改它们要逐条复核判据是否仍成立）。
> **`accept-m02a.cjs` 的注释里曾写「点工具栏那条路走不通（原生 UI 无 CDP target）」——
> 那句是「CDP 点不到工具栏」的错误推广（CDP 确实点不到，但 UIA + 鼠标注入能点）。
> 调研报告里没有这条结论。** 已在原处标注更正。

## ★ 硬规则四：隔离 profile 必须每次清空，别复用

`lib/driver.cjs` 的 `launchEdge()` 只 `mkdirSync`、**不复位**目录。复用旧 profile 会
留下**上一次的 extId**，于是 `--load-extension` 装的是新副本（新 id），而
`/json/new` 用新 id 开出的页面**没有扩展接管** → 页里 `chrome.*` 全 `undefined`。

症状长这样（2026-10-20 真机踩到，查了两轮才定位）：

```
sidePanel.open() 没成功：Cannot read properties of undefined (reading 'getLastFocused')
最后一次探测={"sp":"undefined","win":"undefined","rs":"complete"}
```

`rs=complete` 说明页面加载完了，但 `chrome.*` 全没有 —— **不是时序问题，是这一页
没被扩展接管**。修法：`D.removeProfile(path.join(D.PROFILE_ROOT, PROFILE))` 再起。

这也意味着：**用固定 profileName 的验收脚本，跑第二次本来就会坏**（此前一直没人跑第二次）。

## ★ 硬规则：禁止「固定毫秒等待」当就绪判据

**任何脚本里都不准用「等 N 毫秒然后认为它好了」当判据。必须轮询目标状态，带超时上限。**

这条不是洁癖 —— 同一类问题在**两个阶段各栽过一次**，而且都不是靠记性避免的：

| 时间 | 栽在哪 | 症状 | 怎么修 |
|---|---|---|---|
| Phase 1b | `tools/read-extid.cjs` | 首次装扩展要写一堆文件，`sleep(4000)` 不够 → 读不到扩展 ID → 安装脚本**偶发失败**（手动再跑就成） | 改成「每轮换独立 profile 名、最多重试 3 轮」 |
| Phase 1c 第一步 | `tools/accept-sidepanel.cjs` | `waitMs=3000` 时 Edge 还没写盘 `Secure Preferences` → 读不到 ID → 验收**假红** | 改成「轮询读扩展 ID，最多 30 次 × 500ms」 |

**为什么固定等待必错**：Edge 首次加载扩展要写的文件量、磁盘速度、机器负载每次都不同 ——
等得够久会让**每次跑都多花冤枉时间**，等得不够就**偶发假失败**，而假失败最伤：
它会让人开始怀疑「是不是代码又坏了」。

### 正确写法

```js
// ✗ 错：固定等待当判据
await sleep(4000)
const id = readExtIdFromProfile(profile)

// ✓ 对：轮询目标状态 + 超时上限
let id = null
for (let i = 0; i < 30 && !id; i++) {
  await sleep(500)
  id = readExtIdFromProfile(profile)
}
if (!id) throw new Error('读不到扩展 ID（等满 15 秒）')
```

### 适用范围（有些等待**不是**判据，别误伤）

```js
const RECONNECT_MS = 3000   // ✓ 允许：这是「重连节奏」，判据仍是「host 真回了消息」
await sleep(500)            // ✓ 允许：这是**轮询间隔**，判据在轮询的检查里
```

判据永远是「**目标状态真的出现了**」（读到了文件 / 收到了消息 / 端口通了），
而不是「我睡了多久」。超时上限是**必须**的 —— 没有上限的轮询会在真坏掉时挂死。
