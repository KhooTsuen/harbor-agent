# Harbor Edge 扩展 P0 交接（2026-10-20）

交接对象：接手开发的 DeepSeek Agent。仓库：`E:\CodexWorkbench`。本文件记录当前源码与验证状态，不代表已发布版本；请先读仓库根目录 `AGENT.md`，再接续工作。

## 结论与边界

P0 功能已在源码接通，完整 `npm run preflight` 通过；隔离真 Edge 对核心侧边栏、站点策略和页面操作的验收通过。

> **2026-10-20 接手复验（第二个 Agent）**：
> · 文档所列 20 个文件**全部存在**，关键实现逐条核对**与文档一致**（无虚报）；
> · 基线 `npm run preflight` 复跑 **EXIT=0**，内核自检 **5674 项 / 0 失败**、vitest **212 文件全过**
>   —— 与文档所写数字**完全一致**；
> · 真机复验：`accept-m02b` **44/44**、`accept-ownership` **24/24**；
> · **原先缺的那条证据已补上**：`accept-regen-real` 用假上游证明“重新生成真的发出第二次请求、
>   回包回流、旧回答保留可切回”，**9/9 通过**（详见下方“接手后优先完成的验收”第 2 条）。
>
> **仍不能标为最终验收完成的**：真实模型（非假上游）的重新生成回包、产品原始 manifest 下人工点击
> Edge 工具栏/右键/快捷键入口、以及“主窗口开着另一条对话时重新生成不误写”。
> 另记录一条**未修的产品级时序耦合**（单次操作耗时 ≈ 去重窗口），见“已知限制与注意点”。

用户已决定：**站点默认允许，新增临时拒绝与撤销**。不得擅自改为逐站默认拒绝，也不得绕过现有权限、上下文开关及敏感动作确认。此前用户要求先试用，再决定是否发布、推送；本轮未提交、未推送、未发布，未更新稳定版。

当前工作区有大量原有未提交和未跟踪文件（含 P0 之前的改动）。接手时先运行 `git status --short`，**保留现有改动和用户数据**；不要执行 `reset`、`clean`、全目录覆盖或把 `data/` 当临时目录清理。隔离验收脚本使用其既有 `data/unit-test-data` 流程，并会按脚本逻辑恢复注册表快照。

## 本轮 P0 已接通的链路

| 模块 | 当前实现 | 主要位置 |
|---|---|---|
| M02 重新生成 | 真侧边栏按钮 → 扩展 SW → native host → 主进程 `chat:event` → 渲染层 `regenerateMessage`；指定侧边栏会话，保留旧回答版本，带 `edge-sidepanel` 来源。最新一轮尚无回答时拒绝重做，避免截断后来提问。 | `harbor-edge/src/sidepanel/ChatPanel.tsx`、`harbor-edge/src/sidepanel/useChatStream.ts`、`harbor-edge/extension/service-worker.js`、`electron/core/ext-chat.cjs`、`src/hooks/useExtBridge.ts`、`src/stores/thread/regenerate.ts` |
| M02 快捷入口 | 选区右键、`Alt+Shift+H` 快捷键、点击扩展图标后出现的选区浮动按钮；选中文字先进入**所属侧边栏对话草稿**，不自动发送。不申请全站 `host_permissions`，不常驻注入 content script。 | `harbor-edge/extension/manifest.json`、`harbor-edge/extension/lib/quick-entry.js`、`harbor-edge/extension/lib/selection-toolbar.js`、`harbor-edge/src/sidepanel/useSelectionDraft.ts` |
| M03 页面感知 | 当前页按标题、段落、列表、引用、表格、图片 alt 提取；语义标签不足时保留其余可见正文；SPA 短暂稳定等待，采集后复核活动标签和 URL；选区带周边内容。 | `harbor-edge/extension/lib/page-text.js`、`observe.js`、`observe-run.js`、`command-run.js` |
| M07 站点权限 | 主进程同一份 `data/ext-sites.json` 策略：默认允许、临时拒绝（目前 UI 为 1 小时）、到期失效、撤销。扩展采集/操作前查询；策略无法核实时拒绝。旧 v1 策略写入升级前另存备份。 | `electron/core/ext-sites.cjs`、`harbor-edge/extension/lib/site-policy.js`、`harbor-edge/src/sidepanel/SitePolicyPanel.tsx` |
| M06 去重修复 | 同一动作、目标引用和载荷 2 秒内只执行一次。真机发现点击使页面版本变化后，旧指纹会放过第二次点击；已修正。页面版本仍用于引用校验。 | `harbor-edge/extension/lib/dedupe.js`、`electron/core/ext-command.cjs` |

Edge 页面内容与 Harbor 内置浏览器内容有不同来源标记。侧边栏来源的模型回合只能使用 `edge_read` 获取 Edge 当前页；运行时禁止悄悄改用 `browse*` 内置浏览器工具。相关入口在 `electron/core/tools/edge-read.cjs`、`electron/core/tools/index.cjs`、`electron/core/tools/_web-note.cjs`。此前“模型把内置浏览器结果说成 Edge 页”的问题应继续作为回归重点。

## 已有验证证据

在 `E:\CodexWorkbench` 运行的最终 `npm run preflight`：退出码 **0**。日志：`E:\Codex\2026-10-18\e-codexworkbench-e-harbor-dev-e-2\work\edge-p0-final-preflight-6.log`。其中单元测试 **212 文件 / 1904 项通过**，内核自检 **5674 项通过、0 失败**，应用自检 `channelsMissing: []`、`channelsOk: true`。Edge 侧边栏构建 `npx vite build --config harbor-edge/vite.config.ext.ts` 也通过。

隔离真 Edge 脚本：

- `node harbor-edge/tools/accept-m02b.cjs`：**44/44**。真侧边栏显示、上下文开关、页面读取、重新生成请求送达目标会话、选区进入草稿且未自动发送、临时拒绝后读取被阻断、撤销后列表清空。日志：`...\work\edge-p0-accept-m02b-5.log`。
- `node harbor-edge/tools/accept-ownership.cjs`：**23/23**。会话归属、站点拒绝、策略文件异常时拒绝、重复点击只执行一次、不同文字输入可继续执行。日志：`...\work\edge-p0-accept-ownership-2.log`。
- `node harbor-edge/tools/accept-m04f.cjs`：**34/34**。真实 `edge_*` 工具与页面操作链路。日志：`...\work\edge-p0-accept-m04f.log`。
- `node harbor-edge/tools/accept-m02a.cjs`：**22/22**，但脚本仍通过扩展页标签验 Markdown/停止，**不能替代真侧边栏验收**；日志：`...\work\edge-p0-accept-m02a.log`。

以上日志中的 `...\work` 均指 `E:\Codex\2026-10-18\e-codexworkbench-e-harbor-dev-e-2\work`。测试计数仅是本次运行的证据，后续文档不要当作永远固定的项目指标。

## 接手后优先完成的验收

1. 在**开发版和产品原始 manifest** 下，从真实 Edge 网页点击扩展图标打开侧边栏；选中文字分别测试右键、浮动按钮和快捷键。确认草稿进入当前选中对话、保留来源 URL、不自动发送；切到另一对话后不串线。`accept-toolbar-entry.cjs` 可辅助核对图标触发与 `activeTab`，但需要人点击工具栏。
2. ~~连接可控的真实或假上游模型，验证“重新生成”真的发出第二次请求~~ —— **2026-10-20 已补（假上游）**。
   新增 `harbor-edge/tools/accept-regen-real.mjs` + `fake-regen-upstream.mjs`：真 Electron（源码树）
   → 真界面点“重新生成”→ 真 `regenerate.ts` → 真 `chat:send` → 真 `loop.cjs` → 假上游（记录每个请求体）。
   **9/9 通过**，证据：
   · 首轮**对话请求** 1 次（另有 2 次辅助请求：标题/建议，messageCount=2）；
   · 点“重新生成”后**对话请求变成 2 次**（这就是原先缺的那条证据）；
   · 第二次请求带第一轮上下文（messages=3，角色 system/user/system）；
   · 界面回答从“第1次回答”变成“第4次回答”，并显示 **“2 / 2” + “对比”** → 旧回答保留可切回。
   **仍未验证**：真实模型（非假上游）的回包质量，以及“主窗口开另一条对话时不误写”这一条
   （脚本里主窗口只有一条对话）。
3. 真机试一组 SPA 页面、正文大量放在 `div/span` 的页面，以及 URL 在等待期间变化的页面。核对实际交付内容与截断提示；页面变化时必须拒绝旧内容。
4. 对临时拒绝分别验证读取与交互都被挡、到期后自动放行、撤销后立即放行，以及旧 v1 策略迁移备份。隔离测试已覆盖主链，产品环境仍需确认。
5. 若有修复，先跑针对测试，再跑 `npm run preflight` 与相关真 Edge 脚本；完成后更新此文档和路线图的**当前状态**。`edge-extension-roadmap.md` 下方旧表及 §5/§6 保留历史快照，顶部 2026-10-20 注记才是本轮现状，避免按旧“未做”重复实现。

## 已知限制与注意点

- `accept-m02b` 等自动化采用隔离 profile；部分脚本会给**测试副本**添加 localhost `host_permissions` 以便 CDP 驱动，**不能据此宣称原始 manifest 的 `activeTab` 授权路径已验证**。原始 manifest 没有全站 host 权限。
- 真正的“重新生成已成功”应以模型第二次请求和回复落盘为证，主进程的 `{ok:true}` 仅表示已把请求交给渲染层。
- 自动化真机发现过一次去重回归，已修复并复验；后续修改页面版本或引用逻辑时要保留“同一按钮连点只执行一次”的真机判据。
- **★ 2026-10-20 新发现（未修，仅记录）**：**单次页面操作耗时 ≈ 去重窗口**。
  实测 `browser.type` 单次 **1834~1876ms**、`browser.click` **2439~2504ms**，
  而去重窗口是 `DEDUPE_WINDOW_MS = 2000`。耗时构成已定位到根因：
  `ext-actions.cjs` 的 `checkRef()` 在**每个动作前**都调用 `getElements({})`（完整重新观察），
  而 observe 走 `page-text.js` 的 `waitForStablePage()` —— 该函数静置最少 **300ms**、
  页面持续变动时顶到 **1800ms 上限**（已单独实测：静置 311/318/312ms，有变动 1816/1803ms）。
  影响：在慢机器上“同一按钮连点”的判据**时绿时红**（第一版 22/23、第二版 21/23，两次结论相反），
  因为两次操作在时间上根本落不进同一个 2 秒窗。
  **这不是去重代码的缺陷**（纯逻辑判据与窗口内间隔那一支都通过），
  而是“动作前完整重观察”与“2 秒去重窗”两个设计同量级带来的时序耦合。
  若要修，是**产品决策**（可选：加大去重窗口 / 让 checkRef 只做轻量校验 /
  给静态页跳过稳定等待），**本轮未改**——改动会碰到 SPA 稳定性与引用失效保护。
- 因上述时序耦合，`accept-ownership` 的 ⑮/⑮e 已改成“先量单次耗时，前提成立才作判据”，
  现在跑出 **24/24**（比原来的 23 条多一条“事实：单次操作耗时 vs 去重窗口”）。
  前提不成立时会**如实标出**而不是判绿或判红。
- `npm run preflight` 曾有一次 `test:app` 报进程非零退出，但同次 JSON 报告 `channelsOk:true`；单独重跑 `npm run test:app` 通过，随后最终完整 preflight 也以退出码 0 通过。不要把那次偶发当作当前失败，也不要只凭 JSON 忽略未来非零退出。
- 本轮**没有**对 `E:\Harbor` 稳定版或 GitHub 仓库发布/推送；如需让用户在安装版试用，应遵循现有开发版、源码版、打包版隔离流程，先确认实际安装和数据路径，不要覆盖稳定版或用户数据。
