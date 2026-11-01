# Edge 扩展 · 会话归属 + 站点黑名单 + 指令去重（交付报告）

> 日期：2026-10-20 · 状态：**代码与自检已完成，未提交、未推送**
> 对应进度表：`docs/research/edge-extension-roadmap.md` 的「2026-10-20 补」那一批
> 上一份报告：`edge-extension-m04c-m05-report.md`（M04/M05 补齐）
> 本批设计参照：`edge-extension-m02-design.md`（M02 分 A/B/C 三小批）

---

## 0. 一页看清现在到哪了

| 模块 | 状态 | 本批有没有动 |
|---|---|---|
| M01 连接与配对 | ✅ 完成 | — |
| M02 侧边栏会话说 | ⚠️ **小批 A 完成，B/C 未做** | — |
| M03 网页感知 | ⚠️ 缺阅读模式 / 周边上下文 / SPA 稳定判断 | — |
| M04 受控操作 | ✅ 完成 | — |
| M05 标签页 | ✅ 完成 | — |
| M06 任务同步 | ✅ **本批补齐幂等/去重** | ✅ 动 |
| M07 权限安全 | ⚠️ **本批补了站点黑名单**；临时授权与撤销仍未做 | ✅ 动 |
| M08–M12 | ❌ 未开工 | — |

**本批真正交付的四件东西**（前面三件是功能，第四件是验收口径）：

1. **修串线**：侧边栏「读当前页 / 观察页面」的结果，现在恒等于**侧边栏自己选中的那条**会话。
2. **站点黑名单**：默认全部放行，用户可把某站点拉黑；拉黑后读不了、也点不动。
3. **指令去重**：同一条指令 + 同一元素 + 同一页面版本，2 秒内只执行一次。
4. **纠正验收口径**：真机验收必须**先开页面 → 再从侧栏入口打开真侧栏**，不能用「新开扩展页标签」冒充。

---

## 1. 改了什么

### 1.1 新增文件（9 个，全部 ≤300 行）

| 文件 | 行 | 作用 |
|---|---|---|
| `electron/core/ext-route.cjs` | 58 | **会话归属判定的唯一一处**：`explicit → selected → active → 新建` |
| `electron/core/ext-sites.cjs` | 173 | 站点黑名单：host 归一化 + 父域匹配 + 落 `data/ext-sites.json` |
| `harbor-edge/extension/lib/site-policy.js` | 56 | 扩展侧查策略（**不缓存**、查不到 fail-open） |
| `harbor-edge/lib/ext-panel.cjs` | 269 | **开真侧栏并认出它**（唯一一处） |
| `harbor-edge/lib/ext-panel-trigger.cjs` | 69 | 触发页收尾（关掉它、回读确认不在了） |
| `harbor-edge/lib/ext-stage-perms.cjs` | 77 | 测试副本加 `host_permissions`（**只改副本**，并复核产品 manifest 未被动） |
| `harbor-edge/tools/accept-ownership.cjs` | 300 | 本批真机验收（**真侧栏**） |
| `harbor-edge/tools/accept-toolbar-entry.cjs` | 300 | 工具栏入口验收（人点、脚本判） |
| `scripts/selftest/groups/174-edge-ownership.mjs` | 266 | 自检判据（5 个子组） |

### 1.2 修改文件（17 个）

| 文件 | 改了什么 |
|---|---|
| `electron/core/ext-ops.cjs` | `ingest()` 改用 `ext-route` 判定；三条上行链路接受 `explicitSessionId`；注册 `site:policy` |
| `electron/core/ext-kinds.cjs` | 新增 `SITE_POLICY: 'site:policy'` |
| `electron/core/ext-host-loop.cjs` | 转发 `sessionId`（`observe-page` 以前会把它丢掉）+ 新增 `site-policy` |
| `electron/core/ext-bridge.cjs` | 装配时注入 `getSelectedSession`（侧边栏选中的那条） |
| `electron/core/ext-command.cjs` | `click` 把点之前那版 `pageVersion` 一起下发（否则扩展只能拿 url 冒充版本） |
| `harbor-edge/extension/service-worker.js` | `readActivePage` 带 `sessionId`；采集前先问站点策略 |
| `harbor-edge/extension/lib/observe-run.js` | 同上（`observeSessionPage` 收 `sessionId`） |
| `harbor-edge/extension/lib/command-run.js` | 站点前置校验 + 去重窗口（只拦副作用指令） |
| `harbor-edge/extension/lib/messages.js` | `read-page` / `observe-page` 把整条消息传下去 |
| `harbor-edge/src/sidepanel/ChatPanel.tsx` | 「读当前页」「观察页面」两个按钮传 `sessionId` |
| `harbor-edge/src/sidepanel/ReadPageButton.tsx` / `ObserveButton.tsx` | 接收并下发 `sessionId` |
| `harbor-edge/tools/accept-m02a.cjs` | 更正一句**没试过就写下**的结论（见 §4） |
| `scripts/selftest/groups.mjs` | 注册 `174` |
| `docs/research/edge-extension-roadmap.md` | 进度表 + 本批说明 |
| `harbor-edge/README.md` | 硬规则三（真侧栏）/ 硬规则四（profile 每次清空） |
| `CHANGELOG.md` | 本批 + 工具栏入口两笔 |

---

## 2. 为什么这么改（三条设计决策）

**① 归属判定必须只有一处，否则必然再漂。**
以前 `ext-ops.cjs` 的 `ingest()` 只认 `getActiveSession()`（主窗口当前打开的那条），而侧边栏的选中项住在 `ext-chat.cjs` 的 `selectedSessionId` —— 两套归属各写各的，注释里甚至写着「**是两回事**」。用户在主窗口开 B、侧边栏选 A 时点「读当前页」，内容就落进了 B。修法不是「在 `ingest` 里补一个 if」：那样以后多一条上行链路就会漏一次。所以抽成 `ext-route.cjs`，只暴露一个 `decideSessionId()`，三条链路全部过它。

**② 站点策略放主进程，是因为它和 `risk.cjs` / `net-policy.cjs` 是同一族。**
放扩展侧最省事，但那样「工具侧判断」和「扩展侧判断」会变成两套口径 —— 而 `edge_*` 工具和侧栏按钮操作的是**同一个浏览器**。代价是每次读/操作多一次 IPC 往返，实测 3~8ms，可接受。

**③ 默认放行（黑名单语义）是用户当场拍板的。**
白名单更安全，但「第一次装好、还没配任何站点」时会把用户挡在所有页面之外，零摩擦优先。代价要如实写：规格里那条「未授权站点不能读取」在本批实际验的是「**拉黑后**不能读取」，不是「默认全部禁止」。这条差别见 §5。

**④ 去重按 `command + ref + pageVersion`，而不是按 url。**
url 相同的 SPA 页面内容可以完全不同；`pageVersion` 是 M03 那套版本号（元素集合 + 结构指纹），才代表「同一份页面」。已知边界：**同一个提交按钮在不同页面版本上连点两次仍会执行两次** —— 用户明确接受了这个边界。

---

## 3. 怎么验证的

### 3.1 自检（纯 Node，不需要 Edge）

```
npm test  →  通过 5523 项，失败 0 项
```

`174-edge-ownership` 本组实际跑出 **52 项**，分 5 个子组：

```
── Edge 归属 · 侧边栏选中优先于主窗口（串线的根因）──
── Edge 站点策略 · 归一化与父域匹配（判定只有一处）──
── Edge 站点策略 · 扩展侧真的在采集/操作之前问过 ──
── Edge 去重 · 同指令 + 同元素 + 同页面版本 2 秒内只执行一次 ──
── Edge 真机验收 · 必须走真侧栏，不许新开扩展页冒充 ──
```

其中最关键的一条是**行为判据**（不是读源码钉接线）：真跑 `createOps()`，喂 `selected='sess_a'` / `active='sess_b'`，断言内容 append 到 **A**。反向验证时把它改坏，判定输出 `实际落进 sess_b` —— 正是用户报的那个现象。

> 判据数为什么以运行输出为准：同一批文件静态数 `check(` 是 52，但 `accept-ownership.cjs` 静态 `rec(` 有 21 处、实跑只有 19 项，`accept-toolbar-entry.cjs` 静态 9 处、实跑 8 项 —— 循环与条件会让两者不同。**静态数不能当验收结果用。**

### 3.2 真机验收 A：`accept-ownership.cjs`（真侧栏）

```
────────────────────────────────────────────────
通过 19 项，失败 0 项
────────────────────────────────────────────────
⑦ ★★★ 真侧栏已打开（不是新开扩展页）      innerWidth=382
⑦b 触发页已不在（侧栏仍在，不占标签位）      关掉 1 · 剩 0
⑨ ★★★ 侧边栏选 A、主窗口开 B → 落 A（不是 B）  A: 0→1 · B: 0→0
⑩ ★★ 反向：侧边栏切到 B → 落 B（不是写死 A）   B: 0→1 · A: 1→1
⑬ ★★★ 被拉黑的站点：不允许（前置于采集）      会话 A 计数未增长
⑮ ★★★ 同一引用连点两次 → 页面只计一次         点击次数 0→1
⑮c ★★ 第二次回执明确是重复                    reason=duplicate · deduped=true
```

**诚实标注**：这是**上一轮**的真机运行结果（连跑两次都是 19/19）。**本轮没有复跑** —— 它要起真 Edge、临时写 `com.harbor.agent` 注册表，几分钟。

### 3.3 真机验收 B：`accept-toolbar-entry.cjs`（工具栏入口，本轮真跑）

```
通过 8 项，失败 0 项
① 点了 Harbor 的扩展图标（action.onClicked 被触发）   at=2026-10-20T10:39:34Z
③ ★ activeTab 已授予（点图标才会给）                 hasUrl=true url=https://example.com/
⑤ ★ 侧栏真的出现了（窄面板 + Harbor 自己的输入框）    innerWidth=382
⑦ ★★ activeTab 链路通了：拿到 url 且读到正文          chars=917
⑧ 读到的正文不是空的（executeScript 真注入成功）      chars=917
```

这一项用的是**产品 manifest**（没加 `host_permissions`），所以 ⑦⑧ 过了就说明**真实用户的权限链路是通的** —— 这是以前用「新开扩展页」冒充侧栏时**永远验不到**的。

### 3.4 全量回归

```
npm run preflight  →  exit 0
内核自检 5523 项 / 0 失败 · 渲染层 212 文件 1903 项
行数 1340 文件全 ≤300 · channelsOk=true · security 83 项 100%
```

### 3.5 反向验证（判据是不是空转）

| 改坏什么 | 结果 |
|---|---|
| 归属退回「只认主窗口」 | 转红 2 项（接线判据 + **行为判据** `实际落进 sess_b`） |
| 观察页面不再问站点策略 | 转红 1 项 |
| 去重窗口改成 0 | 转红 1 项 |
| 主进程不下发 `pageVersion` | 转红 1 项 |
| 用「新开扩展页」冒充真侧栏 | 转红 2 项 |

---

## 4. 这一批最值钱的部分：踩到的坑

> 代码会过时，这几条不会。都已写进 `harbor-edge/README.md`。

### 4.1 「新开扩展页冒充侧栏」——验收口径是错的

用户当场指出：**测试必须先打开一个页面，再在「插件」里点侧栏插件，不是新开一个插件页面。**

在此之前 **14 个 accept 脚本全都在用「新开 `chrome-extension://<id>/index.html` 标签」冒充侧栏**：

| | 真侧栏 | 新开扩展页标签 |
|---|---|---|
| 位置 | 浏览器右侧面板（实测 `innerWidth=382`） | 占一个标签位、整页 |
| 在 `chrome.tabs` 里 | **不在** | 在 |
| 用户怎么打开 | 点工具栏图标 | 根本打不开 |

**等于验的是一个用户永远打不开的页面。**

### 4.2 一句没试过就写下的断言

`accept-m02a.cjs` 里写着「点工具栏图标那条路走不通（原生 UI 无 CDP target，见调研报告）」。
**调研报告里没有这条结论**，也没人试过 —— 那是把**局部事实**（CDP 点不到浏览器 UI）错误推广成了整体结论。实测完整结果：

| 手段 | 结果 |
|---|---|
| CDP `Input.dispatchMouseEvent` | ❌ 只作用于页面内容 |
| UIA 枚举工具栏按钮 | ✅ 能枚举 |
| └ `InvokePattern` | ❌ `Unsupported Pattern` |
| └ `ExpandCollapsePattern.Expand()` | ❌ 抛空错 |
| 鼠标注入 `SetCursorPos`+`SendInput` | ✅ 对工具栏**有效** |
| Harbor 图标在不在工具栏 | ❌ `--load-extension` 装的**默认不在** |
| 自动固定图标 | ❌ `edge://extensions` 的 DOM 在 CDP 里读不到（`bodyLen: 0`） |

结论：**只能人点、脚本判** → `accept-toolbar-entry.cjs`。判据用 `chrome.storage.local.harborInvoke`，它**只有 `action.onClicked` 被触发才会写**，冒充不了。

### 4.3 复用隔离 profile → 扩展页里 `chrome.*` 全 undefined

`launchEdge()` 只 `mkdirSync`、**不复位**目录。复用旧 profile 会留下上一次的 extId，于是 `--load-extension` 装的是新副本（新 id），而 `/json/new` 用新 id 开出的页面**没有扩展接管** → 症状是 `sidePanel.open()` 报「找不到 getLastFocused」。

顺带暴露：**这些验收脚本跑第二次本来就会坏**，只是此前没人跑第二次。现在固定为「每次跑前清空 profile」。

### 4.4 权限提示气泡会被误判成扩展图标

Edge 在图标位置贴的气泡，UIA 名字是「Harbor 希望访问此站点 / 包含边栏体验」，Class **也是** `ToolbarActionView`。只判「名字含 Harbor + 是 ToolbarActionView」会把它误报成图标，于是提示「工具栏上已有图标，直接点它」——**点它没反应**。

### 4.5 UIA 跨进程枚举会看到用户自己正在用的 Edge

一次 dump 里冒出了用户那扇窗口的篡改猴 / YouTube 条目。**所有 UIA 查询必须按我们自己起的 pid 过滤** —— 跨进程误点的后果比这条功能本身更严重。

### 4.6 我自己写错过的三条判据（已改）

| 假判据 | 为什么是假的 |
|---|---|
| 「selected 置空 → 退回主窗口那条」 | `handleSelect` 对空 id 明确拒绝（`NO_SESSION`），根本没有「取消选中」这个动作 → 永远不可能通过 |
| 「关掉 ≥1 个触发页」 | 浏览器有时自己就收掉了触发页，`closed=0` 时假红 → 改看 `remaining` |
| `/json\/new\?[^`]*index\.html/` | 一遇模板字符串里的反引号就断掉 → 反向验证时**不变红**，改成跨行匹配 |

---

## 5. 已知遗留（逐条，不美化）

1. **站点策略是黑名单语义（默认放行）。** 所以规格里「未授权站点不能读取」在本批实际验的是「**拉黑后**不能读取」。白名单模式与「新站点询问」都未做。
2. **临时授权与撤销未做。** M07 只补了「拉黑」，没有「临时给某站点开 N 分钟」。
3. **其余 13 个 accept 脚本仍用「新开扩展页」冒充侧栏。** 只有 `accept-ownership.cjs` 与 `accept-toolbar-entry.cjs` 走真路径。改它们要逐条复核判据（都涉及流式 / 停止生成 / 元素引用）是否在改路径后仍成立。
4. **`accept-ownership.cjs` 的 19/19 是本轮之前跑的，本轮未复跑。**
5. **真机验收在加 `host_permissions` 的副本上跑了一部分。** 因为 CDP 拿不到 `activeTab`。脚本里有判据复核产品 manifest 未被改动，但**这类验收 ≠ 产品默认权限下的行为**。唯一用产品 manifest 跑通的是 `accept-toolbar-entry.cjs`。
6. **去重拦不住「同一提交按钮在不同页面版本上连点两次」。** 用户接受的边界。
7. **站点列表目前只能改文件。** `data/ext-sites.json` 没有界面，要等 M02-C 的设置抽屉。
8. **工具栏入口无法进 CI。** 它必然要人点一次。

---

## 6. 下一步

按 `edge-extension-m02-design.md`，M02 还剩两小批：

**小批 B：当前网页卡 + 上下文开关 + 真实任务卡**
- 任务卡：相位（要把 `phase` 加进 `PUSH_TYPES`）+ 当前工具（`tool_start`/`tool_end` 已在推、但 ChatPanel 没接）+ 等待确认（要加推 `confirm_request`/`confirm_resolved`）
- 当前网页卡：扩展自己读 `chrome.tabs.query`，显示标题 / 域名 / **能不能读**；一个 checkbox 决定「读当前页 / 观察页面」是否默认带上，状态存 `chrome.storage`
- 这批**不需要新增 IPC 通道**（设计文档 §0 已论证）

**小批 C：设置抽屉 + 快捷入口**
- 设置抽屉（现在那个齿轮是**假按钮**，点了只弹「扩展设置还没做」）—— 站点黑名单的界面也落在这里
- 右键菜单 / 快捷键要先评估权限影响（manifest 现在**没有** `contextMenus`、**没有** `commands`）
- 选区工具栏需要注入页面，权限影响更大，建议最后做

---

## 7. 是否违反约束（逐条）

| 约束 | 结果 |
|---|---|
| 类型零容忍 | ✓ typecheck / lint 0 错误；内核类型检查与基线一致（期间修过 `ext-route.cjs` 的 TS2322） |
| 单文件 ≤300 行 | ✓ 1340 文件全通过（新增 9 个全部 ≤300；`ext-ops` / `ext-command` 贴线时压缩的是注释，没动逻辑） |
| 数据只落 `data/` | ✓ 站点策略落 `data/ext-sites.json`；测试只在 `data/unit-test-data` |
| 密钥不外泄 | ✓ 未触碰凭据；站点策略文件不含任何密钥 |
| 改数据结构要迁移 | ✓ 无既有结构变更；`ext-sites.json` 是**新文件**，缺失即「全放行」 |
| 不引入新依赖 | ✓ |
| 改了代码必须写 CHANGELOG | ✓ 两笔已写（本批 + 工具栏入口） |
| 不输出未验证的「已完成」 | ✓ 未复跑的、加权限副本的、只有人点才验的，都逐条标注了 |
| 动内核关键文件先确认 | ✓ 动手前问过三个问题（站点存哪 / 默认策略 / 去重粒度） |
| 不按映像名杀进程 | ✓ 只按 pid 杀自己起的 Edge |
