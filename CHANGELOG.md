# 更新日志

> 更早的版本（1.28.1 及以前）已归档到 [docs/CHANGELOG-归档.md](docs/CHANGELOG-归档.md)。
> 这里只留 `[未发布]` 和当前发布周期；打包脚本（`scripts/release-upload.mjs`）两份都会翻。

## [未发布]

- **安全回归：84 项全量落地（第 1 批）**（2026-10-11）。按《Harbor Agent 自动化安全测试清单》
  v1.0 把余下各域逐条实现。本批：
  · `security:ipc` 补齐 SEC-009（外链/导航：非 http(s) 一律拦）、SEC-011（窗口销毁后 IPC
    来源 fail-closed）、SEC-012（不可信内容不能变成可交互授权元素，jsdom 真渲染）。
    ★ **SEC-011 是实修**：`electron/register-handlers.cjs` 的 `trustedSender()` 由「拿不到
    窗口就放行」改成**拒绝** —— 旧行为会让窗口销毁后任意来源继续调主进程。函数提出来可测，
    `registerHandlers` 注入它。
  · `security:agent` 补齐 SEC-013~024 共 12 项（注入边界包装 / 文档当数据 / 伪造批准
    fail-closed / 子代理只读封顶 / 取消竞态 / 预算与转圈 / mock 端点外发计数为 0 /
    权限文件畸形不生效 / 计划 vs 实际动作重判 / 超时按拒）。除 SEC-016/017 外均为本轮新增。
  运行 `npm run security`，见 `security-report.md`。

- **安全回归基线：84 项元数据表 + 9 个套件 + JSON 报告**（2026-10-11）。按《Harbor Agent
  自动化安全测试清单》v1.0 落地：`scripts/security/`（`cases.mjs` 84 项元数据 /`harness.mjs`
  五态断言 /`sandbox.mjs` 隔离运行 /`run.mjs` 入口 + `security-results.json` 报告 + 9 个
  `suites/*.mjs`）。复用现有测试设施（selftest 的隔离思路、vitest 的 jsdom），不引依赖。
  首批 20 项里能在隔离环境真跑的已落地：渲染层 XSS（SEC-001~004，`securityHtml.test.tsx`，
  jsdom + 真渲染器）、WebPreferences / preload 暴露面 / IPC 入口参数 / CSP（SEC-005/006/008/010）、
  授权 scope / TOCTOU（SEC-016/017）、路径穿越 / 符号链接 / Shell 注入（SEC-025/027/029）、
  SSRF（SEC-040）、项目级记忆隔离（SEC-057）、哨兵密钥（SEC-067）。运行 `npm run security`。
  覆盖映射见 `docs/security-coverage-map.md`（含 3 个 P0 发现：HTML 直通默认开启、
  无 IPC sender 校验、allow 档放行云元数据地址）。

- **安全报告补齐文档 §11/§12 的产物与口径**（2026-10-11）。上一版只产出了
  `security-results.json`，且覆盖率只印了一个粗数。这轮按《清单》补齐：① 新增
  `scripts/security/report.mjs`，同时写 `security-results.json`（**加 `timestamp` /
  `coverage`**；case 加 `durationMs` / `command` / `repro`）与**人工审查版
  `security-report.md`**；② 覆盖率按第 12 节**三口径分开算**（实现率 / 执行率 / 通过率，
  通过率分母 = PASS+FAIL **不含 NOT_RUN**），**漏洞数（FAIL 数）单列**，不与通过率合成
  「安全评分」；③ 新增九个独立脚本名 `security:static`…`security:release`（文档第 9 节）；
  ④ 新增**严格门禁档** `npm run security:gate`（P0 有 FAIL/BLOCKED/**NOT_RUN** 就非零，
  即第 12 节口径）——`verify` 挂的仍是**默认档**（只挡 FAIL），因为严格档当前**不通过**
  （首批 20 项仍有 5 项 NOT_RUN、其余 P0 未实现）。报告与门禁**如实标注**这一点，未拿
  NOT_RUN 充 PASS。对账表见 `docs/security-coverage-map.md` 第四节。

- **安全：首轮跑出的 3 个 P0 已修 + `npm run security` 接入 verify 链**（2026-10-11）。
  ① SEC-002：`RawHtml.tsx` 的 HTML 直通由**默认开改默认关**（保留 `harbor.rawHtml=1` 开关）——
  默认聊天展示不再执行不可信脚本；② SEC-007：`register-handlers.cjs` 加 IPC sender 来源校验
  （只接受主窗口，非受信来源拒绝 + 留痕）；③ SEC-040：`net-policy.cjs` 把 `169.254.0.0/16`
  （云元数据/链路本地）列为**不受档位影响**的硬拒绝（不碰 localhost / 私网）。`npm run security`
  现全绿，已在 `verify` 链尾追加 `&& npm run security`（有 P0 FAIL 会一并挡 CI / pre-push / preflight）。

- **下载的开始 / 完成 / 失败改成全局提示**（2026-10-11）。病根：下载事件的订阅长在
  `DownloadsPanel` 里，而那个面板是**按标签条件渲染**的（`RightPanel.tsx`：
  `activeRightTab === 'downloads'`）—— 用户在内置**浏览器**里点一个下载链接时，右栏
  多半没停在「下载」标签 → 面板根本没挂载 → 事件推到渲染层**没人接** → 「点了下载
  什么反应都没有」，失败了也不知道。改法：把订阅搬到常驻的
  `src/hooks/useDownloadNotifications.ts`（在 `useBackendSubscriptions` 里挂一次），
  它同时干两件事 —— ① 把事件喂给 `useDownloadsStore`（面板没开数据也保持最新）；
  ② 对「开始 / 完成 / 失败」三种跃迁各弹一条 toast（带「查看」→ 切到下载标签）。
  `progress` 不弹（每 200ms 一条，弹它等于刷屏）；`paused` / `queued` / `removed` /
  `cleared` 多是用户自己点的，也不弹。`DownloadsPanel` 相应去掉自己的订阅、只管渲染。
  单元测试见 `npm run test:unit` 输出。

- **浏览器下载接进内置下载器**（2026-10-11）。以前网页里点「下载」走的是 Chromium
  自己的下载（没有队列 / 速度 / 续传，界面上也看不见）。病根：内置浏览器是独立分区的
  `<webview>`（分区 `persist:agent-browser`），它的 `session` 上**没人挂 `will-download`**。
  改法：
  ① 新增 `electron/core/download-intake.cjs` —— 在那个分区的 session 上挂 `will-download`：
  公开文件（http/https）`preventDefault` 后转成 `origin='browser'` 的内置任务（分段 /
  续传 / 进队列面板）；`blob:` / 需登录（cookie）的**放行**给 Chromium 自己的下载
  （它带着网页 cookie，拦了会「点了没反应」）。同名文件自动让位（`a.zip → a(1).zip`）。
  ② `handlers/browser.cjs` 在已有的 `whenReady` 里挂上它。
  ③ 新增配置项 `downloads.browserDir`（设置 → 对话 → 下载；空 = 当前会话工作目录）。
  ④ 台账 `items` 加 `origin` 字段（`'user'` / `'browser'`），旧记录读出来兜底 `'user'`
  （只补默认、不动旧数据）；下载面板给浏览器来的任务标一个「网页」角标。
  验证：`npm test`（内核自检，含 browser.cjs 接线）+ `npm run test:unit`（新增 intake
  纯函数 / will-download 假 session / 台账 origin 断言，条数看输出，不在此写死）。

- **下载管理器：并行分段 / 断点续传 / 失败重试 + 任务队列 / 限速 / 进度面板**（2026-10-11）。
  参照开源下载管理器（Ketch）的**功能思路**重写，不是搬代码（用户口径：只参照功能）。
  病根：`download.cjs` 一直是**单连接、全下内存、200MB 上限、无续传**，几 GB 的文件
  根本下不了；而且「任务队列 / 限速 / 进度」在界面上完全看不见。
  改法：
  ① 新增 `electron/core/download-engine.cjs`：探 `Range` → 支持就切段并行下；
  进度记 `<目标>.part.json`，断了从断点接着下；单段失败退避重试（从已收位置继续）。
  不支持 Range 的服务器**回退单连接**（硬切段会写出错位数据）。落盘写 `.part` 再
  `rename`，不占内存。
  ② 新增 `electron/core/download-store.cjs`（台账 `data/downloads.json`，带 version）
  与 `electron/core/download-queue.cjs`（并发上限 + 令牌桶全局限速 + 状态机）。
  ③ 新增 `handlers/downloads.cjs` 与 `downloads:*` 通道（清单同步进 `ipc-channels.cjs`
  与 `preload.cjs`，含 `downloads:event` 进度推送；**通道数看那两份文件，不在这里写死**）。
  ④ 工具 `download.cjs` 改用引擎：上限 **200MB → 2GB**，支持续传与并行分段。
  ⑤ 界面：右栏新增「下载」标签（`DownloadsPanel.tsx` + `useDownloadsStore.ts` +
  `downloadsApi.ts`），可加任务、暂停/继续/重试/删除、改并发与限速、看进度/速度。
  验证：`npm test` 自检组 119 新增断言（台账回落时机、限速夹取、分段连续性、切段阈值、
  渲染层兜底限速与内核默认值同值、preload/register/右栏接线）——断言条数以 `npm test`
  输出为准，不在此写死；另跑三种真机场景（本地 HTTP 服务造「支持 Range / 不支持 Range /
  慢速中断续传」）：sha 全部一致、`.part` 无残留、续传从断点（1.28MB 处暂停）接上。
- **修：下载「保存到」的路径语义 + 盘根 EPERM**（2026-10-11）。病根：面板只有一个
  「保存到」框，用户按浏览器直觉填文件夹（`E:\Download`），内核却当它是**完整文件
  路径** → 去建父目录 `E:\` → Windows 上 `mkdirSync('E:\')` 抛 `EPERM`（真机踩到：
  右栏「下载」加第一条任务就失败）。改法：① 引擎加 `ensureDir` —— **已存在就跳过**，
  盘根不再触发 mkdir（同形状的旧写法在 `tools/download.cjs` 也有，一并收敛）；
  ② 面板拆成「文件名 + 保存文件夹」两个框：填地址时自动从 URL 末段带出文件名（可改），
  文件夹留空 = 工作目录。推断/拼接收敛成 `fileNameFromUrl` / `joinTarget` 两个纯函数
  （单元测试见 `npm run test:unit` 输出）。自检补断言：盘根 ensureDir 不抛、面板有两个框。
- **加固：下载台账丢弃「没有可用 `file`」的旧记录**（2026-10-11）。病根：`download-store.cjs`
  的 `load()` 只按「有没有 `id`」收条目，于是早期草稿形状的记录（用 `path` 而非 `file`，
  如 `{id, path, status:"error"}`）会被收进来 → 在界面上变成**一行没名字的幽灵任务**
  （点它还会因 `file` 为 `undefined` 报一条失败）。改法：`load()` 只收「`id` + `file`
  都可用」的条目，其余**直接丢弃**并记一条 warn（条数写进日志，不写死在文档里）。
  自检补断言：造一份混着旧记录的台账，`list()` 只留带 `file` 那条。

## [1.30.0-beta.16] — 2026-10-11

- **上下文预算改为跟随模型窗口**（2026-10-11）。病根：内核的上下文基准一直是死值
  `context.baseTokens`（默认 16384），**与模型真实窗口脱钩** —— 把模型换成 1M 窗口的
  DeepSeek V4，发出去的对话层还是 `16384×3×30% = 14745 字符`，窗口等于白给。
  同时渲染层的压缩提示线早就按 `min(窗口×80%, 用户上限)` 算，两套口径各算各的。
  改法：
  ① 新增 `electron/core/context-window.cjs`：内核侧唯一的基准算法
  `min(模型窗口×80%, 用户上限)`，与渲染层 `compact.ts` 的 `resolveLimit` 同口径；
  `config.context.baseTokens` 语义改为 **0=跟随窗口（默认）/ 非0=用户钉死的上限（刹车）**。
  ② `loop-prompt.cjs` 改用它算基准；`loop.cjs` 把「这轮实际用的模型/供应商」传下去。
  ③ `config-defaults.cjs` 默认 `baseTokens: 0`；`config-normalize.cjs` 夹取区间
  `2000–128000` → `0–1000000`（原来是 128K 时代的产物）。
  ④ `provider-presets.cjs`：DeepSeek V4 声明更新为官方口径 **1M / 384K**（旧值 128K/8K），
  并按官方把 **V4-Pro（不支持读图）** 与 **Flash（支持读图）** 拆成两条规则。
  ⑤ **旧默认值迁移**：`config.cjs` 的 `save()` 会把默认值一起落盘，老用户盘上几乎都存着
  `baseTokens: 16384` —— 不迁移的话它会被当成「用户上限」，跟随窗口对老用户**永远不生效**。
  故 `config-normalize.cjs` 把旧死值 `16384` 视同「没设过」→ 0（实测本机 `data/config.json`
  由 16384 → 0 → v4-pro 基准 800000）。
  验证：`npm test` 自检组 `91-switch-wiring` 新增 6 条断言（算法 + 声明 + 接线）；
  渲染层 `contextBaseSplit.test.ts` 随语义更新；端到端实测（贴 90 万字符）对话层
  从 **14745 字符 → 720000 字符（≈48.8×）**。

## [1.30.0-beta.15] — 2026-10-10

- **修：弹窗里的提示（tooltip）被弹窗盖住 / 从面板右侧透出来**（2026-10-10）。
  真机 bug：设置弹窗里预设卡片的「+」按钮，悬停提示看不见（还会从面板右侧露出去）。
  病根是**层叠上下文**：`useTooltip` 把提示 `portal` 到 `document.body`，只带 `z-dropdown`(40)，
  而 `Modal` 的外层容器是 `z-modal`(70) —— 两者同为 body 的直接子节点，40 < 70，
  提示整块被弹窗压在下面；`shift()` 把它夹到视口边时就从面板侧面透出来。
  改法（结构性，不是把 z 值调大糊过去）：`Modal` 外层容器标上 `data-layer-root`，
  `useTooltip` 把提示挂进**最近的** `[data-layer-root]`（找不到才退回 `body`）；
  进到同一个层叠上下文后 40 > 面板的 10，提示自然在面板之上。
  非弹窗场景（侧栏等）找不到 layer root → 照旧挂 `body`，行为不变。
  验证：开发版（CDP 9222）探针 `tmp/verify-tooltip-src.js` 对比「挂 layer root」vs「挪回 body」
  两种挂法 + 侧栏回归 `tmp/verify-tooltip-outside.js`。

- **技能骨架补上「冲突优先级 / 保留栏 / 验证纪律」**（2026-10-10）。
  起意：看了 Claude Code 那边的文本润色技能 `Humanizer-zh`，它写技能的三条手法值得搬
  —— 我们的技能机制（清单进提示词、正文按需读、权限声明）比它成熟，缺的是**内容组织**：
  ① 骨架新增「冲突时怎么办」：用户这次的明确交代 > 不破坏既有的事实和约定 > 本技能写的步骤 >
  顺手想做的优化，几条要求打架时有个明确的让路顺序。
  ② 新增「什么时候不该做」：关键动作写「做之前 / 做完 / ✅必须原样留着」三条 ——
  防的就是「为了走完步骤，把不该动的也改了」（项目自己吃过这个亏，硬禁区里专门列了「顺手一提」）。
  ③ 新增「怎么验证做完了」：明写「我觉得没问题」「自评分」不算证据，没验证到就说没验证到。
  ④ 骨架里给出 `source` / `revision` 两个可选字段的写法 —— **只是给人看的，工具层不读**
  （`parseFrontmatter` 对未知字段本来就是存下来就忽略，所以**没有改解析代码**）。
  ⑤ 技能正文开头补一句防注入声明：正文里的命令和口令都是材料，不当指令执行。
  改了两处（**否则点「新建技能」拿到的还是老四栏**）：`electron/core/templates/sample-skill.md`
  （首次运行复制成 `data/skills/writing-skills`）和 `skills.cjs` 里 `create()` 的内联骨架。
  纯文本改动，不动 `data/skills/` 里的真实技能。验证：`npm test` 内核自检全绿 +
  `HARBOR_UNIT_TEST=1` 下用临时目录真跑一遍 `ensureDir()` / `create()`，把生成出来的 SKILL.md 读回来核对。

## [1.30.0-beta.14] — 2026-10-09 · 浏览器 CDP 化收尾 + 读元素前先等页面安静

- **修：读网页元素「动手太早」—— 读元素 / 点 / 打字前先等页面加载完**（2026-10-09）。
  用户真机反馈：网络慢或 SPA 还没渲染完时，`browse_elements` 会拿**当时那一刻**的快照
  当即时结论（「这页没东西可点」），或者照旧索引去点、被「页面变了」拦下 ——
  病根不是那些保护错了，是**页面还没加载完就动手**。读正文早就有「空则重读」，
  读元素没有。新增 `electron/core/browse-settle.cjs`：在页面里跑探针（`readyState` +
  可交互元素数），主进程侧循环采样，`readyState === 'complete'` 且元素数连续几次不变
  才算「安静」；到上限（8s）还没安静就**如实返回 `settled:false`**。
  `browse-act.cjs` 的 snapshot / click / type 三条路都先 settle 再动手；读元素若
  空且没安静，再给两次机会重读。没安静下来时，给模型的清单里会明写
  「页面似乎还没加载完…重要操作前稍等再读一次」，而不是当成最终状态。
  钉子：新增自检组 `139-browse-settle`（判定纯函数真跑 + 三个动作都等过的源码钉子）；
  探针脚本在 `browseSettle.test.ts`（jsdom）里真跑。

- **修：浏览器面板一打开就报错（`getWebContentsId` 炸面板）**（2026-10-09）。
  B5 在 `useBrowseDriver` 加的「把当前标签 webContentsId 推给主进程」那段 effect
  里，一跑就**立即**调一次 `view.getWebContentsId()`，而此时 webview 刚进 DOM、
  guest 还没发 `dom-ready` → 该方法**抛**「must be attached to the DOM and the
  dom-ready event emitted」，且未裹 try/catch，异常从 effect 冒出去被错误边界接住，
  **整个浏览器面板变成「这一块出错了」**。修法：把这次调用裹进 try/catch，拿不到就
  跳过、等 `dom-ready` 事件再推（复用已就绪标签的路径照旧立刻推）—— 与
  `webviewNav.ts` 早就写明的规矩一致（每条 webview 方法调用都要裹 try/catch）。

- **浏览器操作不再每次往返渲染层：`browser:result` 换成 `browser:active`**（2026-10-09，
  浏览器 CDP 化收尾 B5）。B1–B4 之后，页面的读正文 / 读元素 / 点 / 打字 / 换历史
  已经在主进程经 CDP 做，但**每次动作仍要渲染层回一次话**（`browser:result`）才算完。
  B5 把那次往返也去掉：渲染层在标签就绪 / 切换时把当前 webview 的 `webContentsId`
  推给主进程（新通道 `browser:active`，取代 `browser:result`），主进程缓存下来
  （`handlers/browser.cjs` 的 `activeTabs`），之后的操作**直接经 CDP 做**，不再等界面。
  `browser:request` 仍保留 —— 「开标签」只有渲染层做得了（`<webview>` 是它的 DOM 元素），
  所以 `navigate` 走一趟往返（渲染层开好标签、等就绪、推 `browser:active` → 主进程读正文）；
  其余动作只借 `browser:request` **点亮界面**（角标 / 选中 agent 标签），主进程不等它。
  动作实现从 handler 拆到 `core/browse-act.cjs`（handler 收在 300 行内）。
  `preload` 的 `browserResult` → `browserActive`；通道清单与 `log-actions` 的高频 SKIP
  同步换名。自检钉子随迁（`88-browser-wait` 加 B5 组、`121-browse-nav` 改盯主进程）。
  真实 IPC 端到端（真 `<webview>` + 真 preload 走 `browser:active` 播种缓存 → snapshot /
  type / click / nav 全直连）9/9 通过。

- **浏览器「后退 / 前进」改由主进程经 CDP 做**（2026-10-09，浏览器 CDP 化 B4）。
  承接 B2/B3：`browse_nav` 原来由渲染层做 —— 调 webview 的 `goBack()`、再在页面里
  `history.back()` 兜底，同时监听 webview 导航事件核实「真的动了没有」
  （`src/.../browser/navStep.ts`）。现在渲染层只负责「webview 就绪 + 报 webContentsId」，
  换历史由主进程经 `core/cdp.cjs` 的 `Page.getNavigationHistory` +
  `Page.navigateToHistoryEntry` 完成（新增 `core/browse-history.cjs`），
  兜底仍是页面自己的 `history.back()/forward()`，核实改成轮询地址。
  正路的判据从「webview 自报的 `canGoBack()`」换成 **CDP 那份历史（DevTools 看到的
  同一份）**，比自报可靠 —— 2026-10-06 真机 bug 就是被 `canGoBack()` 撒谎坑的
  （页面明明有上一页，它回 false，于是把一条能成的路说成「到头了」）。
  渲染层的 `navStep.ts` 删除；`browseWait.ts` 里只服务于它的 `waitForNavMove` /
  `runScript` / `ScriptOutcome` 一并删掉（脚本重试已随 B2/B3 搬到主进程）。
  自检钉子同步：`121-browse-nav` 改盯主进程接线，新增自检组 `138-browse-history`
  （纯函数 `targetEntryId` / `navBlockedText` + 源码守卫）。
  真机证据：真 `<webview>` 里造两页历史，经 CDP 后退 / 前进精准回到目标页。

- **页面操作（读元素 / 点 / 输入）改由主进程经 CDP 做**（2026-10-09，浏览器 CDP 化 B3）。
  承接 B2：`browse_elements` / `browse_click` / `browse_type` 的三个脚本
  （`SNAPSHOT_SCRIPT` / `clickPointScript` / `focusScript`，原来在渲染层
  `scripts.ts`+`scriptParts.ts`）搬到主进程 `electron/core/browse-ops.cjs`，经
  `core/cdp.cjs` 的 `Runtime.evaluate` 执行（含就绪重试）。渲染层 `useBrowseDriver`
  对 snapshot/click/type 只回 `{ready:true, webContentsId}`，不再跑脚本；
  `handlers/browser.cjs` 的 `browser:result` 在 `ready` 分支里**按动作分发**
  （store 把 action/args 记进 pending）。渲染层的 `scripts.ts` / `scriptParts.ts` 删除。
  脚本的行为覆盖（jsdom 真跑：密码不外泄 / 遮挡拒绝 / 跨页校验）跟着搬到
  `scripts.test.ts`——它现在 import 主进程模块；另加自检组 `137-browse-ops`。

- **读网页正文改由主进程经 CDP 读**（2026-10-09，浏览器 CDP 化 B2）。原来「读正文」是
  渲染层用 `webview.executeJavaScript` 跑脚本、再把 text/html/title/url 回给主进程；
  现在渲染层只负责**导航 + 等就绪**，回 `{ ready: true, webContentsId }`，正文由主进程经
  `core/cdp.cjs` 的 `Runtime.evaluate` 读（新增 `core/browse-read.cjs`，含 SPA 空正文重试）。
  读正文脚本 `READ_SCRIPT` 随之**只剩主进程一处**（渲染层同名导出已删）。`handlers/browser.cjs`
  的 `browser:result` 加 `ready` 分支（排在 click / type / snapshot / wcid 之前）。
  另给主进程的读补了一条**独立超时** `READ_TIMEOUT_MS`（15s）—— 读搬到主进程后不再受
  「等界面」那条 45 秒计时器约束，页面 JS 卡死时 `Runtime.evaluate` 会永不返回，
  必须自己兜住。
  自检钉子同步：`88-browser-wait` 改盯 `ready`；新增自检组 `136-browse-read`
  （空重试逻辑从 vitest 搬到内核自检）。

- **CDP 调用收进一处（浏览器 CDP 化的地基）**（2026-10-09）。主进程用
  `webContents.debugger` 直连 webview 的 webContents（取无障碍树 / 跑脚本 / 派输入）
  这件事，原来散在各处自己 `attach` + `sendCommand`（`browse-ax.cjs`、`selftest-report.cjs`）。
  新增 `electron/core/cdp.cjs` 收敛成 `attach` / `send` / `evaluate` / `getFullAxTree`，
  并把「页面抛错只留第一行、别把堆栈灌给模型」抽成纯函数 `valueOfEvaluate`（可纯 Node 自检）。
  `browse-ax.cjs` 改走它。新增自检组 `135-cdp`。

- **IPC 通道清单不再是「漂了没人知道」**（2026-10-09）。自检挨个点名的
  `electron/ipc-channels.cjs` 那份手写通道清单，实测**真漂了**：源码里注册了 152 个通道，
  清单漏登记 `log:action` / `log:error` 两个（`handlers/log.cjs` 里走 `ipcMain.on` 注册的
  真通道），还重复写了 `projectRules:reload` / `projectRules:status` 各两次。漏登记一个 =
  那个通道从没被自检点名 —— 而这张网正是防「某个 handler 注册时抛错、它后面的静默不注册」的。
  两处修：① `selftest-report.cjs` 的 `hasHandler` 原来只在私有 `_invokeHandlers` 里找
  （只认 `handle`），`.on` 注册的通道**永远查不到** —— 改成 `_invokeHandlers` 和
  `listenerCount` 两个都认；② 清单补齐去重，并新增自检组 `134-ipc-channels`：**扫源码跟
  清单比对**（handle / on 都扫），漏登记或幽灵条目都报红，从此漂不了。
  验证：`npm test` 4015 通过 / 0 失败；`npm run test:app` → channelsExpected=152 /
  channelsMissing=[] / channelsOk=true。

- **浏览器动作改用真事件（isTrusted）**（2026-10-09）。学 dsh-browser 的 `input.ts`：
  点击/打字/回车不再用页面里的 `target.click()` / `dispatchEvent(new KeyboardEvent(...))`
  （合成事件，`isTrusted: false`，查可信度的站点会忽略），改成 Electron 原生注入 ——
  点击 `webContents.sendInputEvent`（mouseDown/Up）、文字 `webContents.insertText`、
  回车 `sendInputEvent`。分工：渲染层仍负责校验 + 算落点/聚焦（A/B 不变），真事件由
  **主进程**派发（新增 `electron/core/real-input.cjs`）。渲染层脚本 `clickScript`/`typeScript`
  相应改为 `clickPointScript`（只回坐标）/`focusScript`（只聚焦+校验）。真机证据：页面收到的
  click / input / keydown 事件 `isTrusted === true`（新增测试页记录）。

- **新增 `browse_ax`：读页面的无障碍树**（2026-10-09）。学 dsh-browser 的 `aria.ts` ——
  读的是页面**自己声明**的语义（CDP `Accessibility.getFullAXTree`），而不是从 CSS 标签猜
  「哪些元素能点」，菜单/表单/表格这类结构上更准（真机输出：`textbox "只读框" [readonly]`）。
  只读、不改页面；要点击/输入仍用 `browse_elements` 拿索引。实现：新增 `electron/core/ax-tree.cjs`
  （纯转换，可单测）+ `core/tools/browse-ax.cjs`；渲染层新增 `wcid` 动作回传 webContents id
  （无障碍树只有主进程取得到，得先知道是哪个 webview）；registry 注册 + 人话表同步。

- **旧索引不再点错元素**（2026-10-09）。学 dsh-browser 的「ref 属于页面、不属于快照」：
  `browse_elements` 时把这次遍历到的**元素对象**记在页面 window 上，`browse_click`/
  `browse_type` 派发前核对「第 N 个还是不是那些元素」—— 页面变了（元素被换掉、或整个文档
  换了）就拒绝，让模型重新 `browse_elements`，而不是拿旧索引静默点到别的元素还回报「已点击」。
  判据是对象身份（同一元素文字变了也不误报）。新增 `scriptParts.ts`（拆出共用脚本片段，
  给 `scripts.ts` 腾出 300 行红线）；单测 +4。

- **浏览器点击/输入不再「假成功」**（2026-10-09）。学 dsh-browser 的两个动作前置校验：
  ① `browse_type` 派发前先问页面收不收文本 —— 禁用框（disabled）、只读框（readonly）、
  焦点没落上，**一个字符都不打**，直接报原因（以前往只读框里塞值：原生 setter 照设、
  `input`/`change` 照发，工具回「已输入」而框里一直是空的）；② `browse_click` 派发前
  核对落点 —— 目标中心被别的元素挡住（`elementFromPoint` 钻 shadow DOM）**默认拒绝**并
  点名接收者，新增 `force:true` 才强点、回报里带 `obstructed`；落点在视口外一律拒绝
  （`force` 也不放行）。涉及 `src/components/layout/browser/scripts.ts`（+ `force` 透传：
  `src/types/browser.ts` · `src/stores/useBrowserStore.ts` · `browser/useBrowseBridge.ts` ·
  `useBrowseDriver.ts`）、`electron/core/tools/browse-click.cjs`、`electron/handlers/browser.cjs`；
  单测 +6（真在 jsdom 里跑脚本）。

- **修右栏「审查」面板的 diff 底色两处显示 bug**（2026-10-08）。用户报「删除和新增的
  两个区块、两个界面的颜色显示都有 bug」。真机上量出来是两个独立原因，都在
  `components/chat/DiffViewer.tsx`：

  1. **长行一横向滚动，整行底色就被甩在左边、右侧露白。** 每行的行宽被钉死在**滚动区
     可视宽度**上（单栏 341px / 双栏每格 171px），而横向滚动条的实际内容宽是 943px ——
     滚到最右时色块右边缘停在 973，离滚动区右缘 1575 差了整整 602px。内层内容再从
     flex 行里溢出去，色块自然包不住。改法：单栏把行容器（hunk 的行列表）改成
     `w-max min-w-full`、每行改成 `w-full` —— 于是同一 hunk 里所有行统一到**最宽那行**
     的宽度（短行也跟着铺满），长行再靠容器的 `w-max` 撑开横向滚动；内容那一段去掉
     `min-w-0 flex-1`，不再从 flex 行里溢出。双栏用 `grid w-max min-w-full grid-cols-2`，
     两列等宽、每个格子都等于列宽。
  2. **双栏里「这一侧没有对应行」的空位格子完全没有底色。** 原来写的是
     `var(--bg-raised/20)` —— 自定义属性名里**不能有 `/`**，那不是合法的 CSS 变量引用，
     浏览器整条声明直接丢弃（连 `transparent` 都没写上）。真机读回来是
     `rgba(0, 0, 0, 0)`，内联 style 里根本没有 background 这一条。改用走 Tailwind 那套
     通道值 `rgb(var(--bg-raised-rgb) / 0.2)`（`--bg-raised-rgb` 各主题都有，
     `#21262d` 那套 Primer 也在）。

  验证：`tmp/diff-view-probe.mjs`（临时探针，往 store 里塞一段涵盖「配对 / 纯删 / 纯增 /
  上下文」的 diff，在 vite 预览里读**真实** `getBoundingClientRect` 与
  `getComputedStyle().backgroundColor`）。**单栏**：修前行宽钉在 341、滚到最右时 7 行
  露白（只有长行那一行盖住）；修后 8 行全部 943 宽、`right=1575` 与滚动区右缘重合、
  `uncovered=0`；删除行 `rgba(248,81,73,0.15)`、新增行 `rgba(63,185,80,0.15)`。
  **双栏**：每格统一 903、左右合起来盖满；空位格子修前 `rgba(0,0,0,0)` / 修后
  `rgba(33,38,45,0.2)`（Primer 暗色主题通道值 × 0.2）生效。
## [1.30.0-beta.13] — 2026-10-08 · 重发（内容更新，版本号不变）
- **计划卡不再被空任务顶掉**（2026-10-08）。用户报「计划卡又不显示了」：内核每收到
  一句新话就新建一条任务（`task-resume.cjs`，只有「继续/接着做」才复用旧的），新建的
  是空任务 —— 而 `PlanBar.tsx` 按 `updatedAt` 取「本会话最新任务」，于是用户一开口，
  最新那条变成空任务，卡立刻消失（真机台账可验：一句闲聊就多一条 `plan=0` 的任务）。
  改成取「本会话最近一条**有计划**的任务」，空任务不再顶掉它。渲染层 1 个文件 +
  单测 3 条（空任务不顶掉 / 都有计划仍取新的 / 只有空任务则不显示）。

- **附件支持各类文件格式：PDF / Word / Excel / PPT / 压缩包 / 二进制**（2026-10-08）。
  用户要求「文件上传不止文本类」。主进程新增 `core/file-extract.cjs`（按扩展名分流：
  文本 / 图片 / 文档 / 压缩包 / 二进制）+ `core/file-extract-docs.cjs`（PDF 走 pdfjs-dist、
  Word 走 mammoth、Excel 走 SheetJS、PPT 自解 zip 抽 `<a:t>`；四个库一律**懒加载** ——
  装不上只影响那一类，不会连累 handler 注册）、`handlers/file-attach.cjs`（新通道
  `file:attach`，可多选、串行解析、单次最多 5 个），已同步 `ipc-channels.cjs` 与 `preload.cjs`。
  **二进制不假装能读** —— 只登记「文件名 + 大小 + 类型」；压缩包只列条目名（zip 能列，
  rar/7z 只能登记大小，照实说）；抽出的正文超过 10 万字符标 `truncated`，绝不静默截断。
  渲染层：`stores/thread/attachments.ts`（附件槽 + `attachBlock` 把正文拼进消息）、
  `components/chat/composer/FileAttachments.tsx`（附件卡片）、`useComposerAttachments.ts`
  的 `attachFile` → `attachFiles`。**附件正文直接进用户消息的 `content`** —— 模型这一轮
  读的就是会话历史，拼进去就一定读得到；太长时 `core/long-paste.cjs` 会在主进程自动落盘、
  只发开头 + 路径（那条路本来就在）。**新增依赖**：`pdfjs-dist`、`mammoth`、`adm-zip`、
  `xlsx`（运行时，均纯 JS、无原生 ABI）—— 打包脚本 `build-portable.mjs` 因此改了：
  主进程第三方包改为**按 `npm ls --omit=dev --all` 自动整份拷**（以前只硬拷 node-pty，
  下次加依赖必漏）。

- **图片全屏查看器完善**（2026-10-08）。原来放大后只能看中心那一块、也不能拖。
  渲染层：`ImageLightbox.tsx` 加「适应窗口 / 原始大小 1:1 / 旋转 90° / 另存为 /
  在文件夹里显示 / 复制到剪贴板」，键盘加 `R` 旋转；新文件 `ImageStage.tsx` 管
  「拖动平移 + 滚轮以鼠标位置为中心缩放」（拆出来是因为外壳加完按钮贴到 300 行）；
  `useImageLightbox.ts` 的视图状态扩成 `scale/tx/ty/rotation/actualSize`，
  缩放范围由 `MIN_SCALE`/`MAX_SCALE` 一处导出（渲染层不再各写一套）。
  主进程：新文件 `core/image-load.cjs`（把 `file:` / `data:` / `http(s):` 三种来源
  读成 Buffer，只读用户点名的那一张、不列磁盘）、`handlers/image-file.cjs`
  （三条新通道 `image:saveAs` / `image:reveal` / `image:copy`），已同步
  `ipc-channels.cjs` 与 `preload.cjs`；`preload.cjs` 撞了 300 行红线（该文件按
  sandbox 规矩不能拆）压掉两处注释腾空间。不复用 `fs:reveal` 是因为它把路径锁进
  工作目录，而生成的图完全可能在工作目录外面（生图可存到用户自选目录）。

- **对话渲染补全：原始 HTML 直通 / 数学公式（KaTeX）/ Mermaid 图表**（2026-10-08）。
  用户要求「没做的渲染功能都补上，连 HTML 直通也做了」，并在知情风险（可执行脚本）后选择全量直通。
  解析层（`src/lib/markdown/`）：`types.ts` 新增 `math` / `html` 两类节点（行内 + 块级）；
  `inline.ts` 加「配对标签优先、单标签兜底」的 HTML 规则（标签白名单 `HTML_TAGS`，避免误吞
  `useState<string>` 这类泛型）与 `$…$` 行内公式规则（两侧不留空白，`$100 和 $200` 不受影响）；
  新文件 `blocks-special.ts` 管块级 `$$…$$` 与 HTML 块（`blocks.ts` 已 254 行，不能再塞）；
  `incremental.ts` 把「光杆 `$$`」按围栏处理 —— 否则含空行的公式块会在空行处被切错
  （新增对拍用例钉住）；`pending.ts` 让光杆 `$$` 降级成残缺行；`index.ts` 的 `hasMarkdown`
  认 `<` 与 `$`。渲染层（`src/components/chat/markdown/`）：新文件 `MathNode.tsx`（KaTeX，
  `throwOnError:false`，解析失败退化成等宽原文）、`RawHtml.tsx`（**直通**，开关
  `localStorage['harbor.rawHtml']='0'` 可关）、`MermaidBlock.tsx`（动态 import mermaid，
  `securityLevel:'strict'`，出错退化成代码块）；`Inline.tsx` / `Blocks.tsx` 接线，
  ```` ```mermaid ```` 走 MermaidBlock 而非代码高亮。
  **新增依赖**：`katex`、`mermaid`（运行时）+ `@types/katex`（dev）—— 均为纯 JS，无原生依赖。
  验证：`npm run typecheck` 0 错；新增 `__tests__/extensions.test.ts` 27 条（含「泛型不误吞」
  「金额不当公式」两组反例 + 6 个样本的增量对拍），markdown 目录 66 条全绿；`npm run lint`
  0 错。**安全说明**：HTML 直通后，模型输出 / 它读到的网页与仓库内容都可能带脚本
  （`onerror=`、`<iframe>` 会真的执行；`<script>` 经 innerHTML 插入不执行），这是用户明确
  要求打开的口子，不是疏漏。

- **设置页给「已过期」记忆一条自己的文案**（2026-10-08）。上一批把过期从「物理删」改成
  「标 `expired`」之后，界面还在沿用 disabled 的暗色 + 「启用」—— 用户看不出这条是**自己到期**的，
  还是自己关掉的。现在：徽章「已过期」（走 `colorOf('cancelled')` 的中性灰，不跟「已停用」的
  黄色警告混），按钮与轻提示改成「恢复」（`enable()` 走 `update({status:'active'})` 会把
  `expiresAt` 一并清掉，措辞得对得上）。`src/types/safety-types.ts` 的 `MemoryItem['status']`
  同步补 `'expired'`（不然 `status === 'expired'` 会被 TS 判「两边无交集」）。
  动了 2 个文件；`MemoryTab.tsx` 压掉一段文件头注释保住 ≤300 行。

- **记忆系统修三个 P0：冲突误取代 / 类型失效 / 过期即删**（2026-10-08，来自对照
  `docs/Memory设计.md` 的代码盘点）。三处都在 `electron/core/memory*`：

  ① **`findConflicts` 的 `||` 优先级 bug（会静默丢记忆）**。`memory-similarity.cjs` 里写成
  `(active && 同类型 && 同 scope && similarity>=0.7) || containment>=0.85` —— `&&` 比 `||` 紧，
  右半边**逃出了**前面三个约束：一条「包含度 ≥ 0.85」的新记忆会把**不同类型、不同 scope、
  甚至已退场**的旧记忆标成 superseded（不再注入）。注释与文件头一直写着「同类型 + 同 scope」，
  写得对、代码是错的。修法：加括号把 containment 收回约束内。
  ② **`remember` 工具一律写死成 `fact/global`**，于是「类型体系 + 冲突检测」在**唯一的模型写入
  路径**上全失效（`fact` 不在冲突名单里，类型权重也最低）。修法：工具暴露可选 `type`
  （候选取自 `memory.TYPES`，不在工具里再抄一份），`memory.append` 透传、由 `store.add`
  按同一张词汇表校验。
  ③ **过期 = 物理删除**，违反 §56 `Forget ≠ Delete`：`pruneExpired` 以前 `filter` 直接丢掉，
  用户再也看不到「以前记过什么、什么时候失效的」。修法：标记成 `status:'expired'`（新增状态），
  注入行为不变（`retrieve` 只取 active），可追溯、点「启用」可恢复（并清 `expiresAt`，
  否则下次检索立刻又标回 expired）。

  验证：内核自检 **3992 → 4010 项**（新增 `133-memory-conflict-expire` 18 条，含「跨类型 /
  跨范围 / 已退场不许互相取代」的回归钉）；`npm run verify` 全绿；行数红线 1041 文件全 ≤ 300。
  遗留：① 原先提的「让 `fact` 也参与冲突判定」**没做** —— 有硬反例：2-gram 相似度分不清
  「项目 A 的第 0 条」和「第 1 条」（数字被当噪声丢掉），放进去会让 30 条独立事实互相取代，
  现成的自检 `02-skills-memory` 当场红；② `remember` 只暴露 `type`、**没暴露 `scope`** ——
  工具 ctx 没有 projectId，记 `project` 范围会变成「永远注入不了」的隐形记忆；③ 设置页对
  `expired` 状态没有专门文案（沿用 disabled 的暗色 + 「启用」按钮），因为目前没有写入
  `expiresAt` 的路径，实际见不到。


- **`context-builder.cjs` 的预算表删掉 3 个「死键」+ 加一条自检盯着「表里每一项都真的生效」**
  （2026-10-08，来自架构现状审查 `docs/Architecture Reality Audit.md` §7.3）。
  症状：预算表里写着 7 个键，而 `assemble` **只用了 4 个** —— `system` / `tools` / `reserve`
  声明了却从不使用。实测把 `budget.system` 改成 90，各层输出**逐字不变**
  （`memory 2457 / project 21024 / state 4936 / msgs 5`）。它比「配置写了没人读」更隐蔽：
  连「有没有人读」都难查，因为它压根不是配置项、只是表里的一行 —— 而改它的人会以为自己
  动了那一层的额度，**且不会有任何测试报红**。
  改法（最小）：① `DEFAULT_BUDGET` 只留真正生效的四个（memory / project / task / conversation）；
  ② `config-defaults.cjs` 那三个键**保留**（删了会让老盘上存过的配置读不回来），但注释里
  明写「调它们不改变任何行为」；③ 新断言进 `116-project-context-complete.mjs` —— 逐项把额度
  改成 90%，断言**该层实裁长度真的跟着变**（口径同 `109-scale-config.mjs`：看判决变没变，
  不看「表里有这个键」），另加一条反向断言「老键 `system` 传进来也不改变任何一层」。
  **行为零变化**：改前 / 改后同一组输入的输出逐字相同（`[2457, 21024, 4936, 5]` / `chars 49152`）。
  验证：内核自检 **3986 → 3992 项、0 失败**；行数红线合规。
  遗留：`config.context.budget` 里那三个死键**没有清理**（保留是为了老配置兼容）—— 要真删
  得配一次迁移，而收益只是「表里少两行」，**不值得**，故按现状记账。

## [1.30.0-beta.13] — 2026-10-07

- **一批「贴在 300 行红线」的文件拆开：10 个主文件、新增 10 个子文件**
  （`docs/improvement-checklist.md` 2026-10-06 记的「留给专门一批」，按 `.github/skills/split-file` 做）。
  拆的是：`electron/core/errors.cjs`（KINDS/MESSAGE_RULES/STRATEGY_TEXT 三张表 → `error-kinds.cjs`）、
  `electron/core/config-defaults.cjs`（品牌 + 枚举 → `config-constants.cjs`）、
  `electron/core/config-normalize.cjs`（小工具函数 + 两个逐项规范化器 → `config-normalize-parts.cjs`）、
  `src/types/safety.ts`（纯类型 → `safety-types.ts`）、
  `src/types/models-extra.ts`（会话那一组 → `models-session.ts`）、
  `src/types/backend.ts`（文件 / 终端那摊方法 → `backend-io.ts`）、
  `src/components/settings/tabs/SecurityTab.tsx`（命令探针 + PolicySelect → `security/SecurityParts.tsx`）、
  `src/components/settings/tabs/McpTab.tsx`（服务器列表 → `ServerList.tsx`）、
  `src/components/chat/TaskRow.tsx`（折叠的详情面板 → `TaskRowDetails.tsx`）、
  `src/components/chat/Composer.tsx`（输入区状态与逻辑 → `composer/useComposerState.ts`）。
  **每处都按「主文件留作门面、子文件领一个职责」**：表 / 常量 / 原料 / 类型 / 一摊 UI —— 各自改动理由不同，
  并且一律从主文件再导出，**调用方一行都不用改**。
  验证：`npm run typecheck` 0 错误、`npm run lint` 0 错误、内核自检 **3986 项 / 0 失败**、
  行数红线 **1024 个文件全 ≤ 300 行**。
  顺带把两条「按源码扫描」的自检指到搬走后的文件（`51-mcp-presets` 找 `useBundledNode`、
  `44-steering` 找「你改过方向」）—— 拆文件时这类检查最容易静默失效，**它绿不等于功能还在**。

- **A 闸门补上「硬拦截」+ 卡片两个明确出口**（2026-10-07，真机走查逮到的两个洞）。
  走查结论：①「先别动，等我确认」这句话，4 次里只有 1 次真弹出 gate 卡 —— 触发靠的是
  模型自觉，不是强制；②就算弹了、用户选了「先别动」，模型仍可能接着调工具（逮到过一次：
  判定「没批准」之后 36 秒它又执行了一次 `read_file`）。
  现在 ②变成了**硬拦截**：被否决的会话记进新的 `electron/core/gate-denied.cjs`，工具咽喉
  `electron/core/tools/index.cjs` 在**每次调用前**查一次，命中就直接拒、不执行；用户再说话
  （新的一轮）时由 `loop-run.cjs` 自动清除 —— 状态只按会话、只活一轮，不跨轮绑住用户。
  ①的提示词那一半也把触发词列全（先别动 / 等我确认 / 先分析再决定 / 别动手 / 等我点头 / 先看看再说），
  并明写「拿到答复前别调任何工具」。另外渲染层多了一张专属的 `components/chat/GateCard`：
  gate 卡只出「执行 / 先别动」两个明确按钮 —— 以前它和澄清共用四个出口，而其中
  「跳过，你自己看着办」「换个说法」对 gate 卡的**真实后果都是停手**，措辞与后果相反
  （澄清卡本身一字未动；`ClarifySlot` 按内核带上来的 `gate` 标记分流）。

- **「用户说了先别动，就别自作主张」成了执行前的一道闸门**（A 案）。起因：用户说了
  「先分析不要动、我确认再执行」，模型分析完却直接开工 —— 审批粒度是「每次工具调用」，
  而「写一个脚本 + 跑一条命令」只批了一次：**92 次文件移动只批了一回**。
  现在给 `ask_user` 加一条 `gate: true`：把方案摆出来后**单问一次**「就按这个计划动手吗」，
  只有用户在卡片上明确点「就按这个计划执行」才放行。与普通澄清**方向相反**——这条是
  **fail-closed**：拿不到界面 / 用户离场 / 自由回答 / 直接跳过一律算「没批准」，**立刻停手**，
  一个文件都不改（普通澄清那边离场是采纳默认）。实现住在新的
  `electron/core/tools/ask-user-gate.cjs`（从 ask_user.cjs 拆出，那文件顶到 318 行）；
  **复用澄清那条 `chat:confirm` 往返，不新增 IPC 通道、不改渲染层**。配套提示词层加
  `PLAN_GATE_RULE`（`prompt-rules.cjs`，**不跟任何开关** —— 那是用户当场下的指令）。
  自检新增 `132-plan-gate` 一组（放行 / 选停 / 自由回答 / 跳过 / 离场 / 无界面 / 无人值守 / 卡片默认值）。

- **`ask_user` 的默认选项：破坏性操作会被点名报警**（B 案）。`normalize()` 一直只保证
  「有一个默认」，保证不了它是不是最保守的（`clarify.cjs` 原注释自己写着）—— 而离场 10 分钟
  或定时任务会**直接采纳这个默认**。现在默认选项的 label/effect 命中破坏性词（删/覆盖/移动/
  推送/发布/装依赖…）就**在现有 warnings 通道报警**（不新增结构、**只报警不改选**：启发式会误伤
  「先备份再删」这类正常描述）。自检 `99-clarify` 加 5 项。

- **工具大输出（`data/logs/tool-output-*.log`）加了总量上限**（C 案）。以前只按年龄（30 天）
  和份数（至少留 5 份）清，**体积是无界的** —— 一条反复 `tail` build 日志的长任务一天能写几十个
  MB 级文件。现在 `data-retention.pruneByAge` 支持 `maxBytes`，`pruneAll` 给 tool-output 接上
  **256MB 总量闸**（超了从最旧的删，「至少留 N 份」不破）。这些文件里是命令原样输出（过了
  `redact`，但恢复码之类认不出的敏感串仍在），要的不是「留久」而是「有界」。自检 `90-error-reader`
  加 6 项。（**没**去动 `redact.cjs` 认恢复码 —— redact 刻意「不猜」，加正则只会误伤正常文本。）

- **会话文件压实：删掉磁盘上那些「读的时候本来就被收敛掉」的流式快照**（D 案）。
  流式回复分段落盘会在同一个 key 留下一串快照，读的一侧按 key 收敛（`session-read.cjs` 的
  `collapseByKey`），但**磁盘上那些旧快照一直躺着** —— 实测一条长回复的会话到了 **83MB**，
  其中 1385 / 1606 行是 partial。新增 `electron/core/session-compact.cjs`：规则与 `collapseByKey`
  **逐条对齐**、位置取该 key **第一次出现**处（否则重载顺序会变），所以**读出来的结果一字不变**；
  解不开的坏行 / meta / 压缩点原样逐字保留。只在**收尾那条**落盘后、且文件 > 8MB、又比上次处理
  长了 ≥ 4MB 才真做（长会话不会被每次追加拖进一次全量重写），落盘走 `writeAtomic`。
  自检 `53-partial-persist` 加 12 项（含「压实前后 load 结果一字不变」的对照）。


## [1.30.0-beta.12] — 2026-10-07 · 原子写与真机脚本各收敛成一处、网页跳转过网络策略

- **「改了代码就要有验证」进提示词层（自动化测试的默认动作）**（清单 2026-10-03 记的 ❌3，已授权）。
  以前拿 Harbor 做**别的项目**时，「跑测试」是「想到了才做」而不是默认动作 —— 新项目里没有测试
  脚本时没人提醒「先建一个最小的」。内核本来就有「跑没跑测试」的判读（`core/task-outcome.cjs`），
  缺的只是**动手前就想到**这一步。现在 `core/prompt-rules.cjs` 加一条 `TEST_RULE`（与 `SCALE_RULE`
  同一套做法，**不跟任何开关**）：改了代码就跑到绿再收工、项目里没测试就先建一个最小的
  （哪怕就一条断言）——「一个能重跑的验证，比一次『我看着没问题』值钱得多」。
  **尺度写死在文案里**（清单特意点名的「不能变成每个任务都逼着跑测试」）：末一句明说
  「纯问答 / 只读 / 闲聊不适用」，免得把闲聊也拖下水。
  自检 `131-test-prompt`（7 项，含「关掉别的开关它也照样在」与「完整系统提示 `build().message` 里也在」）。
  验证：内核自检 **3936 → 3943 项 / 0 失败**；`npm run verify` 全绿。

- **浏览器里的跳转也过网络策略（审计问题 20 的另一半）**（`docs/improvement-checklist.md` 2026-10-04
  记的「browse 三个兄弟不过网络策略」，已授权 · 硬禁区 10）。以前 `security.network`（全局网络策略）
  只管 `browse` **主动开**的地址；网页里点一个链接跳走那条路只归 `general.browserNavigation` 管 ——
  于是 `security.network.mode = deny`（禁止联网）时，Agent 仍能「点开一个链接」跳出去。
  现在 `navigation-policy.decide` 多收一个「目标是否被网络策略**明确禁止**」，且**排在 `mode === 'allow'`
  前面**（禁止优先于允许）。判据按**跳转的目标 URL**，与 `browse` 同一份实现（`core/net-policy.cjs`
  的 `kind: 'webview'`，默认由 `defaultNetDeny` 接上，延迟 require 保持模块可测）；`window.open` /
  `target=_blank` 那条路（`setWindowOpenHandler`）同样过滤。**只接最强档 `deny` / 禁止名单**，
  `ask` / `allow` 档一个字没改（在 `will-navigate` 里没法弹卡，接 `ask` 只能「放行」或「硬拦」二选一，
  都比现状差）。「这次不做什么」写在 `docs/安全模型.md` §8。
  自检 `09-browser` 加 6 项（含「网络禁止 + 导航允许 → 跳转被拦」的端到端）。
  验证：内核自检 **3930 → 3936 项 / 0 失败**；`npm run verify` 全绿；真机（源码版 dev）起一个本地
  http server 做**对照实验** —— 禁止名单点名 `localhost` 时点链接，页面停在 A；清掉名单后同样一点
  就跳到 B。两组都过，证明是网络策略拦的、而不是「链接本来就点不动」。

- **真机脚本可靠性：CDP helper 收敛成一处 + 语法预检 / 异常分家 / 退出清理**（清单里标「值得优先」的那条）。
  以前真机验证靠 `tmp/` 里一堆一次性脚本（`probe-*.js`、`verify-*.mjs`，几十个），每个都把 CDP
  连接逻辑抄一遍，而 `tmp/` 被 gitignore —— 沉淀不下来。`tools/shot/cdp.mjs` 已经是共享库，但
  `tools/shot-electron.mjs` 又自己写了一份（第三份）。后果就是清单原话：「测试的 bug 伪装成产品的 bug」，
  2026-10-03 一夜连着三轮误报都得人肉分辨。这次：
  · `tools/shot/cdp.mjs` 补齐可靠性三件套 —— `checkExpression`（发出去之前先编译，语法错当场拦，
    不再变成页面里的 `SyntaxError`）、`evaluate`（页面异常只留第一行 + 带 label；返回 undefined 时
    警告「是不是漏了 return」）、`makeCleanup`（退出时倒序关子进程 / 连接，node 不再挂住）、
    `findPageTarget`（连不上端口时报错带「怎么办」）；
  · `tools/shot-electron.mjs` 删掉自带的那份 `Cdp` / `connect` / `sleep` / `findTarget`，改用共享库；
  · 新增 `tools/cdp.mjs` —— 真机探针 CLI（连已开的实例：dev 或打包版），把散在 `tmp/` 的那类脚本
    收成仓库内的一等工具。
  自检 `130-cdp-helpers`（13 项，纯逻辑不连真机）。
  验证：内核自检 **3917 → 3930 项 / 0 失败**；真机 `node tools/cdp.mjs --port=9222 --js="document.title"`
  → `Harbor`（坏语法被当场拦下、不再发到页面）；`npm run shot:electron`（复用共享库后）→ 连上打包版、
  执行脚本、截图、探针全部正常。

- **文本原子写收敛成一处（4 份 → 1 份），顺带给另外三处补上退避重试**（`docs/improvement-checklist.md`
  2026-10-04 记的「三份原子写」待办，已授权）。以前「别丢用户数据」的那段逻辑散在四处：
  `core/safe-write.cjs`（共享版，**只有它有**「文件被占着」退避重试）、`core/session-crypto.cjs`
  （加密迁移用）、`core/projects.cjs`（项目登记表）、`core/schedule-store.cjs`（定时任务台账）——
  后三处是各写各的本地副本，**都没有重试**，Windows 上 rename 撞到 EPERM/EBUSY 时会直接抛。
  现在三处一律走 `safe-write.writeAtomic`，`session-crypto` 那份本地实现删掉。
  自检 `118-safe-write` 新增一条钉子：**全内核只允许一个 `writeAtomic` 实现**（递归扫 `electron/**/*.cjs`）。
  「没顺手动的」：`handlers/profile.cjs` 存头像是**二进制拷贝**、`core/rotate-file.cjs` 是日志轮转、
  `core/memory.cjs` 是旧文件改名 —— 语义不同，各自留着。
  验证：内核自检 **3916 → 3917 项 / 0 失败**；`npm run verify` 全绿。

- **P0-3 步骤 4：Permission 收到 Action 上（保守版）—— 只收结论，判断一字未改**（收敛计划 4.2 收尾）。
  以前「这次为什么被拦 / 为什么弹卡」只散在审计与日志里，`Action`（`task.steps[].action`）
  只看得到危险度与规模。现在 `core/action.cjs` 新增 `permission` 字段与 `notePermission()`，
  三层门判完顺手把**结论**回填：危险度 `tools/risk-gate.cjs`（allowed / asked / denied / blocked）、
  规模 `tools/scale-gate.cjs`（ok / note / granted / blocked / disabled）、路径 `tools/permission.cjs`
  （granted / denied / bypassed）。`tool-runner` 把组装好的 Action 挂成 `ctx.action` 交给执行层；
  `core/task-notes.cjs` 的落盘白名单（`storedAction`）补上 `permission`（仍是**只留结论**，
  依然**不含命令原文** —— 自检 `127-action` 钉着这条）。
  **判据与触发一个字没改**（该问照问、该拦照拦），没挂 Action 时一律空操作、老路径不变 ——
  「这次不做什么」写在 `docs/安全模型.md` §8（含「为什么不复用 `action.scale`」的取舍）。
  自检 `129-action-permission`（16 项）。
  验证：内核自检 **3898 → 3914 项 / 0 失败**；`npm run verify` 全绿；真机四场景
  （critical → 拦 + `risk:blocked`；盘根递归 → 拦 + `scale:blocked`；小命令 → 放行 + `risk:allowed`/`scale:ok`；
  完全访问档读越界文件 → 不问但留痕 `path:bypassed`）。

- **P0-7 收尾：事件 type 的清单定死一处，两侧对齐钉进自检**（收敛计划 4.3 步骤 b，主进程侧）。
  以前「主进程会发哪些 type」只散落在各模块的 `emit(...)` 里，渲染层的 `EVENT_TYPES` 是
  手抄的第二份 —— 改一处漏一处，编译器一点忙帮不上（.ts 与 .cjs 间没有类型传递）。
  现在新增 `electron/core/event-types.cjs` 作**唯一真相源**（`AGENT_EVENTS` 生命周期 16 名 +
  `CHAT_EVENT_TYPES` 全集）：`events.cjs` 改为从它 require（去掉重复定义），`src/types/events.ts`
  按它对齐。**顺带查出并补上渲染层漏登的两个 type**：`loop`（循环守卫交人）与 `compacted`（上下文压缩）。
  自检 `126-event-types` 从四路钉死：① 生命周期名两侧逐字相等；② 全集两侧逐字相等；
  ③ 主进程所有 `emit` 的 type 都在清单里（判据跟着源码里的 `emit({` 走，不写死文件清单，免得它自己漂）；
  ④ 渲染层 `handleStreamEvent` 的每个 `case` 都在清单里。
  **反向验证过**：故意在清单里加一个渲染层没有的 type、故意 emit 一个未登记的 type，
  两种漂移都报红（差异带「谁独有」，比一长串列表好定位）。
  验证：内核自检 **3897 → 3898 项 / 0 失败**（126 组 7 项 → 8 项）；`npm run verify` 全绿。

- **修 P4-1：规模闸门不再只看命令形态 —— 逃出工作目录的递归/批量改成探目标实际规模**。
  `docs/improvement-checklist.md` P4-1 记的原话：清理 2 个临时文件 + 列一层目录也被拦下要确认。
  根因是判据为命令**长得像不像**（看到 `-Recurse` / `robocopy` 就拦），不管它实际动多大。
  现在 `core/scale.cjs` 拦之前先**探目标路径的实际规模**（`core/scale-files.cjs` 新增 `probeSize`：
  **有界递归**，数到 `scaleMaxFiles` 就停、目录数到上限也停）：
  - 探得到 且不大（< `scaleMaxFiles`）→ **不拦**（降 note，仍留痕）；
  - 探得到 但很大 → 照旧拦；
  - 探不到（环境变量 / 盘根 / glob / 没权限）→ **照旧拦**（不知道就别放行，保守方向）。
  - **为什么不用两层的 `estimateFiles`**：它是**下界**，`C:\Users` 两层只数到百来个条目、
    递归却十几万 —— 用它判「小」会放过最该拦的东西，方向正好是安全的反面。
  - ⚠️ **触发硬禁区 10（改权限行为），已按用户批准落地**；「这次不做什么」写进
    `docs/安全模型.md` §8：**不**顺手改危险度层、**不**给环境变量路径做展开探测。
  - 验证：新增自检组 `128-scale-target`（替身喂「小/大/探不到」三种，真探测器拿仓库稳定路径验）；
    内核自检 3897 项全绿。

- **架构收敛 P0-3（接入·第 3 步）：`step.action` 落盘 —— 一次工具调用的判断结论进了任务台账**。
  `task-notes.addStep` 现在收 `action`（`core/action.cjs` 组装结果），落进 `task.steps[].action`
  （危险度 / 规模 / 范围 / 可逆性）—— 「这次 `run_shell` 危不危险、大不大、能不能重跑」
  从此在一个对象里问得出，不再散在 `risk.cjs` / `scale.cjs` / `task-intent.cjs` 三处拼。
  - **只加字段**（硬约束 5）：老台账里的 step 没有 `action`，读的时候按「没有判断记录」处理；
    没传 `action` 的 step **根本不写这个键**（老形状一字不变）。**不迁移、不批量回写**。
  - **不新建数据结构**：复用 `task.steps[]`，不新开 `data/actions/`（防「同义结构比缺字段更难收」）。
  - 落盘的 action **不含命令原文**（只留判断结论）—— 命令已在同一条 step 的 `args` 里，
    多存一份就多一处泄密面。
  - ⚠️ **触发硬禁区 3（改数据结构），已按「只加不改 + 旧台账照读」落地并验证**。
  - 验证：自检 127 新增「真建任务 → addStep 带 action → 读回」+「没传 action 的 step 没有该键」；
    真实旧任务文件仍能 `npm run doctor` / 读回；内核自检 3883 项全绿。
- **架构收敛 P0-3（接入·第 2 步）：每次工具调用组装 Action，跟着 `agent.tool.started` 推给界面与诊断**。
  上一步落地的 `core/action.cjs` 现在真接上了：`tool-runner.cjs` 的 `runOne()`（所有工具的
  必经之路）在发 `agent.tool.started` 前组装一次 Action（危险度 / 规模 / 可逆性 / 范围），
  挂进事件 payload —— 渲染层与诊断「一眼看得见这次调用的危险度与规模」。
  - 「用户原话」这个口径抽成 `loop-route.cjs` 的 `lastUserText()`（**一处真相源**）：
    意图路由与 Action 的规模豁免都从它取，不各抠一份（硬约束 9）。
  - **只加字段**：事件 payload 多一个 `action`，老的消费者（渲染层 `agent.tool.started` 只读
    `toolCallId`/`name`/`args`）看不到它照常工作。**没碰数据结构**（`step.action` 是下一步）。
  - 验证：自检第 127 组新增「真跑一次执行器、断言 started 事件带 action」；内核自检 3878 项全绿。
- **架构收敛 P0-3（第一步）：新增 `core/action.cjs` —— 一次工具调用的统一对象**。
  以前「这次操作危不危险 / 大不大 / 能不能重跑」散在 `risk.cjs` / `scale.cjs` /
  `task-intent.cjs` 三处、没有共同挂靠点。`action.of()` 把它们收成一个对象
  （`risk` / `scale` / `scope` / `reversibility`），**只组装、不重判**（每条都调现成的家）。
  - 自检第 127 组钉「形状 + 不重判」：Action 的每个字段都和 `risk.classify` /
    `scale.inspect` / `REPLAY_UNSAFE` **逐字一致**（组合层再抄一份判据就是这个项目最忌的
    「同一件事写两份」）。
  - ⚠️ **尚未接入内核**：接入点在 `tool-runner.cjs` 的 `runOne()`；分步方案（含**改数据
    结构**的步骤 3、**动权限判断**的步骤 4）写在 `docs/Runtime领域模型.md` 4.2「接入设计」，
    那两步触发硬禁区 3 / 10，单独提交、单独验证。
  - 验证：内核自检 3875 项全绿。
- **架构收敛 P0-7（前半）：事件类型登记表（渲染层侧）**——给「主进程推给渲染层的
  事件 type」建一份显式清单，堵「UI 靠裸字符串猜后端状态」。
  - 新增 `src/types/events.ts`：`AGENT_EVENTS`（生命周期 16 个标准名的**镜像**）+
    `EVENT_TYPES`（渲染层认得的 type 全集，分「处理 / 有意忽略 / 生命周期」三档）。
  - 自检新增第 126 组：从主进程 `core/events.cjs` 与渲染层 `src/types/events.ts`
    两侧源码抠出生命周期名**断言逐字相等**；再断言 `handleStreamEvent` 的每个
    `case '…'` 都登记在清单里（新增事件忘了登记就报红）。
  - ⚠️ **遗留（下一步做）**：主进程侧有些事件 type 是**用常量 / 变量发的**
    （`confirm_request`、`agent.tool.completed` 等），静态抠不全 —— 真正把两侧
    对齐要到「主进程 emit 调用点改用常量导出」，那是更大的一改，设计记在
    `docs/Runtime领域模型.md` 4.3。
  - 验证：内核自检 3860 项全绿 / typecheck / 单测 / verify 全过。
- **架构收敛 P0-5：Decision（决策）统一成一处真相源**（不改通道名，纯收敛）。
  以前「要用户拿主意」是**两条往返各自组装**：写操作审批（`askUser`，回话布尔）
  与开工前澄清（`askClarify`，回话对象）。两条共用底层 `confirm-bridge`，但**上层事件形状
  靠人肉对齐**过 —— 2026-10-07 的僵尸卡 bug 就是审批那条**漏了 `sessionId`**（渲染层认领
  不到那张卡、还把它后面的澄清卡全挡死）。
  - 新增 `electron/core/decisions.cjs`：把「决策有哪些类型（`DECISION_TYPES`：approval /
    clarify）、每种什么脾气（id 前缀 / 超时怎么算 / 超时收卡事件名）、事件的**公共字段**、
    回话怎么解（`exitsIn`）」定在**一处**。两条往返都过 `decisionFields()` 组装 ——
    公共字段（`decisionType` / `sessionId` / `taskId`）天然对齐，谁都不会再漏一个。
  - 事件多了个 `decisionType` 字段。渲染层分流**改看它**，不再靠 `kind` 猜
    （审批的 `kind` 是工具种类 write/mcp/…、澄清的 `kind` 恒为 'clarify'，同一个字段名
    两套值域 —— 硬约束 9 要消灭的）。老主进程没带 `decisionType` 时**退回看 `kind`**，
    界面不会因为主进程先后端升级而失能。`kind` 字段本身**保留**（老消费者可能还在读）。
  - `chat-confirm.cjs` 的 `exitsIn()` 搬进 `decisions.cjs`（和「决策回话怎么解」同住一处）；
    `chat-confirm.cjs` 反而降到 300 红线以下（287 行，原 295）。
  - **验证**：内核自检新增第 125 组（类型集合两边源码抠出来**断言相等** + 两条往返真跑的
    `confirm_request` 公共字段都齐 + 收卡事件带 `decisionType` + `exitsIn` 搬家后行为不变）；
    渲染层单测 `src/stores/thread/__tests__/decisionRouting.test.ts` 钉 4 种分流/兼容；
    内核自检 3853 项全绿 / 单测 1460 用例全绿 / typecheck / lint / lint:kernel 全过。
- **浏览器：AI 自己决定「开新标签」还是「在当前标签里打开」**（真机反馈「AI 一口气开太多标签」）。
  以前工具只有 `browse`（新地址**必然**开一个新标签）和 `browse_nav`（只能在历史里挪），
  模型没有表达「这个页面只是中转」的路 —— 提示词里那句「中转页在当前标签里走完」是句
  **空头支票**，它只能一个地址一个标签地堆。现在 `browse` 多了一个可选参数 `sameTab`：
  传 true 就在当前那个**属于 Agent 的**标签里打开（保留历史，之后 `browse_nav back` 退得回来）。
  **默认行为一字不变**（不开新标签是显式要的，不是默认）。
  - 顺带把 `owner` 这个**死字段**真正读起来：它以前只在类型和赋值里出现，注释写着
    「Agent 不许把用户自己开的标签当成自己那一个」，却**没有任何地方读它** —— 于是用户点回
    自己开的标签看时，Agent 的点击 / 输入 / 后退会作用在他正看的那一页上，把页面点走。
    现在这几类动作按 `agentTabOf` 挑标签（只认自己开的），用户切回自己那页看不再被误伤。
  - `useBrowserStore.ts` 拆出 `browserTabs.ts`（加了这批逻辑后过 300 行，硬约束 #2）；
    老引用路径不变（store 里转出去）。
  - 提示词版本 `/3 → /4`（BROWSER_GUIDE 重写）。
  - **验证（源码版 dev 真机，CDP 驱动）**：
    · 连读三个页面：`example.com` → `example.org`（各开新标签）→ `example.net` 带 `sameTab:true`
      → **标签栏 2 个**（不开 sameTab 会开到 3 个）。
    · 用户自己开一个标签再看时，AI 的 `browse_elements` **拨回自己的标签**执行 ——
      实测用户的 `example.org/user-page` webview 变 `hidden`、Agent 的 `example.net` 变 `visible`。
  - 钉子：单测 `src/stores/__tests__/browserTabPolicy.test.ts` 钉行为；自检 121 组钉
    「`sameTab` 的字段名四处一致」（工具 / 事件类型 / 桥 / store），93 组钉提示词版本 `/4`。
- **硬约束 10 改写：版本号只在发布时升。** 原来那条是「改了代码必须升版本号」，
  它把版本号变成了**提交计数器** —— CHANGELOG 攒到 234 个版本段、一天发过 16 个 beta，
  其中 `beta.4` … `beta.10` 七版连 tag 都没建。现在拦的是「**改了代码必须写 CHANGELOG**」，
  版本号回到**发布事件**的频率。检查实现：`scripts/check-rules/checks-changelog.mjs`
  （原 `checks-version.mjs`）；自检 54 组同步放行 `## [未发布]`。
- **发布漏 tag 补两道闸。** 新增 `npm run check:release`（当前版本的 tag 本地 + 远端是否到位，
  缺了退出码 1）；`release:upload` 缺本地 tag 就停（`--tag` 才代建）。

## [1.30.0-beta.11] — 2026-10-07 · 单测不再污染应用真 data（日志）

### 这一批做了什么

- **修一个长期存在的污染：跑 `npm run test:unit`（vitest）会往应用的「真 data/logs」里灌假数据。**
  单测会 `require` 内核 `.cjs`（`log` / `config-normalize` / `scale-gate` / `url-policy`…），
  这些模块内部直接 `log.*` 写 `DIRS.logs`；而 vitest 的进程入口不是 `scripts/selftest.mjs`，
  自检那套隔离判定不认它 → 写的就是用户真日志。**受控实测**：跑一次 `test:unit` 主日志 **+15 行**
  （`[规模预检] … 会话 ftopic/ale-ok/wander`、`assistant.model「dead-model」…`、`打开外部链接 [test]…`）；
  历史上 2026-10-04 一天就积了 2359 行。只污染日志、不碰 config/credentials，但排查时会被它带偏。

- **修法（复用自检那套隔离，不另起一套）**：
  1. `electron/core/paths.cjs`：新增 `isUnitTestRun()`（认 `HARBOR_UNIT_TEST === '1'`），
     与 `isSelftestRun()` 并列成 `isolationDirName()` —— 自检 → `data/selftest-data`，
     单测 → `data/unit-test-data`；`dataDir()` 据此切目录（派生子目录一起走）。
  2. `vitest.config.ts`：`test.env` 注入 `HARBOR_UNIT_TEST: '1'`。
     用 **env** 而不是入口脚本判断：vitest 没法在 `test.env` 里改 `process.argv`，
     而 env 在 worker 启动时注入，早于测试模块、也就早于内核 `.cjs` 被 require（时机没问题）。
  3. `src/lib/__tests__/diagnosticsRedaction.test.ts`：日志路径改走内核 `DIRS.logs`
     （原来硬编码 `ROOT/data/logs` —— 隔离后会写到真日志、且 `diagnostics.build()` 读 `DIRS.logs` 会读不到 → 假绿）。

- **钉子（防回归）**：新增 `src/lib/__tests__/testDataIsolation.test.ts` —— ① 运行期断言
  `DIRS.data` 落在 `unit-test-data`、派生目录一致；② 源码层面钉「`vitest.config.ts` 注入的信号名
  = `paths.cjs` 认的名字」（AGENT.md #9：两边各写一套会静默漂移）。

### 验证

- **改前**：跑一次 `npm run test:unit` → 主日志 2874 → 2889（**+15**）。
- **改后**：同样跑 → 主日志 2892 → 2892（**+0**）；假数据改为落到 `data/unit-test-data/logs`（17 行）；
  `config.json` / `credentials.json` 的 mtime 与内容全程未变。
- 单测 **162 文件 / 1446 用例** 全过（新增 `testDataIsolation` 2 条）；内核自检 **3822 项 / 0 失败**。

### 遗留

- beta.10 已修「自检污染凭证」，本批补齐「单测污染日志」；两处现在都隔离到 `data/` 下的子目录。
- `data/selftest-data` 与 `data/unit-test-data` 目前**只增不清理**（临时数据）；要不要加清理留给后续。

## [1.30.0-beta.10] — 2026-10-07 · 权限卡作废后不放行（僵尸卡挡住澄清卡）

### 这一批做了什么

- **修一个真机复现的 bug：AI 发出提问卡，用户这边收不到，界面一直「正在进行中」。**
  根因是渲染层的权限卡（`permission`）槽位是个**全局单槽**，而唯一能清它的地方只有
  权限卡自己的两个按钮（取消 / 允许本次）—— 一旦权限卡「非按钮」地作废，它就烂在槽里；
  而 `pickAboveInput` 永远让权限优先，于是**后面所有澄清卡都被它按成 `hidden` 挡死**，
  用户永远看不到提问卡，主进程一直干等到 5 分钟的兜底超时。**三条漏清的路**：

  | 路径 | 主进程 | 渲染层（改前） | 结果 |
  |---|---|---|---|
  | 权限卡自然超时（5 分钟按拒绝继续） | 已结算 | **无任何事件**（澄清卡有对称的 `clarify.timeout`，权限卡没有） | 僵尸 |
  | 用户点「停止生成」 | `closeOut` 轮末结算 | 只 `cancelClarify()`，**不清 permission** | 僵尸 |
  | 切走 / 新建对话 | — | `clarifyGuard` 只收澄清卡，**不清 permission** | 僵尸 |

- **修法（三处，都是「补上对称」而不是另起一套）**：
  1. 内核 `handlers/chat-confirm.cjs`：`askUser` 超时时也 `emit` 一条 `confirm.timeout`
     收卡事件 —— 对称于 `askClarify` 早就有的 `clarify.timeout`。
  2. 渲染层 `stores/useUIStore.ts`：`permission` 支持按 `confirmId` 精确清（`closePermission`），
     并新增「清 + 回话」的 `cancelPermission`（对称 `cancelClarify`）。
  3. 渲染层接线：`confirmEvents` 收 `confirm.timeout`；`turnControl.endTurnRequest`（收尾统一出口）
     与 `stopActiveRequest`（停止）按对话收权限卡；`clarifyGuard` 切走 / 新建时也收。

- **两个隐藏的不对称（第一版漏了，真机第二次复现才抓出来）**：
  · `askUser` 的 payload **没带 `sessionId`**（`askClarify` 带了）→ 权限卡 `threadId` 恒为空串
    → 按 threadId 认领永远匹配不上，**收了通知也清不掉卡**。补齐 payload。
  · 渲染层 `askPermission` **没传 `confirmId`**（`askClarify` 传了）→ `confirm.timeout` 的
    精确清匹配不上。补上 `confirmId`。
  两条都属于 AGENT.md 硬约束 #9「跨模块约定只有一处真相源」那类 —— 两边各自都对，接起来什么都不发生。

### 验证

- **真机复现（改前，源码版 9222）**：让 Agent 跑命令 → 权限卡出现；点「停止生成」→
  界面「已停止」而**权限卡仍在**（主进程日志「轮末结算 1 条」在，但卡不消失）；
  再让 Agent `ask_user` → 澄清卡容器 `开工前先对齐` = `hidden`、僵尸权限卡可见。
  截图 `shots/card-bug/zombie-blocks-clarify.png`。
- **真机验证（改后）**：同样的停止场景 → `useUIStore.getState().permission === null`，
  权限卡消失；随后 Agent 的 `ask_user` 澄清卡**正常可见**（3 个问题 + 按钮都在，
  `perm: false`）。截图 `shots/card-bug/fixed-clarify-visible.png`。
- 单测 `npm run test:unit`：162 个文件 / 1446 条通过（含新增 `zombiePermission.test.ts` 9 条）。
- 内核自检 `npm test`：3822 项通过 / 0 失败（新增 `124-card-timeout.mjs` 组，
  含「收卡事件必须带 sessionId」那条钉子 —— 101 组被撑到 319 行，按职责拆出）。
- `npm run check:lines`：988 个文件全部 ≤300 行。
- `npm run verify`：全链 0 退出。

### 已知遗留

- 「设置也被清掉（不止 api key）」是**另一条独立问题**，不在本批范围内。

## [1.30.0-beta.9] — 2026-10-07 · 切走右侧标签后网页不再卡在右栏

### 这一批做了什么

- **修一个真机复现的 bug：点开浏览器看网页，切到别的右侧标签（审查 / 文件 / 任务…），
  网页还整张卡在右栏最上面。**
  右栏那层切走时会加 `invisible`（`visibility:hidden`），但 `BrowserTab` 里 webview
  自己内联写了 `visibility: visible` —— **子元素显式 `visible` 会盖过祖先的 `hidden`**
  （这和 `display:none` 不一样：`visibility` 可继承，但可被显式值覆盖），
  于是网页照旧铺在内容区最上层。修法：活跃态写 `inherit`，跟着容器一起藏，
  切回来时也自动恢复（`src/components/layout/BrowserTab.tsx`，一行）。
- **为什么原来的钉子测试没拦住**：`rightPanelKeepAlive.test.ts` 守的是
  「BrowserTab 别条件渲染 / 别被卸载」（防止切回来网页重新加载），
  但没守「**切走时它得真的看不见**」—— 而 `visible` 恰好是最顺手的写法。
  补了两条钉子（不许写回 `visible`、活跃态必须是 `inherit`）。

### 验证

- **真机复现（改前）**：源码版点开浏览器加载 example.com → 切到「审查」标签，
  webview 的 computed `visibility` 仍是 `visible`（而它上面三层祖先全是 `hidden`）。
  截图 `shots/browse-bug/before-switch.png`。
- **对照实验**：把 webview 内联 `visibility` 强制改成 `hidden` 再截图，画面变了
  （两张图 MD5 不同）—— 坐实就是它，不是别的原因。
- **真机验证（改后）**：同一个网页，在「审查 → 浏览器 → 文件 → 审查」之间来回切 ——
  webview 的 computed `visibility` 依次为 `hidden / visible / hidden / hidden`，
  而网页地址**一直是** `https://example.com/`（webview 没被销毁、切回来不重新加载）。
  截图 `shots/browse-bug/after-fix-at-diff.png` / `after-fix-at-browser.png`。
- `npx vitest run src/components/layout/__tests__/rightPanelKeepAlive.test.ts`：
  8 条通过（本批新增 2 条）。
- `node tools/line-limit.mjs --all`：986 个文件全部 ≤300 行。
- `npm run verify`：全链 0 退出（typecheck / lint / 内核 no-undef / 格式 / 行数 / rules / 单测 / 自检 / 构建）。
## [1.30.0-beta.8] — 2026-10-07 · 子代理卡片修好（留得住 + 重开会话还在）

### 这一批做了什么

- **修一个真机复现的 bug：子代理卡片留不住。** 子代理跑的时候卡片在
  （「只读子代理 · 进行中」），父侧那次工具一收尾（`agent.tool.completed`）
  **整张卡就消失**；切走会话再切回更没有。两层断点 —— 各自都对、接起来什么都不发生
  （AGENT.md 第 9 条）：
  1. `src/stores/thread/streamEvents.ts`：收尾时**重建**了一条只有六个字段的新记录
     （`id/name/ok/output/ms`），把挂在旧记录上的 `subagent` trace 抹掉了。
     改成先展开旧记录（`...state.toolRuns[index]`）再覆盖收尾该写的字段。
  2. `src/lib/schemas.ts`：`toolRuns` 的 zod 定义里**没有 `subagent`** ——
     zod 的 object 默认剥掉没声明的字段，于是会话文件里存着的 trace 读回来就没了。
     补上 `subagent`（顺带补 `summary`：它同样一直被静默剥掉，重开会话后工具行的
     「读了哪个文件」也跟着没了）。
- **为什么会漏**：v1 的单测只测了 `applySubagentEvent` 纯函数（归位对不对），
  **没测「收尾之后它还在不在」这条接线** —— 正是 AGENT.md 第 9 条点名的
  「测试照不到层与层的接线」。这一批补了两条**行为**钉子：一条走
  `handleStreamEvent` 的完整收尾，一条把落盘记录过一遍真 schema。

### 验证

- `npm test`：通过项见输出，失败 0。
- `npm run verify`：全链 0 退出。
- **真机复现（改前）**：源码版跑一次点名 `spawn_subagent` 的任务，CDP 每 4 秒探针 ——
  卡片先出现（「只读子代理 · 进行中」），父工具一收尾就消失、只剩工具行
  （截图 `shots/v1130-verify/10-card-first-seen.png` → `11-card-gone.png`）。
- **真机验证（改后）**：同一个任务重跑，探针全程可见 ——
  `[4s]` 进行中 → `[16s]` 6/6 步 → `[25s]` 已完成 · 6 轮 → 之后一直保持「已完成」；
  **再整页重载**（强制从磁盘经 `SessionLineSchema` 重读会话）后卡片仍在
  （截图 `shots/v1130-after/` 的 `t012s.png`、`t102s.png`、`final-after-reload.png`）。
- `npm run verify` 首次偶发红了一次（各步单独重跑均绿、重跑 verify 亦绿）——
  与本次改动无关，是项目已知的偶发（CI 那边给 vitest 加了 `retry:1`）。

### 诚实写的遗留

- 卡片仍然**不存子代理读到的原文**（`SubagentStep` 只有 `tool` + `args`）——
  那是 v1 的有意设计，不是这次的问题。
- 子代理 token 用量仍是 0（v0 就记着的账；要改 `loop-run.cjs` 的用量基座，属另一件事）。
- 这次没动 `progress` 的落盘策略（它只在跑的时候有用，收尾后不需要）。

## [1.30.0-beta.7] — 2026-10-07 · 自检彻底不碰用户数据（skills 也隔离）

### 这一批做了什么

- **收掉 beta.6 里留的最后一个例外。** beta.6 把自检的数据目录隔离到
  `data/selftest-data`，但有个例外：`DIRS.skills` **刻意不隔离**（始终指真
  `<root>/data/skills`），因为自检 `73-net-policy-pin-parts` 按 `ROOT/data/skills`
  **硬编码**现造技能来验「把技能钉到会话」那条链路。这一批把那处硬编码改成走
  `paths.DIRS.skills`，例外随之解除 —— `DIRS.skills` 与其余子目录一样走隔离目录。
- 影响：跑 `npm test` **不再**往用户真 `data/skills` 里造技能、也不再删它。
  自检时创建/清理的沙箱技能只落在 `data/selftest-data/skills`，跑完随隔离目录一起删。
- 改动文件：`electron/core/paths.cjs`（`DIRS.skills` 走 `dataDir()`）、
  `scripts/selftest/groups/73-net-policy-pin-parts.mjs`（硬编码 → `DIRS.skills`）、
  `scripts/selftest/env.mjs`（注释同步）。

### 验证

- `npm test`：**通过 3818 项，失败 0 项**。
- 跑完 `data/selftest-data` **不存在**（隔离目录已清理）；真 `data/skills` 里只有用户
  自己的 `writing-skills`（没被塞进自检造的技能）；`credentials.json` / `config.json` /
  `memory.json` 的修改时间**早于**本次自检 —— 真数据一个字节没动。

## [1.30.0-beta.6] — 2026-10-07 · 自检不再动用户凭证

### 这一批做了什么

- **修一个真机踩中的数据事故：跑内核自检会把用户的 API Key 弄坏。**
  症状是「我填入的 API 被清了」——密钥其实还在，但**读不出来**了。链路两层：
  1. `credentials.set()` 每次写入都以「当前环境」为准、把**整个文件**的
     `backend` 统一掉（`credentials.cjs`），而它**不会**重新加密文件里已有的密文。
     内核自检跑在**纯 Node** 环境（`safeStorage` 不可用）→ 后端被降级成 `plain`
     → 而 `decrypt()` 在 `plain` 下**原样返回**，于是那段 safeStorage 密文被
     当成 API Key 交出去。
  2. 触发它的是自检里的 `87-model-choice`：它 `set` 了两条测试凭证却**从不清理**
     （其余 9 组都是成对 set/remove，`08-limits` 还专门注释「别越攒越多」，
     `74-session-crypto` 干脆不碰真文件）。
- **根治办法：自检的数据目录与真数据隔离**（`paths.cjs` + `scripts/selftest.mjs`）。
  跑 `node scripts/selftest.mjs` 时，`DIRS.data` 指向 `data/selftest-data`，
  跑完即删 —— config / 凭证 / 会话 / 任务 / 事件全部落在这里，**绝不碰用户真数据**。
  用**进程入口路径**判断是不是自检（而不是环境变量）：`selftest.mjs` 全是静态
  import，ESM 会提前求值，往那儿写 `process.env` 根本拦不住，入口路径在进程启动
  那一刻就定死了。打包版走真目录，这个分支对生产无效。
- 唯一例外是 `data/skills`：自检里 `73-net-policy-pin-parts` 按 `ROOT/data/skills`
  **硬编码**造技能来验「钉到会话」那条链路，没走 `DIRS`。贸然把 skills 也隔开会
  让那 8 项当场红。要彻底隔离得先把那处硬编码改成 `DIRS.skills`（另一件事）。

### 验证

- `npm test`：**通过 3818 项，失败 0 项**（隔离前是 3810 通过 / 8 失败 —— 那 8 项
  正是被 skills 隔离误伤的）。
- **真数据逐字节不变**：跑自检前后，`data/credentials.json` 与 `data/config.json`
  的 sha256 完全一致（`196600f7…` / `107de114…`），文件大小不变。
- **恢复验证**：把被降级的源码版凭证 backend 改回 `safeStorage` 后，用设置好
  `userData`（`data/chromium`）的 Electron 进程真解一次，拿到 35 字符、前缀 `sk-`
  的 key —— 说明密钥一直都在，只是被标错了后端。
- 隔离目录跑完自动删除（`data/selftest-data` 不存在），真 `data/` 下没有新残留。

### 诚实写的遗留

- `87-model-choice` 自身**仍然 set 两条测试凭证不清理**（现在只落到隔离目录，
  不会再污染真数据，所以没强改）；按其他组的写法补个 `remove` 更规范，属于小事。
- `data/skills` **未隔离**（原因见上）。也就是说自检仍会读写真 `data/skills` ——
  它本身不含密钥，暂不构成凭证风险，但不是零接触。
- 这轮**没动** `credentials.cjs`（它是权限/安全模型文件，属硬禁区）：
  「`set()` 静默降级已有条目后端」这个设计缺陷**还在**，隔离只是让自检不再触发它。
  真机里若出现「环境后端在两次运行之间变化」（比如同一份 data 在装机版与 dev 版
  之间来回拷），仍可能复现 —— 那是另一个改动，需要单独评估。

## [1.30.0-beta.5] — 2026-10-07 · 子代理 v1：看得见它在干什么

### 这一批做了什么

- **子代理内部每一步实时推给界面**：v0 时子代理的事件只在内核里攒着（`subagent.cjs`
  原话是「事件**不**转发给父的流」），用户除了父任务那句结论，什么也看不见。
  现在它每调一个工具就转一条 `subagent.step` 出去：读了哪个文件、成没成、多久。
- **对话流里多一张「只读子代理」卡**（`SubagentCard.tsx`）：标题 + 状态（进行中 / 完成 /
  失败）+ `n/m 步 · n 轮 · 耗时`，下面逐条列出子代理每一步。视觉跟「执行计划」卡
  （`PlanCard.tsx`）对齐 —— 同一份对话里两张卡不一样，接缝一眼可见（2026-09-30
  拆掉旧工具卡片的同一条教训）。
- **不新增 IPC 通道**：复用现有的 `chat:event` 推送。做法是照 `progress` 的老路子 ——
  在 `tool-run-ctx.cjs` 里给这次调用注入 `subagentEmit`，把**父侧那次调用的 `toolCallId`**
  贴上去，渲染层按它把事件归位到那条 `spawn_subagent` 记录。
- **卡片里不存子代理读到的原文**：`SubagentStep` 只有 `tool` + `args`。
  两个理由：① 那些原文本来就不该进父上下文（上下文隔离正是子代理的意义）；
  ② 全存下来会把会话文件撑爆（一次读 7 份文档就是几百 KB）。
- 起止都有边界事件（`kind: start / done`）：子代理一个工具都没调时，界面照样
  知道它开过、结束了 —— 不会出现一张什么都不说的空卡。
- `tool-runner.cjs` 已**正好 300 行**（硬红线），塞不进新注入 → 把「这次调用的 ctx」
  整块搬进 `tool-run-ctx.cjs`。这是搬家不是顺手重构：`tool-runner` 净减 19 行。

### 验证

- `npm run verify`：全链绿（typecheck / lint / lint:kernel / 格式 / 行数 / 规则 /
  单测 / 内核自检 / 构建）。
- `npm run test:unit`：全过，含新增 `subagentEvents.test.ts`（13 项）。
- 新增单测钉的是**归位**，不是「画得好不好看」：`toolCallId` 对不上时**不新建**记录、
  `started → completed` 认成同一行、id 对不上时**不张冠李戴**、内核发的三种 `kind`
  渲染层都认（源码守卫，跨层形状对齐）。

### 诚实写的遗留

- **子代理的 token 用量仍然为 0**：v0 就记下了这条（不并回父 `tokens` 是因为父循环
  每轮覆盖写入），但连「记在子任务自己台账上」这个替代方案也**没落地** ——
  实测子任务 `tokens: 0`。也就是说「上下文隔离到底省不省」这个问题，**这一版还是答不了**。
  要正确归因得改 `loop-run.cjs` 的用量基座，属于单独一件事。
- 卡片只在**父那条消息**上；跨会话 / 重新加载后，`toolRuns` 是从会话文件读回来的，
  `subagent` 轨迹会一起落盘显示（形状已在 `ToolRunRecord` 里）—— 但**没做**「点开去
  任务中心看那个子任务」的跳转。
- v0 那条「父的约束会原样变成子的约束」的坑（提示句里「你自己不要 read_file、只能调
  spawn_subagent」被传进子代理，害它去试派孙代理）这一版**没治** —— 属于提示词的角色
  分层，是另一件事。

## [1.30.0-beta.4] — 2026-10-06 · 子代理 v0：只读侦察兵

### 这一批做了什么

- 新增工具 `spawn_subagent`：父任务能派一个**只读**子代理去读一批文件 / 查资料，
  只把整理好的结论带回来 —— 子代理读过的原文**不进父任务的上下文**。
  这条直接对着 `improvement-checklist.md` §2 记了很久的架构级缺口
  （长任务上下文断层：裁剪之后 Agent 要重新侦察一遍）。
- 子代理是**真任务**：有自己的 `taskId` / 台账 / 状态机，`parentTaskId` 指回父任务，
  在任务台账里单独可见（v0 不画树、不加界面）。
- **只读靠咽喉、不靠提示词**：子代理跑在 `permission:'readonly'` + `allowWrite:false` 下，
  写工具在 `tools/index.cjs` 的两道闸上被拦 —— 自检里真调了 `write_file`，**没落盘**。
- 深度最多 1 层（子代理不能再派子代理，防 fork bomb）；预算从父的额度里**切**，
  父不限时子代理有自己的轮数保险丝（8 轮），父更小时取更小的那个。
- `parentTaskId` 是新字段：**写了迁移**（老任务读出来补 `''`，只补在内存里、老数据不动）。
- 事件 key 用子代理自己的（`sub_<taskId>`）—— 沿用父的 traceId 会让子代理跑完
  把**父任务**状态机打成 completed（AG-043 那类 bug），自检里钉了这条反向锁。

### 验证

- `npm test`（内核自检）：全过（含新增 `123-subagent` 组 20 项）。
- `npm run lint:kernel`：0 错误（新内核模块没有未定义标识符）。
- `npm run check:lines`：963 个文件全 ≤ 300 行。
- 新组钉的四条容易静默错的：只读硬拦、**父状态机不被带跑**、深度上限、预算切分。

### 诚实写的遗留

- **子代理的用量不并回父任务的 `tokens` 总数**：父循环每轮 `turn_end` 都用
  `base + 本次累计` **覆盖** tokens，中途并回会被抹掉 —— 留个**错的数字**比留一个
  不含子代理的数字更糟。用量记在子任务自己台账上，可单独归因；要正确并入得改
  `loop-run.cjs` 的用量基座，超出 v0 范围。
- **没做真机截图**：v0 的验收判据（父上下文只多一段结论）没在真机上走过。
- **界面不画子代理树**：v0 只在任务台账里可见。
- 可写的子代理（写进父事务）、并行多个子代理 → 留给 v1 / v2。

## [1.30.0-beta.3] — 2026-10-06 · 界面字体：内置「苹方」选项

### 这一批做了什么

- 设置 → 外观 → 界面字体 多一项「苹方」，栈是 `"PingFang SC", "苹方-简"` + 雅黑兜底。
  以前只能选「自定义」再手打字体名 —— 打错一个字符就**静默**回退雅黑，界面上看不出来。
- **两个名字都写进栈里**，不是为了好看：GDI 只认家族名「苹方-简」，
  全套名「苹方-简 常规体」会被**静默**换成新宋体（本项目这台机器上实测过）；
  而 Chromium 两个名字都命中 PingFangSC（渲染 hash 实测，两者逐像素相同）。
- 排在雅黑**前面**：macOS 本来就有苹方；Windows 上没装也不比现在差 —— 下一位就是雅黑。

### 验证

- `npm run verify` 全链 + `npm test`（内核自检）。
- `fonts.test.ts` 新增一条：钉「两个名字都在栈里、雅黑兜底」。
- 配置归一化白名单同步（`useSettingsStore`）—— 漏了它，选完重启会**悄悄**变回「系统默认」。

## [1.30.0-beta.2] — 2026-10-06 · 能力探测（第二批：IPC + 设置页）

### 这一批做了什么（内核 → 通道 → 界面，功能齐了）

- **IPC**：`provider:probe`（`handlers/provider.cjs`）—— 真去调内核探测，**只回实测结果**，
  不掺「声明与预设」：声明本来就在 `config.capabilities` 里，界面两边都拿得到，
  **让它们并排显示、不一致时指出来**才是这个功能的用处。通道进了 `EXPECTED_CHANNELS`（自检组 32 核过）。
- **界面**：供应商卡片里每个模型一行加「实测」按钮；点完把**实测**与**声明**并排显示，
  对不上时用警示色写出来（例如「工具调用：声明支持，实测不行」）。
  接口失败会把上游原话显示出来，**不吞错**；实测说不行或没测出来都**只提示** ——
  不改配置、不阻止执行。
- **口径**（落在 `providerProbeApi.ts` 与它的单测里）：只报**会真让调用失败的两项**（工具调用 / 图片），
  流式慢一点是体验不是错；**实测 `null`（没测出来）不算不一致** —— 未知不等于不支持；
  实测压根不测的维度也安静（那两条一开始都被 tsc 拦下来了：`usage` 只在实测维度里、
  `reasoning` 只在声明维度里，两个集合只有 `streaming / tool_call / vision` 共有）。
- 故意**不自动探测**（那要发真请求、花 token，得用户点一下）；也**不持久化**
  （关掉设置页就没了 —— 先看这个交互对不对，缓存下一批再加）。

### 还欠着（下一批）

- 真机清单：支持工具的模型 / 纯文本模型 / 不收图的模型，看设置页结论对不对。
- 探测结果落盘缓存。

## [1.30.0-beta.1] — 2026-10-06 · 能力探测（第一批：内核 + 自检）

> 按 `docs/改造任务/多协议与中转站支持.md` 的既有结论，Gemini 原生 / Anthropic /
> OpenAI Responses / 自定义鉴权头 / 代理都是**明确的「不做」**（理由当时写清了，不翻案）。
> 这一批只补台账里那条真缺口：`Provider 能力 ⚠️ 部分 | 未做能力探测表`。

### 这一批做了什么（**只做内核**，IPC 与界面在下一批）

- 新增 `electron/core/model-probe.cjs`：对「供应商 + 模型」发**最小请求**实测六件事 ——
  能不能回话、回的是不是 SSE、认不认工具调用、收不收图片、回不回 usage、模型名在不在 `/models` 清单里。
- 四条硬口径写死在文件头：**只影响提示、不改请求形状**；**只提示、不做硬门**；
  不自动改配置 / 不自动换模型；请求尽量小且可被中断。
- 失败或未知一律记 `null`（**未知 ≠ 不支持** —— 把未知画成不支持等于替用户猜了）。
- 流里带 `{"error":…}` 时**当场结束探测**，并把上游原话带出来
  （0.23.0 修过的「回答空白、不报错」是同一类坑）。
- 自检组 `122-model-probe`（**不联网**：探测函数支持注入假 fetch，
  「好模型 / 只有文本 / 名字打错 / 流里报错 / 网络挂」五种现场都能造出来）。

### 还欠着（下一批）

- IPC + 设置页：把**实测**与现有的「声明与预设」（`provider-capabilities.cjs`）摆在一起，
  「声明说支持、实测不行」的当场指出来。
- 真机清单：一个支持工具的模型 + 一个纯文本模型 + 一个不收图的模型，看设置页结论对不对。

## [1.29.0] — 2026-10-06 · 清账：诊断包日期 / 脱敏表契约 / 轮转收敛 / 文件数闸门接通

> 为什么是次版本号：`scaleMaxFiles` 从「不生效」变成真会拦（行为变化），
> 外加新增两个内核模块。

### 修了什么

- **诊断包在凌晨会读错日志**：`diagnostics.cjs` 用 UTC 日期拼日志文件名，
  而应用写日志按**本地**日期命名 → 东八区凌晨 8 点之前导出的诊断包，
  读的是**前一天**的日志（排查时看错日志会误导人，不是理论问题）。
  现在统一走 `log.dayStamp()` —— 一个口径一处实现。
- **两处单文件轮转收敛**到 `electron/core/rotate-file.cjs`：动作流水（6MB）与
  token 指标各写一份，是「改一处忘另一处」的典型来源。
- **`scaleMaxFiles` 接上活**：新增 `electron/core/scale-files.cjs`，只在
  递归 / 批量时估一次**下界**（只数两层、到上限就停；读不出来给 `null` 而不是 0）。
  此前 `estimate.files` 恒为 `null`，第四条硬拦恒不成立 —— 那个配置项等于不存在。
  界面上**仍然不给旋钮**（刻意）：估算只会低估，当旋钮会给人「很准」的错觉。
- **两处「其实没人守」的注释**：`73` / `74` 两个自检组文件头写着「还没注册」——
  实际早就挂着（`selftest.mjs` 里就有），照它会得出手检没在跑的错觉；
  `dataPortExport.ts` 三处写着「自检组 69 盯着」，而**根本没有那一组**。
  前者改正，后者补成真测试（`dataPortExportSync.test.ts`）。
- `109-scale-config` 里那条「scaleMaxFiles 没法钉」的警告换成真行为断言。

### 还欠着

- 9 个文件正好 300 行（硬约束 #2 的上限）。拆分是纯机械活且有回归风险，
  留给专门一批（计数见 `improvement-checklist.md`）。
