# Harbor 浏览器扩展 · 模块路线图与进度

> **2026-10-20 P0 续修状态**：下方表格与 §5/§6 保留此前的阶段快照；以本段的当前状态为准。M02 的重新生成、选区右键/浮动入口/快捷键已接线；M03 的结构化正文、选区周边上下文、SPA 等待已接线；M07 依用户确认保持默认允许，新增临时拒绝与撤销。
>
> **2026-11-01 状态列校正（第三阶段第 12 项「新旧状态并列」）**：§0 那句「一句话现状」与 §1 表格里
> M02（写「快捷入口未做」）、M03（写「阅读模式正文提取 / 周边上下文 / SPA 稳定未做」）、
> M06（写「部分」）三行与文首及 §5 已经冲突，本轮按**代码事实**重写。判据是**能指到文件与行**，
> 不是印象：`manifest.json` 的 `contextMenus` + `commands.open-panel`、`lib/quick-entry.js`、
> `lib/selection-toolbar.js`；`lib/page-text.js` 的 `collectPageText` / `waitForStablePage`、
> `lib/observe.js:291` 的 `selection.context`。**本轮没有复跑任何真机验收**（那要起真 Edge + 改注册表），
> 所以这几行标的是「已接线」而不是「已完成」；真正的缺口只剩**产品 manifest 下的人工点击**
> （工具栏 / 右键选区 / 快捷键），见 `harbor-edge/tools/accept-toolbar-entry.cjs` 文件头。

> **2026-10-20 第二轮复验（接手后的独立核对，以本段为准）**
>
> · **文档可信度已核实**：交接文档列的 20 个文件全部存在；关键实现逐条比对**与文档一致**
>   （manifest 无全站 `host_permissions`、无常驻 `content_scripts`；去重 2 秒窗 + 载荷白名单；
>   站点默认允许 + 临时拒绝 + 到期 + v1 备份；三个快捷入口 13/13；SPA 正文兜底 + URL 复核）。
> · **基线复用**：`npm run preflight` **EXIT=0**、内核自检 **5674 项 / 0 失败**、vitest **212 文件**、
>   `channelsOk: true` —— 与交接文档所写数字完全一致。
> · **真机复验**：`accept-m02b` **44/44**、`accept-ownership` **24/24**（原为 23 条，见下）。
> · **补齐了交接文档标注的最大缺口**：新增 `accept-regen-real`（假上游记录每个请求体），
>   **9/9 通过** —— 证明“重新生成”真的发出第二次对话请求、带上第一轮上下文、
>   回包回流且界面显示“2 / 2 · 对比”（旧回答保留可切回）。
> · **新记录一条未修的产品级时序耦合**：单次页面操作实测 1834~2504ms，而去重窗口是 2000ms
>   —— 根因是 `checkRef()` 在每个动作前都完整 `getElements()`，而 observe 含
>   `waitForStablePage()`（静置 300ms / 持续变动顶到 1800ms）。详见交接文档“已知限制与注意点”。
>   该项**没有改代码**：属产品决策，改动会碰 SPA 稳定性与引用失效保护。
> · **仍不能标为最终验收完成的**：真实模型（非假上游）回包、产品原始 manifest 下人工点工具栏/右键/快捷键、
>   以及“主窗口开着另一条对话时重新生成不误写”。隔离真 Edge 验收：`accept-m02b` 44/44、`accept-ownership` 23/23、`accept-m04f` 34/34；重新生成真实模型回包和产品工具栏人工点击尚待试用确认，不能写成已验收。

> **这份文件是什么**：`E:\Download\Harbor Agent Browser Extension.md`（开发基线 v1.0）那份
> 规格里 12 个模块**在本仓库的实际进度**。规格是**要什么**，这里是**做到哪了**。
>
> **怎么用**：开新阶段之前先读它，确认「下一步该做哪个模块」；做完一个模块回来改这张表。
> **改它的时机**：每个模块验收通过后，**同一次提交**里改（别攒着 —— 攒了就没人记得）。
>
> ⚠️ 表里的「依据」列指向**可验证的证据**（真机脚本 / 自检组），不是「我觉得做完了」。
> 这是本项目「不输出未验证的已完成」那条硬约束在文档层的落实。

> 🔧 **2026-10-20 校正（重要）**：这份文件此前**三处自相矛盾** —— 第 0 节写「M04 未开工」、
> 表格下方那句写「P0 里只剩 M04 与 M05」，而同一份文件的进度表里 M04/M05 早已标「完成」；
> 并且 M02 的 Markdown / 停止生成被记成「未做」，实际 2026-10-19 就做了，
> 还带了真机验收脚本（`accept-m02a.cjs`）与自检组（`164-m02-panel.mjs`）。
> 本次按**代码 + 验收脚本 + 自检组**逐条核对后重写，核对方法见文末 §8。
>
> 📌 **校正时的证据边界**：下面的「验收通过」结论来自**历史上真实跑过**的记录；
> 本次校正**只读了代码和脚本，没有复跑真机验收**（那要起真 Edge + 临时改注册表，十几分钟）。
> 凡是本轮没复跑的，都显式标了「本轮未复跑」。

---

## 0. 一句话现状

> **2026-11-01 改写**（原文「M01/M04/M05 已完成；M02 完成小批 A，小批 B/C 未做；M03/M06/M07 各差一截；
> M08–M12 未开工」是 2026-10-19 的判断，此后文首与 §5 已两轮更正，这一句却没跟上 —— 新旧并列就是从这里来的。）

**M01 / M04 / M05 / M07 已完成；M02 / M03 的代码已接线（缺人工点击验收）；M06 基础去重已完成、
剩多窗口与批量类；M08–M12 未开工。**

口径说清楚，免得又混：**「已接线」= 代码与入口都在，能指到文件和选择器；「已完成」= 有跑过的真机验收证据。**
M02 的快捷入口（右键 / 浮动按钮 / 快捷键）和 M03 的三项（正文提取 / 周边上下文 / SPA 稳定）属于前者 ——
`accept-toolbar-entry.cjs` 的文件头解释了为什么这几种入口**自动化点不到浏览器 UI**，只能人点。

扩展现在能连、能聊（含 Markdown 渲染与停止生成）、能看（选区 + 周边上下文 / 元素引用 / 正文结构化 /
版本号 / SPA 稳定）、**也能动手**（点击 / 填表 / 滚动 / 等 / 导航 / 标签页），而且这些能力**在对话里调得到**
（`edge_page` / `edge_click` / `edge_type` / … 见 §1 的 M04 行）。

---

## 1. 十二个模块的进度

| 模块 | 名称 | 优先级 | 状态 | 依据（可验证） |
|---|---|---|---|---|
| **M01** | Harbor 连接与设备配对 | P0 | ✅ **完成** | `accept-phase3a` ⑨⑩（`NO_HARBOR` / `TIMEOUT` 人话）· `accept-m03` ⓪ · 自检 154/155 |
| **M02** | AI 侧边栏与会话 | P0 | ✅ **已接线**（2026-11-01 按代码改口径；人工点击仍未验） | **A**：Markdown 渲染（`TurnBubble.tsx` 懒加载主应用那**同一份**）+ 停止生成（真取消）—— `accept-m02a` · 自检 `164`。**B**（2026-10-20）：**任务卡**（相位 / 当前工具 / **等你确认**，事件名与渲染层真名对齐）+ **当前网页卡**（扩展自己读 `chrome.tabs.query`，`canRead` 是唯一判据）+ **上下文开关**（存 `chrome.storage.local`，**真管用**：关掉后两条读取链路在发请求那一层就被挡住，`lib/context-gate.js` 唯一判定）—— 真侧栏 `accept-m02b` 28/28 · 自检 `176`（45 项）。**C**（2026-10-20）：**设置抽屉**（连接信息 / **能力清单从 manifest 现算** / 站点权限**只指路**），原来的假按钮已换成真抽屉 —— 真机 8/8（合计 36/36）· 自检 `177`（22 项）。**快捷入口（2026-11-01 核对已接线，此前记作「未做」）**：`manifest.json` 有 `contextMenus` 权限 + `commands.open-panel`（Alt+Shift+H）、`lib/quick-entry.js` 注册右键「用 Harbor 询问选中内容」、`lib/selection-toolbar.js` 是选后浮动按钮 —— **但产品原始 manifest 下人工点工具栏 / 右键 / 快捷键仍未做**（`accept-toolbar-entry.cjs` 文件头记了四种自动化手段为什么点不到浏览器 UI） |
| **M03** | 网页感知与内容提取 | P0 | ✅ **已接线**（2026-11-01 按代码改口径；部分项未复跑真机） | 选区 / 元素 / iframe / 版本号已完成（`accept-m03` 31/31）。**此前记作「未做」的三项，2026-11-01 核对代码后确认已接线**：① **阅读模式正文提取** —— `lib/page-text.js` 的 `collectPageText` 输出标题层级（`#`~`######` 前缀）· 表格（`| a | b |` 行）· 图片 alt（`[图片说明] …`），并穿透 open shadowRoot 与同源 iframe（depth ≤ 4、节点 ≤ 1500）；② **选区周边上下文** —— `lib/observe.js:291` 取 `closest('p,li,blockquote,section,article,main')` 的**前后兄弟块**拼成 `selection.context`（上限 900 字）；③ **SPA 稳定判断** —— `page-text.js` 的 `waitForStablePage`（MutationObserver 静默 300 ms，硬上限 1800 ms，**到上限返回 `stable:false` 而不假称已稳定**）。→ 依据上一条仍成立：这三项**是代码接线**，不是本轮复跑过的真机验收 |
| **M04** | 受控浏览器操作 | P0 | ✅ **完成** | `accept-m04a` 16/16 · `m04b` **34/34**（click/verify + 状态证据 + 点前校验）· `m04c`（不打开侧边栏也能推指令）· `m04d` **34/34**（type 拒密码/信用卡 · select · scroll · wait · navigate · **敏感确认卡**）· `m04f` 32/32（**从 `tools.execute` 调 `edge_*`** · clear/focus/key）· 自检 **160/161/162/163**。**遗留**：跨页编排（用户定的边界外）· 接管/暂停/安全重试 |
| **M05** | 标签页与窗口管理 | P0 | ✅ **完成** | `accept-m04d` ⑯⑰⑱（list / search / activate）· `m04f`（**create / close**：关闭 id 必须在 list 里 + **回读确认**）。**遗留**：多窗口 · 标签分组 · 批量 · 对指定标签页导航 · 全量 url 需 `tabs` 权限（现在如实标 `urlHidden`） |
| **M06** | 任务同步与执行可视化 | P0 | ✅ **已完成**（2026-10-20 补洞后；2026-11-01 更正状态列） | 会话与任务共用 Harbor 那一套（`session:list` / `chat:send` / 流推送）；侧边栏显示进度。**去重**（2026-10-20 重做）：`lib/dedupe.js` 按「动作 + 目标 + **载荷**」2 秒窗拦重复副作用指令；标签页操作也真被覆盖；记录在**执行后**且只在副作用真发生时记（失败可立刻重试）。回执明说 `duplicate`/`deduped`。依据：自检 `175` · 真机 `accept-ownership` ⑮/⑮b/⑮c/⑮d/⑮e。**仍缺**：跨页面版本的同按钮连点拦不住（版本一变就放行，有意取舍）· 执行**可视化**（相位 / 任务进度卡）属 M02-B，未做 |
| **M07** | 权限、安全与隐私 | P0 | ✅ **完成**（2026-10-21） | 管道 token + 来源校验（`ext-bridge.cjs`）· M03 起敏感字段不读 · `wrapWebText` 防注入 · 敏感动作确认卡。**站点黑名单**（2026-10-20）：主进程 `core/ext-sites.cjs` 存 `data/ext-sites.json`，**默认放行、可拉黑**（用户拍板）；拉黑后读不了也点不动；扩展侧在**采集/操作之前**问。**核实不了策略时一律拒绝**（原 fail-open 已改：`activeTab` 会持续，Harbor 关掉后扩展仍读得到页面 —— 那是后门）。依据：自检 `175` · 真机 `accept-ownership` ⑪⑫⑬/⑬b/⑬c。
**站点级授权**（2026-10-21 补）：规格要的「显式授权某站点可读」现在有了，但落地口径是**浏览器权限层**而不是再用一张自家白名单 —— manifest 加 `optional_host_permissions: ["<all_urls>"]`（安装时不弹窗、默认不生效），两个入口：设置抽屉「整站读取」（`<all_urls>`）· 网页卡「记住本页」（`https://<当前域名>/*`）。判定在 `src/sidepanel/site-access.ts`（`originPatternOf` 是唯一一处 url→match pattern），界面 `SiteAccessPanel.tsx` 与 `PageCard.tsx`。
**两者的关系**：「够得着」（浏览器权限）与「许不许读」（主进程黑名单）**正交**——授权整站之后被拉黑的站点仍然读不了。依据：自检 `177`（16 条新增）+ `156`（可选权限形状）。⚠️ 真机那个授权框**尚未点过**（侧边栏是否算用户手势、重载后权限是否保留，两处待验，见 CHANGELOG） |
| M08 | 网页研究与知识整理 | P1 | ❌ 未开工 | —— |
| M09 | 文件、上传、下载与 PDF | P1 | ❌ 未开工 | —— |
| M10 | 视觉理解与复杂页面辅助 | P1 | ❌ 未开工 | —— |
| M11 | 工作流自动化 | P2 | ❌ 未开工 | —— |
| M12 | 高级浏览器能力与兼容 | P2 | ❌ 未开工 | —— |

**P0 的真实剩余**：M02 的**小批 B / C**、M03 的**阅读模式**、M07 的**临时授权**。
（原先这里写「P0 里只剩 M04 与 M05」，那是 M04/M05 开工前的说法，早已过期。）

### 2026-10-20 补：会话归属 + 站点黑名单 + 去重（第一批）

这一批不是新模块，是**修既有模块的三个洞**：

| 洞 | 修之前 | 修之后 | 依据 |
|---|---|---|---|
| **会话归属** | `ext-ops.cjs` 落盘只认 `getActiveSession()`（**主窗口**当前那条）。侧边栏选着 A、主窗口开着 B 时点「读当前页」，内容落进 **B** | 判定收敛到 `core/ext-route.cjs` 一处：`explicit → selected → active → 新建`；扩展侧 5 处补传 `sessionId` | 自检 `174`（含**真跑 `ingest`** 的行为判据）· 真机 `accept-ownership` ⑨⑩ |
| **站点权限** | 完全没有 | `core/ext-sites.cjs`（默认放行、可拉黑）+ `site:policy` kind + 扩展侧三处前置查询 | 自检 `174` · 真机 ⑪⑫⑬ |
| **重复指令** | 连点两次 = 真提交两次 | `command-run.js` 按 `command+ref+pageVersion` 2 秒窗拦副作用指令 | 自检 `174` · 真机 ⑮⑮b⑮c |

**同时修掉的验收口径问题（这条比上面三条更值得记）：**

用户 2026-10-20 指出：**测试必须先打开一个页面，再在「插件」里点侧栏插件，不是新开一个插件页面**。
在此之前 **14 个 accept 脚本全都在用「新开 `chrome-extension://<id>/index.html` 标签」冒充侧栏**
—— 那不是用户看到的东西，验出来的绿没有意义。而 `accept-m02a` 里那句
「点工具栏那条路走不通（原生 UI 无 CDP target）」是**没试过就写下的断言**。

实测证明完全可行，做法已抽成 `harbor-edge/lib/ext-panel.cjs`（唯一一处）：

- `Runtime.evaluate({userGesture:true})` **骗不过** `sidePanel.open()`（会抛 may only be called in response to a user gesture）
- 但 `Input.dispatchMouseEvent` 派**真实鼠标事件**点注入的按钮 → **成功**
- 真侧栏是独立 `page` target，但 **URL 与触发页完全相同** → 只能靠 marker 区分

✅ 已改真侧栏：`accept-ownership.cjs`（19/19 通过）
❌ 未改（判据涉及流式/停止生成，需逐条复核）：`accept-m02a` 等其余脚本
📌 口径写进 `harbor-edge/README.md` 的**硬规则三**（真侧栏）与**硬规则四**（隔离 profile 每次清空）

---

## 2. M02 的 A 批做了什么（2026-10-19，已完成）

| 项 | 做法 | 证据 |
|---|---|---|
| **Markdown 渲染** | 回复正文从 `whitespace-pre-wrap` 纯文本换成真渲染；解析用主应用 `@/lib/markdown` 的 `parseBlocks`、渲染 `lazy()` 载入主应用 `Markdown`（katex / CodeBlock 不进侧边栏首屏） | `src/sidepanel/TurnBubble.tsx` 文件头（写了为什么必须复用）· 构建产物里 `Markdown-*.js` 分块存在 |
| **停止生成** | 按钮只在流式中出现 → `chat-abort` → host 转发 → 主进程 `ext-chat.handleAbort` → 渲染层 `stopActiveRequest`（**真取消**，不是停显示）；没在跑时**如实回绝** | `src/sidepanel/ChatPanel.tsx` 的 `stop()` · `electron/core/ext-chat.cjs` · 零新增 IPC 通道（走既有 `chat:event`） |

**验收**：`harbor-edge/tools/accept-m02a.cjs`（真 Edge + 真扩展 + 真 host，**正向 + 反向**）·
自检 `scripts/selftest/groups/164-m02-panel.mjs`（读源码钉接线 + require 真跑纯 CJS 判定）。
这两处**本轮未复跑**，所以这里**不写判据条数**（据实：静态数 `rec(` 调用得 22、
`check(` 得 41，但真跑时循环与条件会改变实际条数 —— 以运行输出为准）。
设计说明见 `docs/research/edge-extension-m02-design.md`。

---

## 3. M03 补完的内容（2026-10-16，已完成）

规格 §2 M03 列了 7 条，逐条对齐：

| 规格要求 | 状态 | 说明 |
|---|---|---|
| 页面元数据（URL / 标题 / 语言 / 可见文本） | ✅ | URL / 标题 / `lang` / 正文长度 |
| 阅读模式正文提取（标题层级 / 段落 / 表格 / 图片 alt） | ❌ **未做** | 仍只有 `innerText`（见 §5「M03 剩余」） |
| **交互元素结构**（角色 / 可见性 / 标签 / 表单关联 / 可用状态） | ✅ | ref / role / text / disabled / checked / value / placeholder / href |
| **选区与局部 DOM 提取**（+ 指定元素周围上下文） | ✅ **部分** | 选区文本 + **所在元素引用**已做；「周围上下文」未做 |
| **iframe / Shadow DOM 能力检测 + 明确不可访问报告** | ✅ | 同源 true / 跨域 false + 原因；不捏造内容 |
| 动态 SPA 的 DOM 更新观察 / 页面稳定判断 | ❌ **未做** | 见 §5 |
| 内容的来源 URL / 时间 / 元素引用 | ✅ | 三者都在返回值与渲染文本里 |

★ **设计说明（唯一真相源）**：`docs/research/edge-extension-m03-design.md`。

---

## 4. M04 的范围（**已完成**，保留作范围说明）

> 这一节原来写「进行中，第 1 步已完成」，那是 2026-10-16 开工时的状态，早已做完。
> 保留它不是当进度，而是**当时定下的硬要求** —— 后续改 M04 相关代码时还要守。

规格 §2 M04 + §5.1 权限等级：

- **能力**：定位元素 / 点击 / 输入 / 清空 / 选择 / 滚动 / 聚焦 / 键盘 / 导航 / **等待** / **验证**。
- **工具名**（规格 §4.5）：`browser.getElements` / `browser.click` / `browser.type` /
  `browser.select` / `browser.scroll` / `browser.wait` / `browser.navigate` / `browser.verify`。
  → Harbor 侧的落地名是 **`edge_*`**（`edge_page` / `edge_click` / `edge_type` / `edge_select` /
  `edge_scroll` / `edge_wait` / `edge_key` / `edge_focus` / `edge_tabs`）。
- **★ 三条硬要求**：
  1. **操作成功 ≠ 业务目标完成** —— `click` 返回「点了」不够，**必须附状态证据**
     （URL 变了 / DOM diff / 目标元素出现或消失）。
  2. **元素引用带页面版本号** —— 版本变了引用即失效，**必须重新观察**（避免误点）。
     地基在 M03：ref 形如 `<版本号>.<n>`，登记在 `window.__harborObs.refs`。
  3. **敏感操作逐次确认** —— 提交 / 发送 / 购买 / 删除 / 发布等，执行前**弹确认卡**，
     复用 Harbor 现有的权限门禁（**不另造一套**）。
- **边界（用户定）**：本轮**只做单步操作**，不做跨页编排、不做录制回放。

**改 M04 前必读的两处**：
- `docs/research/edge-extension-m03-design.md` §8.1 —— 尤其是「**注入的函数必须自包含**」
  那条（`executeScript` 会 `toString()` 注入）。
- `electron/core/risk.cjs` + `capability.cjs`（确认卡走它们，不另造）。

---

## 5. 各模块的剩余缺口（按模块归拢）

> ⚠️ **2026-10-21 核对：本节下面列的三项 M03 缺口 + M06 缺口 + M07 缺口，全部已经做完。**
> 保留原文只为追溯当时判断，**不要再照着它重做一遍**。逐条证据：
>
> | 当时写「缺」的 | 现在在哪 | 真的被调用吗 |
> |---|---|---|
> | M03 阅读模式正文提取 | `extension/lib/page-text.js:2` `collectPageText`（h1-6→`#`、li→`-`、blockquote→`>`、表格→`\| … \|`、img→`[图片说明] alt`；结构化段落不足全文一半时追加原文兜底） | `service-worker.js:116`、`command-run.js:185` |
> | M03 元素周边上下文 | `extension/lib/observe.js:237-239`（selection.`context` = 前一个兄弟 + 所在块 + 后一个兄弟，900 字上限） | 随 `collectPageContext` 一起返回 |
> | M03 SPA 稳定判断 | `extension/lib/page-text.js:48` `waitForStablePage`（MutationObserver 静置 300ms / 1800ms 顶到上限后如实返回 `stable:false`） | `observe-run.js:50` |
> | M06 幂等 / 去重 | `extension/lib/dedupe.js`（动作+目标+载荷白名单指纹，2000ms 窗，**执行成功后**才记） | `command-run.js:36` 导入、`:172` 调用 |
> | M07 站点级权限 | `extension/lib/site-policy.js`（fail-closed）+ `electron/core/ext-sites.cjs`（策略与到期在主进程）+ **界面 `src/sidepanel/SitePolicyPanel.tsx`** | 三个执行点：`service-worker.js:105`（读页）/ `command-run.js:172`（操作）/ `observe-run.js:45`（观察）；界面挂 `SettingsDrawer.tsx:119` |
>
> 顺带记一条**上一轮误判的来由**：当时按「站点授权界面」去主应用的
> `src/components/settings/panels/` 里搜，搜不到就写成「缺」。**扩展的设置在
> `harbor-edge/src/sidepanel/`，不在主应用那套里** —— 两套界面不同源。

### M03 剩余（**已全部完成，见上方核对表**）

- ~~**阅读模式正文提取**（标题层级 / 段落 / 表格 / 图片 alt）—— 现在只有 `innerText`。~~
  → 已做：`page-text.js` 的 `collectPageText`。
- ~~**指定元素周边上下文** —— 选区已带所在元素引用，但没有「它前面那段 / 它所在的区块」。~~
  → 已做：`observe.js` 的 `selection.context`。
- ~~**SPA 稳定判断** —— 已核实 `observe.js` 里没有 MutationObserver 一类的稳定等待。~~
  → 已做：`page-text.js` 的 `waitForStablePage`，被 `observe-run.js` 调用。

### M06 剩余（**已完成，见 §5 核对表**）

- ~~**幂等 / 去重** —— 规格验收要求「重复命令不会无意重复提交表单」。当前链路
  （`extension/lib/command-run.js` → `electron/core/ext-ops.cjs` → `ext-chat.cjs`）**没有**任何
  去重键或「同一条指令已执行」的判断。~~
  → 已做：`extension/lib/dedupe.js`。指纹 = 动作 + 目标 + **参与判定的载荷白名单**
  （不用 `Object.keys`，避免把 `settleMs` 这类无关参数算进去）；2000ms 窗；
  **执行之后**才记录、且只在副作用真的发生时才记（第一次失败后允许立刻重试）；
  覆盖 `tabs-create` / `tabs-close`（旧版的洞：它们在判断前就 return，一次都没去重过）。
  ⚠️ 已知时序耦合（未改）：单次页面操作实测 1834~2504ms，而窗口是 2000ms ——
  所以「同一按钮快速点两次」有时拦得住、有时拦不住。属产品决策（窗口调大会拦掉正常重试）。

### M07 剩余（**已完成，见 §5 核对表**）

- ~~**站点级读取 / 交互权限**（含临时授权与撤销）—— 现在只有管道级 token 与来源校验；
  没有「这个站点的内容要不要允许读 / 允许点」这一层。已核实无 `sitePermission` 类实现。~~
  → 已做，且**是三层都在**：
  ① 判定在原进程 → `electron/core/ext-sites.cjs`（黑名单 + 临时拒绝到期），
     理由是「侧栏按钮与 `edge_*` 工具必须同一份判定，各存一份必然漂」；
  ② 扩展侧查询 → `extension/lib/site-policy.js`，**不缓存结论**（否则「刚拉黑」下一次还放行）、
     **核实不了一律拒绝**（fail-closed；旧版是 fail-open，Harbor 关掉之后 `activeTab` 仍持久，
     等于给了个绕过黑名单的后门）；
  ③ 界面 → `harbor-edge/src/sidepanel/SitePolicyPanel.tsx`（临时拒绝 1 小时 / 撤销 /
     已拒站点列表含到期时间），挂在 `SettingsDrawer.tsx` 的「站点权限」小节。

---

## 6. M02 剩余（**已全部完成 —— 本节整节过期，保留仅供追溯**）

> ⚠️ **2026-10-21 核对**：下面表格里标的「未开工 / 假按钮 / 没有 contextMenus」**全部不成立**。
> 实际状态（都已真机验收过，记录在 §7 阶段史）：
>
> | 小批 | 内容 | 实际落点 |
> |---|---|---|
> | **B** 任务卡 | 相位 · 当前工具 · 等待确认 · 停止 | `TaskCard.tsx` + `task-state.ts`（纯函数）；`turn_start`/`plan`/`confirm_request` 已进 `PUSH_TYPES` |
> | **B** 当前网页卡 | 标题 / 域名 / 能不能读 + 上下文开关 | `PageCard.tsx` + `page-info.ts`（「读不到 url = 读不了」这个唯一判据与 M03 同口径；开关存 `chrome.storage`，不进 Harbor） |
> | **C** 设置抽屉 | 连接信息 · 能力清单 · 站点权限 | `SettingsDrawer.tsx` + `settings-info.ts`（能力清单从 `chrome.runtime.getManifest()` 现算，不手写）+ **`SitePolicyPanel.tsx`（真面板，不是指路）** |
> | **C** 快捷入口 | 右键菜单 / 选区工具栏 / 快捷键 | `manifest.json` **已有** `contextMenus` 权限与 `commands`（`Alt+Shift+H`）；`quick-entry.js` + `selection-toolbar.js`。**没有常驻 `content_scripts`** —— 选区按钮是 `scripting.executeScript` **按需注入**，与 M07 最小权限不冲突 |
>
> ★ 上一轮误判的来由：当时只看了这一节没看 §7，而**过期的正是缺口清单、不是完成清单**
> （本文件 §9 结尾那句原话）。查状态请按 §9 的三条命令重跑，别读本节。

设计已写全，在 `docs/research/edge-extension-m02-design.md` —— 这里只列**做什么**，不复制理由。

| 小批 | 内容 | 备注（~~原文判断~~ → 现状） |
|---|---|---|
| **B** | **任务卡**（对话区上方，有任务时出现）：相位 · 当前工具 · 等待确认状态 · 停止按钮（复用 A2 链路） | ~~要把 `phase` 加进 `PUSH_TYPES`，并加推 `confirm_request` / `confirm_resolved`~~ → **已做** |
| **B** | **当前网页卡**：标题 / 域名 / 能不能读（用「读不到 url」当判据，与 M03 同口径）+ 上下文**开关**（存 `chrome.storage`，不进 Harbor） | ~~扩展自己能拿，不必经主进程~~ → **已做**（`PageCard.tsx`） |
| **C** | **设置区**（抽屉形态，与会话抽屉同款）：连接信息 · 能力清单（从 manifest 的 permissions 现算）· 站点权限 | ~~⚠️ 现在是**假按钮**：点了只弹「扩展设置还没做」~~ → **已做**，且站点权限是**真面板**（`SitePolicyPanel.tsx`） |
| **C** | **快捷入口**：右键菜单 / 选区工具栏 / 快捷键 | ~~⚠️ content script 是**新权限面**（注入每个页面）~~ → **已做，且没走常驻注入**：`manifest` 加了 `contextMenus` + `commands`，选区按钮用 `scripting.executeScript` 按需注入，因此**不需要 `content_scripts`** |

**~~已核实的事实~~（2026-10-20 的判断，已被推翻）**：当时写 `permissions` 里没有 `contextMenus`、
没有 `commands` 段 —— **现在两者都在**（见 `harbor-edge/extension/manifest.json`）。
侧边栏现在的可访问文案也比当时多：`当前网页卡` / `任务卡` / `设置抽屉` / `站点权限` /
`临时拒绝 1 小时` / `撤销` / `已拒绝站点` / `能力清单` / `权限列表`。

---

## 7. 阶段史（怎么走到这儿的）

| 阶段 | 内容 | 证据 |
|---|---|---|
| Phase 0 / 1a / 1b / 1c | 探针实验 → 帧协议 → host 形态 → 扩展能加载 | `docs/research/edge-extension-phase0-report.md` 等 |
| **Phase 2** | 读当前页 → 包装 → 落会话 | `accept-phase2` 18/18 |
| **Phase 3a** | 双向通道 + 会话列表（只读） | `accept-phase3a` 16/16 |
| **Phase 3b** | 侧边栏发消息 + 流式回复（两端同一条） | `accept-phase3b` 15/15 |
| 布局返工 ×2 | 三段堆叠 → 顶栏三区 + 左侧会话抽屉 | 几何探针 16/16 |
| **Phase 3c** | 点选会话（只切侧边栏）/ 未选中自动新建 / 顶栏 ＋ | `accept-phase3c` 20/20 |
| **M03** | 选区 / 元素列表 / iframe 能力检测 / 页面版本号 | `accept-m03` **31/31** |
| **M04-1/2** | 元素列表 + 引用失效判定；click + verify（状态证据 / 点前校验） | `accept-m04a` 16/16 · `m04b` 34/34 |
| **M04-3** | 不打开侧边栏也能推指令（主进程主动连） | `accept-m04c` |
| **M04 剩余 + M05** | type / select / scroll / wait / navigate + 确认卡 + tabs 三件 | `accept-m04d` 34/34 |
| **M04/M05 补齐 + 接成工具** | clear / focus / key + tabs create/close；`edge_*` 进 `tools.execute` | `accept-m04f` 32/32 · 自检 160/161/162/163 |
| **M02-A** | Markdown 渲染 + 停止生成（小批 A） | `accept-m02a`（真实判据数见运行输出，**本轮未复跑**）· 自检 `164-m02-panel` |
| **M02-B / C 完成**（2026-10-20） | 任务卡（相位 / 工具 / 等你确认）· 当前网页卡（扩展自己读 + 能不能读的唯一判据）· 上下文开关（**真管用**，关掉两条链路都停）· 设置抽屉（能力清单从 manifest 现算 · 站点权限只指路）· 顺带修 `PUSH_TYPES` 里 `tool_start/tool_end` 的**静默失效** | 真侧栏 `accept-m02b` **36/36** · 自检 `176` + `177`（67 项）· 反向验证 5 条全转红。<br>⚠️ 真机跑的是**放宽 `host_permissions` 的副本**（CDP 点不到工具栏 → 拿不到 `activeTab`），只为排除权限噪声；脚本另有判据复核产品 manifest 没被改 —— 所以「真侧栏里能读」**不等于默认安装下的行为**（那条归 `accept-toolbar-entry`） |
| **M06/M07 补洞 + 验收口径纠正 + 三处安全修正**（2026-10-20） | 会话归属收敛到 `ext-route.cjs`（指定失效即拒绝）· 站点黑名单（**核实不了就拒绝**，原 fail-open 已修）· 指令去重（动作+目标+载荷，标签页也覆盖，失败可重试）· **真侧栏验收**（不再是「新开扩展页」）· 工具栏入口验收 | `accept-ownership` **23/23**（真侧栏）· `accept-toolbar-entry` 8/8（产品 manifest）· 自检 `174`+`175`（**79 项**）· 反向验证 7 条 → 报告见 [`edge-extension-m06-m07-report.md`](edge-extension-m06-m07-report.md) |

> 「Phase N」是**本项目内部的施工编号**；「M0N」是**规格里的模块编号**。
> 两者不是一一对应 —— M03 是「Phase 2 的深化」，M04 是「Phase 3 的执行部分」。

---

## 8. 验收资产索引

### 真机脚本（`harbor-edge/tools/`）

> 脚本数会随轮次增长 —— `dir /b harbor-edge\tools\accept-*.cjs` 现数（本文校正时是 14 个，
> 但**别信这个数，信命令输出**）。
>
> ⚠️ **「判据数」列是历史上真跑的输出，本轮（2026-10-20）未复跑。**
> 不要拿静态数 `rec(` / `check(` 调用去「纠正」这些数字 —— 真跑时循环与条件分支会改变实际条数
> （例：tabs 三个动作共用一个 `rec` 调用、某些判据被前置条件跳过）。**要精确值就跑一遍脚本。**

| 脚本 | 验什么 | 判据数（历史运行输出） |
|---|---|---|
| `accept-sidepanel.cjs` | 构建产物**能当扩展页加载**（Phase 1c 第一步） | —— |
| `accept-extension.cjs` | 真扩展 + native host **端到端**（Phase 1c 第二步） | —— |
| `accept-host.cjs` | Phase 1b 探针链路（native host ping/pong） | —— |
| `accept-phase2.cjs` | 读当前页 → 包装 → 落会话 | 18 |
| `accept-phase3a.cjs` | 双向通道 + 会话列表 | 16 |
| `accept-phase3b.cjs` | 发消息 + 流式 + 落盘 + 两端同一条 | 15 |
| `accept-phase3c.cjs` | 选会话 / 自动新建 / ＋ | 20 |
| `accept-m03.cjs` | 网页感知（含密码遮蔽 / 版本号稳定与变化） | 31 |
| `accept-m04a.cjs` | 元素列表 + 引用失效判定 | 16 |
| `accept-m04b.cjs` | 点击 + 验证（状态证据 / 旧引用被拒 / 导航型点击） | 34 |
| `accept-m04c.cjs` | 不打开侧边栏也能推指令 | 7 |
| `accept-m04d.cjs` | type 拒密码/信用卡 · select · scroll · wait · navigate · 确认卡 · tabs 三件 | 34 |
| `accept-m04f.cjs` | 从 `tools.execute()` 调 `edge_*` · clear/focus/key · tabs 新建/关闭 | 32 |
| `accept-m02a.cjs` | **Markdown 真渲染 + 停止生成（正向 + 反向）** | 未记录（本轮未跑） |

（`read-extid.cjs` 由 `install-host.cmd` 调，不算验收脚本。）

### 自检组（纯 Node，`npm test`）

`154` native-host · `155` install · `156` ext-bridge · `157` ext-protocol · `158` ext-chat ·
`159` observe（M03）· `160` ext-command · `161` act · `162` m04-rest · `163` edge-tools ·
**`164` m02-panel（M02-A）**。

> ⚠️ **真机脚本必须串行跑**（并行会互相踩 `com.harbor.agent` 注册表 —— 踩过一次；
> 而且前一个的残留会抢前台，后一个就报「读不到当前页地址」）。
> 详见 `harbor-edge/README.md` 的「验收脚本」一节。

---

## 9. 怎么核对这份文件（下次改之前照这个来）

不要凭记忆、也不要凭本文件自己写的状态。三条命令就够：

```cmd
rem ① 表格里「已完成」的，脚本是否真存在、判据数对不对
dir /b harbor-edge\tools\accept-*.cjs

rem ② 自检组是否注册（漏注册 = 判据根本没跑）
findstr /n "ext-chat observe ext-command act m04-rest edge-tools m02-panel" scripts\selftest\groups.mjs

rem ③ 某个「未做」的说法是否已过期（最容易过期的一类）
findstr /s /n /i "contextMenus commands readability sitePermission" harbor-edge\extension harbor-edge\src
```

③ 之所以专门列出来：这次校正发现的错，**一半是「未做」已经变成「做了」**（M02 的
Markdown / 停止生成），另一半是「进行中」已经变成「做完了」（M04）。**过期的是缺口清单，不是完成清单。**
