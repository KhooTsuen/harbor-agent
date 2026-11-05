# docs/research/ —— 哪份还有效

> 这个目录装的是**调研 / 设计 / 阶段报告**，不是现状说明书。
> 现状看 [`../README.md`](../README.md) 那张表；这里只回答一件事：**这些调研 / 设计 / 阶段报告里，哪份还能拿来当依据。**
> 份数不写死在这里（会漂）—— 要数就 `dir /b docs\research\*.md`。
>
> 分档依据：按文件名在仓库内 `.md` / `.mjs` / `.cjs` / `.ts` / `.tsx` 里搜引用
> （排除 `CHANGELOG.md` —— 它是历史记录，按规矩不重写，提到某份**不构成**「这份还有效」）。
> 重新核对用：`findstr /s /n /i "文件名" *.md *.ts *.tsx`（在仓库根敲）。
> 引用关系会随代码改动漂，**改代码前顺手核一下你想引的那份还在不在 A 档**。

## A 档：被代码 / 自检 / 测试直接引用 —— 改对应代码前必读

这一档的文档是**判据来源**，不是背景资料。代码注释或测试文件里点名引了它，
改那里的行为时要一起改，否则文档和判据会各说各话。

| 文档 | 谁在引它 |
| --- | --- |
| [`codex-cli-adapter-design.md`](codex-cli-adapter-design.md) | `electron/core/codex-cli.cjs`、`codex-jsonl.cjs`、`config-codex-preset.cjs`、`provider-kinds.cjs`、`src/components/settings/providers/CodexCliCard.tsx`、根 `README.md` |
| [`edge-extension-host-stdout-experiments.md`](edge-extension-host-stdout-experiments.md) | `electron/native-host.cjs`、`harbor-edge/lib/ext-stage.cjs`、`harbor-edge/tools/accept-phase2.cjs` |
| [`edge-extension-m04-design.md`](edge-extension-m04-design.md) | `harbor-edge/tools/accept-m04a.cjs` |
| [`mark-step-done-design.md`](mark-step-done-design.md) | `electron/core/tools/mark_step_done.cjs`、自检组 `145` |
| [`memory-layered-recall-design.md`](memory-layered-recall-design.md) | `electron/core/tools/memory_search.cjs`、自检组 `146` |
| [`phase5-turn-lifecycle-design.md`](phase5-turn-lifecycle-design.md) | `electron/core/tools/run_shell.cjs`、自检组 `140`、`src/stores/__tests__/turnLifecycle.test.ts`、`src/stores/thread/__tests__/turnLifecycleNails.test.ts` |
| [`phase6-governance-routing-design.md`](phase6-governance-routing-design.md) | `electron/core/mode-router.cjs`、自检组 `142`、`143` |
| [`phase7-typography-design.md`](phase7-typography-design.md) | `src/components/chat/__tests__/markdownTypography.test.tsx` |
| [`plan-card-dynamic-design.md`](plan-card-dynamic-design.md) | `src/components/chat/PlanCard.tsx`、`taskCenterModel.ts`、`planCard.test.ts`、`planCardDynamic.test.tsx` |
| [`truth-map-design.md`](truth-map-design.md) | `scripts/contracts.mjs`、`scripts/dup-scan.mjs`、`../真相源地图.md`、`../改进清单.md` |
| [`ui-phase5-progress-design.md`](ui-phase5-progress-design.md) | `electron/core/backup-scan.cjs`、`src/components/chat/taskCenterModel.ts`、`taskCenter.test.ts` |

## B 档：被 `docs/` 顶层现行文档引用 —— 结论仍在用

| 文档 | 谁在引它 |
| --- | --- |
| [`agent-capability-upgrade-design.md`](agent-capability-upgrade-design.md) | `../README.md`（**未实施，待拍板**） |
| [`toolbox-map-design.md`](toolbox-map-design.md) | `../README.md`（已实施：`core/tool-map.cjs`） |
| [`phase7-2-experience-design.md`](phase7-2-experience-design.md) | `../README.md`（批次 A 已实施；B/C 决定不做） |
| [`phase6-acceptance-checklist.md`](phase6-acceptance-checklist.md) | `../README.md`（真机验收已通过） |
| [`phase6-batch1-2-summary.md`](phase6-batch1-2-summary.md) | `../README.md` |
| [`edge-extension-roadmap.md`](edge-extension-roadmap.md) | `../README.md`、`harbor-edge/README.md`（**扩展进度的入口**） |
| [`edge-extension-m06-m07-report.md`](edge-extension-m06-m07-report.md) | `../README.md`、`edge-extension-roadmap.md` |
| [`harbor-ui-research-summary.md`](harbor-ui-research-summary.md) | `../改进清单.md`（C 系列界面项的来源） |
| [`phase1-stage-summary.md`](phase1-stage-summary.md) · [`phase2-implementation-report.md`](phase2-implementation-report.md) · [`phase4-final-report.md`](phase4-final-report.md) | `../可靠性改进现状复核报告.md`（复核时的依据） |
| [`a-display-pricing-design.md`](a-display-pricing-design.md) · [`usage-stats-enhancement-design.md`](usage-stats-enhancement-design.md) | `../cost-optimization-log.md` |
| [`harbor-test-design-2026-10-29.md`](harbor-test-design-2026-10-29.md) | `../README.md`（统一测试工具入口行）；本目录两份验收记录（`harbor-test-acceptance-batch1/2`）。**改 `tools/harbor-test/` 前看 §2 边界与 §4 判定口径**；§7 的文件清单是当时计划，不是现行规范 |

## C 档：只在本目录内部互引 —— 研究过程记录

结论已经落进代码或上层文档，这些留下的是**当时怎么想的**。要查「为什么最后这么做」再进来，
平时不用读。按两条链分组：

- **Edge 扩展链**（13 份）：`edge-extension-m02-design.md`、`edge-extension-m03-design.md`、
  `edge-extension-m04c-m05-design.md`、`edge-extension-m04c-m05-report.md`、
  `edge-extension-phase0-report.md`、`edge-extension-phase1a-report.md`、
  `edge-extension-phase1b-report.md`、`edge-extension-phase1c2-report.md`、
  `edge-extension-phase2-report.md`、`edge-extension-phase3a-design.md`、
  `edge-extension-phase3a-report.md`、`edge-extension-phase3b-design.md`、
  `edge-extension-p0-handoff-2026-10-20.md`。
  入口仍是 A/B 档的 `edge-extension-roadmap.md`。
- **UI 调研链**（2026-10 那批，8 份）：`ui-baseline.md`、`ui-component-map.md`、
  `ui-design-system-audit.md`、`ui-event-trace.md`、`ui-noise-audit.md`、`ui-questions-for-owner.md`、
  `ui-safety-visibility.md`、`ui-ux-golden-tasks.md`。
  汇总在 `harbor-ui-research-summary.md`（B 档）。
- **UI Phase 链**（6 份）：`phase0-real-task-report.md`、`phase1-implementation-report.md`、
  `phase2-improvement-plan.md`、`phase3-design.md`、`phase3-implementation-report.md`、
  `phase4-plan.md`。
- **统一测试工具链**（2 份）：`harbor-test-acceptance-batch1-2026-10-29.md`、
  `harbor-test-acceptance-batch2-2026-10-29.md`。入口是 B 档的 `harbor-test-design-2026-10-29.md`；
  这两份记的是**当时实跑到的数字**，复跑用 `npm run harbor-test`。

## D 档：零引用 —— 没有任何文件提到它

这 11 份**没有任何代码、测试或文档指向**。不删（历史有用），但**别拿它当依据** ——
里面的结论要么已经过时，要么早就落进别处了。它们也是「一进一出」退役时的首选候选。

| 文档 | 内容 | 备注 |
| --- | --- | --- |
| [`browser-anti-detection-design.md`](browser-anti-detection-design.md) | 内置浏览器反拦截调研 | 未实施，也没进改进清单 |
| [`edge-extension-design.md`](edge-extension-design.md) | 扩展总调研（最早的起点） | 已被 roadmap + 各 phase 报告取代 |
| [`edge-extension-tools-design.md`](edge-extension-tools-design.md) · [`edge-extension-tools-report.md`](edge-extension-tools-report.md) | Edge 能力接成 Harbor 工具的方案与报告 | 已落地，无引用回指 |
| [`edge-extension-m03-report.md`](edge-extension-m03-report.md) | M03 网页感知交付报告 | 同上 |
| [`edge-extension-m04b-report.md`](edge-extension-m04b-report.md) | M04 第 2 步交付报告 | 同上 |
| [`edge-extension-phase1c1-report.md`](edge-extension-phase1c1-report.md) | 扩展构建链路验证报告 | 同上 |
| [`edge-extension-phase3b-report.md`](edge-extension-phase3b-report.md) · [`edge-extension-phase3b-layout-report.md`](edge-extension-phase3b-layout-report.md) | 侧边栏发消息 / 布局返工 | 同上 |
| [`edge-extension-phase3c-report.md`](edge-extension-phase3c-report.md) | 侧边栏点选会话 | 同上 |
| [`成熟方案复用评估-2026-11-02.md`](成熟方案复用评估-2026-11-02.md) | 五项成熟方案的复用评估 | 评估完就没下文，**待定** |
| [`harbor-agent-audit-2026-10-29.md`](harbor-agent-audit-2026-10-29.md) | 2026-10-29 的现状审计 + 四阶段开发清单 | 已被 [`../改进清单.md`](../改进清单.md) / [`../improvement-checklist.md`](../improvement-checklist.md) 取代 |
| [`self-correction-blueprint-2026-11-02.md`](self-correction-blueprint-2026-11-02.md) | 全场景自我纠错 / ID 关联 / 审批档位实施蓝图 | **设计蓝图，未核实施工进度**；别当现行规范 |

## 维护

新增调研 / 报告先登记到 [`../README.md`](../README.md) 主表，再回来把这里的分档补上。
**A 档只能靠人盯**：代码注释里引了某份文档，没有任何机械检查保证这条引用还有效
（`check-rules` 不扫 md 之间的链接）。改 A 档涉及的代码时，顺手确认那份文档还在。
