# docs/ —— 文档地图

> 一句话：**先看 [`../AGENT.md`](../AGENT.md)**（规矩的唯一真相源），这份只是「想知道某件事该读哪一份」的索引。
>
> 规矩：新文档进门请在这里登记一行；过期的别删，**移进 `docs/archive/`**（历史也有用）。

## 我想干什么 → 读哪一份

| 我想… | 读这份 |
| --- | --- |
| 知道**什么能做、什么必须先问** | [`../AGENT.md`](../AGENT.md)（硬约束 / 硬禁区 / 收工必跑） |
| 想知道**有哪些功能、目录结构、怎么跑、已知取舍** | [`../README.md`](../README.md) |
| 想知道**这个项目分几层、每层干什么、骨干是谁**（结构导览） | [`项目地图.md`](项目地图.md)（**不背数字**，要体量就跑 `npm run map`） |
| 知道**一件事分几步、报告怎么写** | [`开发流程.md`](开发流程.md) |
| 知道**这些规矩靠什么强制**、检查报红怎么办 | [`约束机制说明.md`](约束机制说明.md) |
| 搞懂**一次对话在代码里怎么走** | [`架构.md`](架构.md) |
| 知道**数据、密钥、权限的边界在哪** | [`安全模型.md`](安全模型.md) |
| 接手这个项目 / 换机器 | [`交接清单.md`](交接清单.md)（第二节「现在到哪一步（2026-11-01 现状）」是最新的） |
| 想知道**启动快不快、吃多少内存、常用操作卡不卡** | [`性能基准.md`](性能基准.md)（第五节是 v1.32.0 打包版实测；前面几节是 1.20.0-beta.22 的旧快照） |
| 发一个版本 | [`发布检查.md`](发布检查.md) |
| 查**还缺什么、别人做过什么别重复做** | [`improvement-checklist.md`](improvement-checklist.md) |
| 想做**子代理** / 看它为什么先做「只读侦察兵」 | [`改造任务/子代理-v0任务书.md`](改造任务/子代理-v0任务书.md) · 验收：[`改造任务/子代理-v0验收步骤.md`](改造任务/子代理-v0验收步骤.md) · 看得见每一步：[`改造任务/子代理-v1卡片.md`](改造任务/子代理-v1卡片.md) |
| 改代码前扫一眼**踩过的坑** | [`踩坑记录.md`](踩坑记录.md) |
| 知道**开工前为什么要先问你、怎么关、四个值是什么** | [`开工前澄清.md`](开工前澄清.md) |
| 用户报「用不了」 | [`故障排查.md`](故障排查.md)（含：**现在有哪些错误 → `npm run errors`**） |
| 看**最近改了什么、为什么** | [`../CHANGELOG.md`](../CHANGELOG.md) · [`更新历史.md`](更新历史.md) |
| 了解产品概念 / 升级与迁移 | [`核心概念.md`](核心概念.md) · [`更新与数据迁移.md`](更新与数据迁移.md) |
| 改字段 / 查磁盘上有什么、谁指向谁 | [`数据模型.md`](数据模型.md) |
| 改流程 / 查「任务为什么会停、怎么恢复」 | [`Runtime状态机.md`](Runtime状态机.md) |
| 想知道 Runtime 有哪些**对象**、哪些还没有、**要收敛成什么样** | [`Runtime领域模型.md`](Runtime领域模型.md)（设计稿 · 目标态，不是现状） |
| 想改**记忆**功能 / 看记忆的目标态、边界与治理 | [`Memory设计.md`](Memory设计.md)（设计稿 · 目标态，不是现状） |
| 想把记忆从「每轮注入全文」升级成「摘要 + 按需取全文」（现状核对 / 改动面 / 老机器性能 / 负面案例 / 红线） | [`research/memory-layered-recall-design.md`](research/memory-layered-recall-design.md)（方案 · 2026-10-13 · **阶段 1 已实施**：只读工具 `memory_search` + 指路文案；阶段 2 摘要注入未做、默认关） |
| 想让模型**一眼看出「有什么工具、何时该掏哪个」**（工具清单现状核对 / 分组地图 / 重复性分析 / token 实测） | [`research/toolbox-map-design.md`](research/toolbox-map-design.md)（方案 · 2026-10-13 · **已实施（B 方案）**：`core/tool-map.cjs` 分组地图，提示词 `/7→/8`） |
| | 想让智能体**更主动**（主动查记忆 / 连续失败给替代方案 / 工具按需加载省 token） | [`research/agent-capability-upgrade-design.md`](research/agent-capability-upgrade-design.md)（只读调研 + 方案 · 2026-10-14 · **未实施，待拍板**；外部趋势已核实：Meta 官方博客 / OpenAI 两份官方文档 / Agent Arena 榜 / DeepSeek 官方） |
| 想知道**当前架构的真实状态**（重复表达 / 多真相源 / 跨层耦合） | [`Architecture Reality Audit.md`](Architecture%20Reality%20Audit.md)（现状审计 · 2026-10-08 · **不是**设计稿） |
| 从 Harbor 自举版终端运行统一测试、看 TUI 人话报告 | PowerShell 中打开仓库，运行 `npm run harbor-test -- all --target=source`；安装版隔离自检用 `--target=installed`。空参数进入 TUI 选择，非交互环境加 `--plain`（入口 `tools/harbor-test.mjs`） |
| 查**同一个事实在几处被定义**（真相源 / 重复候选） | [`真相源地图.md`](真相源地图.md)（`npm run contracts` + `npm run dup`） |
| 想知道**重复/多真相源要怎么收敛**（真相源地图怎么做、分几步） | [`research/truth-map-design.md`](research/truth-map-design.md)（设计稿 · 2026-10-13 · 目标态） |
| 想知道**接下来还能往哪改**（改进候选 / 撞哪条红线 / 建议顺序） | [`改进清单.md`](改进清单.md)（内部自产 · 2026-10-13；**不是**外部核对账 —— 那份是 [`improvement-checklist.md`](improvement-checklist.md)） |
| 想知道**改进清单里哪些真的还没做**（逐条复核 + 用户数据写入审计 + 环复核） | [`可靠性改进现状复核报告.md`](可靠性改进现状复核报告.md)（只读复核 · 2026-10-13 · HEAD `9ade3de`） |
| 想知道**用户数据（任务/凭证/改动事务/会话）写盘会不会丢**（故障注入 + 修复方案） | [`E2用户数据保护-故障注入与修复设计.md`](E2用户数据保护-故障注入与修复设计.md)（故障注入 · 2026-10-13 · 只设计未改码） |
| 想知道 **UI 进度为什么卡死在「0/5」**（计划勾选 vs 真实执行两条链） | [`research/ui-phase5-progress-design.md`](research/ui-phase5-progress-design.md)（只读调研 + 方案 · 2026-10-13 · 待确认） |
| 想知道 **计划卡怎么动态显示真实执行进度**（PlanCard 加「已执行 X 步 · 已修改 Y 文件」· 改前/改后对比） | [`research/plan-card-dynamic-design.md`](research/plan-card-dynamic-design.md)（只读调研 + 设计 · 2026-10-13 · **未实施，待确认**） |
| 想知道**计划里的 `[ ]` 怎么靠工具亮起来**（打卡工具 `mark_step_done` · 状态存哪 / 不骗 strictMode / 硬禁区判定） | [`research/mark-step-done-design.md`](research/mark-step-done-design.md)（设计 · 2026-10-13 · **已实施**） |
| 想知道**正文排版怎么接近 ChatGPT**（自研 Markdown 渲染器 · 现状盘点 / 差异点 / 纯 CSS vs 结构变更） | [`research/phase7-typography-design.md`](research/phase7-typography-design.md)（只读调研 + 方案 · 2026-10-13 · **一期已实施（Commit 3473866）**；三项技术债见文末归档） |
| 想知道 **Phase 7 二期还能提升什么**（流式光标 / 回底按钮 / 工具图标 / Mermaid 放大 / 上下文可视化 · 哪些已存在、哪些是红线） | [`research/phase7-2-experience-design.md`](research/phase7-2-experience-design.md)（只读调研 + 方案 · 2026-10-13 · **批次 A 已实施（Commit 9fb23af）、批次 B/C 已决定不做**；光标与上下文圈**已存在**） |
| 要动**任务治理 / 模型路由 / 脑暴对齐 / 打卡制**（Phase 6 前置） | [`research/phase6-governance-routing-design.md`](research/phase6-governance-routing-design.md)（调研 · 参考 dsh-routing-suite · 2026-10-13 · ①②③ 已按批次 1-3 实施） |
| 想知道 **Phase 6 批次 1-2 做到哪了**（persona 路由 / 北极星锚定 · 改了什么 / 验证 / 遗留） | [`research/phase6-batch1-2-summary.md`](research/phase6-batch1-2-summary.md)（阶段总结 · 2026-10-13 · 已实施并提交） |
| 要**给 Phase 6 做真机验收 / 重新打包**（怎么点、看什么、没通过怎么反馈） | [`research/phase6-acceptance-checklist.md`](research/phase6-acceptance-checklist.md)（操作清单 + 归档待办 · 2026-10-13 · **真机验收通过，已进入日常观察期**） |
| 想知道**浏览器扩展做到哪了、还剩什么**（12 个模块进度 + 每条依据） | [`research/edge-extension-roadmap.md`](research/edge-extension-roadmap.md)（进度表 · 2026-10-20 · M01/M04/M05 完成，M02 小批 B/C + M03 阅读模式未做） |
| 想知道**扩展最近一批改了什么、踩了什么坑**（会话归属 / 站点黑名单 / 去重 / 真侧栏验收口径） | [`research/edge-extension-m06-m07-report.md`](research/edge-extension-m06-m07-report.md)（交付报告 · 2026-10-20 · 代码与自检已完成，**未提交**） |
| 要动**凭证库写入保护**（状态转换 / 提交一致性 / reset 出口 / 测试方案） | [`credentials写入保护-设计修订.md`](credentials写入保护-设计修订.md)（设计稿 · 2026-10-13 · 未实施） |
| 要动**凭证库写入保护**（状态转换 / 提交一致性 / reset 出口 / 测试方案） | [`credentials写入保护-设计修订.md`](credentials写入保护-设计修订.md)（设计稿 · 2026-10-13 · 未实施） |
| 想知道**凭证库损坏时怎么不丢 Key**（下一阶段设计） | [`credentials写入保护-设计.md`](credentials写入保护-设计.md)（设计稿 · 2026-10-13 · **未实施**，等批准） |
| 改架构前后要量「行为有没有变坏」 | [`Golden Tasks.md`](Golden%20Tasks.md)（跑什么）· [`Model Interaction Baseline.md`](Model%20Interaction%20Baseline.md)（量什么 + 基线） |
| 体检自己的数据（悬空引用 / 坏文件） | `npm run doctor`（说明在 [`数据模型.md`](数据模型.md) 末尾） |
| 看成功率 / 恢复率 / 工具失败率 | `npm run stats`（口径写在 `electron/core/run-stats.cjs` 文件头） |
| 做验收 / 上手试用 | [`验收核对-通用.md`](验收核对-通用.md) · [`试玩清单.md`](试玩清单.md) |
| 改验收判据 / 刚遇到「测试红了可它没错」 | [`判据自检.md`](判据自检.md)（三态 + 证据 + 反向用例） |
| 看性能口径与历史基准 | [`性能基准.md`](性能基准.md) |
| 看截图证据 | [`screenshots/`](screenshots/) |

## 进度台账（历史快照 —— **别当现状读**）

这几份是当时做那一批活留下的台账，记「那时候做到哪、踩了什么」。**停更即正常**：
它们记的是历史，不是当前版本。要**现状**看 [`../CHANGELOG.md`](../CHANGELOG.md)（代码侧）
和 [`交接清单.md`](交接清单.md)（环境与分工）；要**还缺什么**看 [`improvement-checklist.md`](improvement-checklist.md)。

| 台账 | 记的是哪一批 |
| --- | --- |
| [`改造任务/`](改造任务/)（含 `PROGRESS.md`） | 早期 P0/P1 改造对照；三份设计稿里的**规划名**与后来的实现名不同 |
| [`可靠性改进进度.md`](可靠性改进进度.md) | 可靠性那一批 |
| [`审计修复进度.md`](审计修复进度.md) · [`审计问题-来自测试机.md`](审计问题-来自测试机.md) | 安全 / 数据面审计那一批 |
| [`裁剪与字符限制修复.md`](裁剪与字符限制修复.md) · [`收尾与maxTokens拆分.md`](收尾与maxTokens拆分.md) · [`长内容处理改进.md`](长内容处理改进.md) · [`小尾巴清理.md`](小尾巴清理.md) | 上下文预算 / 裁剪 / 收尾那几批 |
| [`验证脚本检查清单.md`](验证脚本检查清单.md) | 临时验证脚本的写法与当时的清单 |
| [`自举开发流程.md`](自举开发流程.md) | 「在 Harbor 里开发 Harbor」的做法与当时记录 |
| [`验收核对-第16章.md`](验收核对-第16章.md) | 早期逐章验收记录 |

> ⚠️ 这些台账正文里点名的一次性脚本（`tmp/*.cjs`、`tmp/perf/*` 等）**多数已经不在仓库**
> —— `tmp/` 有卫生检查（条数 / 体积超限会被清）。要复现别照台账里的 `tmp/` 路径敲，
> 用仓库里的命令：`package.json` 的 `scripts` + [`发布检查.md`](发布检查.md)。

## 专题文档（写代码时会被引用）

这几份不是「给人随便翻」的，而是**代码/自检里点名引用的规范**，改相关代码时要一起看：

| 文档 | 谁在引它 |
| --- | --- |
| [`改造任务/`](改造任务/)（含 `PROGRESS.md`） | `AGENT.md` 真相源表、`electron/core/plugins.cjs`、自检组 67 |
| [`数据模型.md`](数据模型.md) · [`Runtime状态机.md`](Runtime状态机.md) | 改字段 / 改状态的人；`核心概念.md` 的下一层细节 |
| [`Runtime领域模型.md`](Runtime领域模型.md) | 改 Runtime 核心对象 / 加状态前的对照（目标态）；暂时**只被人读**，没有代码引用它 |
| [`Token优化实施与测试提示词.md`](Token优化实施与测试提示词.md) | 自检组 85（它按这份定义盯口径） |
| [`开工前澄清.md`](开工前澄清.md) | 自检组 `99`–`103`、`tools/acceptance-cases.mjs`（T9–T11 的判据）；改 `ask_user` / 澄清卡 / `clarify-config` 前先看它 |
| [`Agent开屏与彩蛋设计方案.md`](Agent开屏与彩蛋设计方案.md) | `src/types/index.ts`（性格层开关的设计依据） |

## 归档（`docs/archive/`）

**已经完成、且没有任何现行文档/代码依赖**的记录 —— 不删，挪进归档，找旧账来这里：

| 归档内容 | 为什么进去 |
| --- | --- |
| `研究/` | 阶段性技术调研，结论已经落进代码 |
| `测试记录/` | 带日期的测试记录 |
| `详细测试文档.md`、`个人Agent测试指南.md`、`个人Agent界面UI测试指南.md`、`AI测试工具清单与接入指南.md` | 当时的测试/工具说明，现在没有流程引用它们 |
| `token优化说明.md` | 与 `Token优化实施与测试提示词.md` 重复，后者才是自检组引的那份 |
| `开发笔记.md` | 早中期开发随手记（原 README，最后记到 09-25）。对外介绍归根 `README.md`、一次对话怎么走归 `架构.md`、坑归 `踩坑记录.md` —— **已无现行文档/代码引用**（2026-10-08 按「一进一出」随三份审计文档进门退役） |
| `夜间修复进度.md` | 夜间修 P0 那几轮的台账（自带日期 2026-10-03 夜）——**已无现行文档/代码引用**（2026-10-08 按「一进一出」随 `Memory设计.md` 进门退役） |
| `github-primer-palette.css` | 给已归档文档用的配色表 |

> **注意**：`CHANGELOG.md` 等**历史记录**里提到的路径可能已经进 `archive/`
> —— 那些记录按规矩不重写（当时的路径就是当时的事实），按文件名去 `archive/` 里找即可。

## 维护这份目录的四条规矩

1. **规矩只写一处**：新的「约束/流程」写进 `AGENT.md`（流程细节写 `开发流程.md`），
   别在 docs/ 里再加第三份 —— 复制就会漂，这个项目为此返工过。
2. **会涨的数字不写死**：内核自检项数、IPC 通道数这类每版都会变的计数，
   文档里说「看输出」（`AGENT.md` 硬约束 8，有机械检查）。
3. **不做完不算文档**：写「已修复 / 已完成」必须附可跑的验证或一次真实观察
   （`AGENT.md` 硬约束 7）。
4. **一进一出**：新增一份文档，就同时合并或退役一份旧的（退役走 `docs/archive/`，
   **只移不删**）—— 否则文档只会单向变多。这是约定，**没有机械检查**（文档数没有稳定口径）。
