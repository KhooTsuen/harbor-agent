# Phase 4 终极验收与清理报告

> 日期：2026-10-12 · 范围：UI Phase 4（视觉一致性与完整体验回归）
> 基线：`7613956`（Phase 3 收尾）→ 本报告落点 `5b99242`（批次 4）
> 配套：`docs/research/phase4-plan.md`（前置调研与计划说明）

---

## 0. 一句话结论

Phase 4 共 **5 个 commit**（1 个前置微任务 + 4 个批次），**只动展示层**：
没有碰 Runtime / IPC 事件契约 / 权限模型 / 任务台账 / 数据结构；
**防闪烁三件套（`useSmoothText` / `StableBlocks` / `parseIncremental`）整个 Phase 4 一行未动**（有 git 证据，见 §4）。
终极回归 `npm run verify` **退出码 0**：单测 183 文件 / 1629 用例、内核自检 4111/0、安全 83 PASS / 0 FAIL。

---

## 1. Phase 4 改动全览

| # | commit | 标题 | 文件 | 功能点 |
|---|---|---|---|---|
| — | `d1da64f` | 前置微任务（M1/M2/M3） | 6 | **M1** 一轮结束冲刷错误观察哨（`chat.cjs` 的 `finally`，独立 try-catch，**不碰 `loop.cjs`**）；**M2** `errors.ts` 时间戳注释更正为「毫秒数 / ISO 双形状兼容」；**M3** 一轮开始后延迟一次补刷任务台账（前端，不改 IPC） |
| 1 | `0e7ec27` | 批次 1 — 字体 token 同值不同名归并 | 3 | **只做真·同值那 1 处**：`Modal.tsx` 标题 `text-md`→`text-body`（16px/1.5 完全相同）。`text-sm`/`text-base` 共 32 处**记技术债、未动**（实测行高不同，见 §6） |
| 2 | `8bfa801` | 批次 2 — 落地字体 token 规范声明 | 3 | `design.ts`：`FONT_SIZE.meta` 14→**15**、`FONT_SIZE_DENSE` 13→**14**（贴现状）；`index.css`：只补注释、值一字不改；登记 12px 为「微号 / 紧凑 UI 专用层」 |
| 3 | `b84a629` | 批次 3 — 右栏宽度随根字号缩放 | 4 | 新增 `hooks/useRootFontScale.ts`（从**实际根字号**推倍率）+ `RightPanelHost` 内部等比换算；`App.tsx` 零改动 |
| 4 | `5b99242` | 批次 4 — 收敛 10/11px 硬编码字号 | 4 | `ProgressTimeline`×2 / `StatusBar`×1 / `ImageLightbox`×1 的 `text-[10px]`\|`text-[11px]` → `text-2xs`(12px) |

背景（本阶段之前的 UI 铺路，供对照）：`85f7202`（Phase 1）、`438ebd8`（Phase 2）、`7613956`（Phase 3）。

---

## 2. 视觉与响应式数据对照表

### 2.1 字号收敛

**① 设计声明 vs 实际渲染值（批次 2 对齐）**

| 层级 | token | 改前声明 | 改后声明 | 实际渲染值（未动） | 判定 |
|---|---|---|---|---|---|
| 辅助 | `meta` / `text-meta` | 14px | **15px** | 15px × 1.43 = 21.45px | 声明贴回现状 |
| 正文 | `body` / `text-body` | 16px | 16px | 16px × 1.5 = 24px | 不变 |
| 标题 | `title` / `text-title` | 24px | 24px | 24px × 1.33 = 31.92px | 不变 |
| 紧凑 | `FONT_SIZE_DENSE` / `text-dense` | 13 | **14** | 14px × 1.43 = 20.02px | 声明贴回现状 |
| 微号 | `text-2xs` | 未登记 | **登记为独立层** | 12px × 1.45 = 17.4px | 纳入正式定义 |

**② 硬编码字号（`text-[Npx]`）数量**

| 位置 | 改前 | 改后 |
|---|---|---|
| 目标组件（ProgressTimeline / StatusBar / ImageLightbox） | 4 | **0** |
| `boot/BootSequence.tsx`（拍板保留：启动动画独立世界） | 5 | 5 |
| **合计** | **9** | **5**（全部集中在 BootSequence） |
| `text-[0.9em]`（相对字号，排除项） | 2 | 2 |

> 结论：全项目**小于 12px 的固定字号只剩 BootSequence**。

**③ 字号 class 全项目分布（Phase 4 起点审计基线，660 行 / 150 文件）**

| class | 字号 | 行数 | 说明 |
|---|---|---|---|
| `text-2xs` | 12px | 395 | 大头（117 文件）—— 批次 2 已登记为正式层级 |
| `text-dense` | 14px | 143 | 紧凑层 |
| `text-xs` | 13px | 76 | 留待后续治理 |
| `text-sm` | 14px | 23 | **技术债**（行高 1.5 ≠ dense 的 1.43） |
| `text-base` | 15px | 10 | **技术债**（行高 1.55 ≠ meta 的 1.43） |
| `text-lg` / `text-md` / `text-xl` | 18/16/20 | 6 / 2 / 1 | 批次 1 已归并 1 处 md；其余是 Markdown 标题阶梯（排除项） |

### 2.2 窄窗口（320px / 900px）

改前 = 改后（批次 3 对这三档**逐行一致**，见 §2.4 判定）：

| 场景 | 主区宽度 | 可见标签 | 输入框宽度 | 文档横向溢出 |
|---|---|---|---|---|
| A 默认（1920×1040） | 1318px | 8/8 | 758px | false |
| **C 320×700** | **0px** | **2/8** | **28px** | **true** |
| G 900×700 | 298px | 8/8 | 264px | false |

> 320px 下：左栏 240 + 右栏 360 = 600 > 视口 → 主区被挤成 0、输入框只剩 28px、右栏 78% 在视口外。这是**窄窗自动折叠（未来专项）** 要解决的场景，Phase 4 只做「右栏随字号缩放」，未做窄窗折叠（拍板明确暂不通过 Runtime 设最小宽度解决）。

### 2.3 150% 缩放（批次 3 核心成果）

| 场景 | 右栏宽度 | 可见标签 | 文档横向溢出 | 视口外标签 |
|---|---|---|---|---|
| **E 1400×900 + 150%（改前）** | 360px | **7/8** | **true** | `["错误"]` |
| **E 1400×900 + 150%（改后）** | **540px** | **8/8** | **false** | `[]` |
| F 320×700 + 150%（改前 → 改后） | 360 → 540px | 1/8 → 1/8 | true → true | 见 §6 物理死局 |

### 2.4 默认缩放零位移（改前 = 改后，逐行一致）

`tmp/p4-probe.mjs` 的 A/B/C/D/G/H 六个默认缩放场景，改前改后输出**逐字符相同**（`p4-probe-b3-before.txt` vs `-after.txt`）。唯一变化的是 E（预期）与 F（同因）。

**唯一可复现的像素判据**：`p4-D-320-dialog.png`（设置弹窗）—— 批次 2 / 3 期间 sha256 恒为 `95ab20e23c32ea37`（未变）；批次 4 因**改造了状态栏头像字号**变为 `5c9e0f5ede10129a`，并已用**受控 A/B**（把 StatusBar 那一处改回 10px 重建 → 精确回到旧值）证明该差异**只来自目标组件**。

> ⚠️ 方法学结论（Phase 4 期间发现，已立为后续默认标准）：**主界面截图逐帧不稳定**（同构建连跑两次亦不同），不能当像素判据；判据应为「**探针 DOM 数值 + 行高直方图 + 弹窗截图 sha256**」三件套。

---

## 3. 终极回归验证（全链）

`npm run verify` —— **退出码 0**（完整日志 8035 行，`%TEMP%\p4-verify-final.log`）。

| 环节 | 结果 | 关键数字 |
|---|---|---|
| typecheck（tsc） | ✓ | 0 错误 |
| lint（src, eslint） | ✓ | 1 problem（**0 error / 1 warning**，为既有 `no-console` 告警） |
| lint:kernel（no-undef） | ✓ | 268 个 `.cjs` 无未定义标识符（允许清单为空） |
| typecheck:kernel | ✓ | 75 个 `.cjs` 与基线一致（基线 187 条，只许下调） |
| check:format（prettier） | ✓ | 全部匹配 |
| check:lines | ✓ | **1112 个文件全 ≤ 300 行** |
| check:rules | ✓ | 规范检查通过 |
| test:rules | ✓ | **tests 56 · pass 56 · fail 0**（duration 7468ms） |
| test:unit（vitest） | ✓ | **Test Files 183 passed (183) · Tests 1629 passed (1629)**（Duration 20.54s） |
| **npm test（内核自检）** | ✓ | **通过 4111 项，失败 0 项** |
| **npm run security** | ✓ | **PASS 83 · FAIL 0 · BLOCKED 0 · N/A 1 · NOT_RUN 0** |
| build（vite） | ✓ | `✓ built in 4.71s` |

---

## 4. 防闪烁三件套核查（Phase 4 期间一行未动）

```bash
git diff --stat 7613956 HEAD -- \
  src/hooks/useSmoothText.ts \
  src/components/chat/markdown/StreamingMarkdown.tsx \
  src/lib/markdown/incremental.ts
# → 无输出 = 一行未动
```

三个文件**最后一次被改**的 commit，全部落在 Phase 4 之前：

| 文件 | 最后一次改动 |
|---|---|
| `src/hooks/useSmoothText.ts`（摊平到帧） | `8c33a17`（P0-1/P0-3 修复，Phase 1 之前） |
| `src/components/chat/markdown/StreamingMarkdown.tsx`（`StableBlocks` 引用不变） | `7613956`（Phase 3 的 TailBlock 降级） |
| `src/lib/markdown/incremental.ts`（`parseIncremental`） | `08ae9ea`（更早） |

> 批次 3 的宽度缩放走的是 `RightPanelHost`（布局），批次 1/2/4 走的是 class 名与声明注释 —— 都不可能触及流式渲染链。

---

## 5. 清理记录（卫生红线）

| 目标 | 动作 | 结果 |
|---|---|---|
| `tmp/` 根 | 删 **652 项**（本任务 Phase 0–4 的脚本/探针/日志/截图/数据 + 历史会话遗留），按 `tmp/README.md` 的规矩**保留 6 项**：`README.md`（进仓库）、`organize2.cjs`（被 check-rules 提示与单测点名）、README 点名的 4 个探针 | 658 → **6 项**（原超上限 500） |
| `dist-portable/Harbor/data` | 整个删除（Phase 0–4 的隔离假模型测试数据） | 已不存在 |
| `data/unit-test-data` | 删除（vitest 数据隔离目录，`testDataIsolation.test.ts` 钉着它） | 已不存在 |
| `tmp/_vsum.cjs` / `_vsum.txt` | 本报告取证用的临时解析脚本 | 已删 |

**未清（有理由）**：
- `E:\CodexWorkbench\data\`（除 `unit-test-data`）—— 里面是 `config.json` / `credentials.json` / `avatars` / `projects.json` / `schedules.json` 一类**开发用档案**，不是隔离测试数据；**保守起见不动**。如确认可删请明示。
- `dist-portable/*.zip`（`harbor-1.20.0 … 1.30.0-beta.16`）—— 历史**发布产物**，非临时数据。

---

## 6. 遗留问题与已知边界

| # | 遗留 | 原因 | 未来处理路径 |
|---|---|---|---|
| 1 | **320px + 150% 下可见标签 1/8（物理死局）** | 左栏 240 + 右栏 540 = 780 > 320，桌面端极端叠加 | 另开专项：**极窄窗口自动折叠侧栏**（方案 (b)）；`setMinimumSize`（方案 (a)）暂不报批 |
| 2 | **32 处 `text-sm`/`text-base` 行高差异技术债** | `sm`(14/1.5)、`base`(15/1.55) 与 `dense`(14/1.43)、`meta`(15/1.43) **字号同、行高不同**，归并必改行高（每行 1–1.8px），与「零视觉变化」红线冲突 | 归入未来的**行高专项治理**（先定统一行高口径，再谈归并）。标记已写进 `tailwind.config.js` 的 fontSize 段注释 |
| 3 | 左侧栏宽度**未**随根字号缩放 | 拍板时它是「甚至左侧栏」的可选项；本轮取最小改动以守「默认态零位移」 | 如需要，按 `RightPanelHost` 同一手法加（改动小） |
| 4 | `App.tsx` 懒加载 `Suspense` 占位块宽度未缩放 | `App.tsx` 已 298/300 行，动它有破红线风险 | 仅懒加载一瞬可见，低优先 |
| 5 | `boot/BootSequence.tsx` 保留 5 处 10/11px | 拍板明确：启动动画是独立世界，内联 px 合理 | 保持 |
| 6 | M3 的 `setTimeout(refresh, 2000)` 用**启发值 2s** | 真机对过数（台账在 t≈2.5s 可见），但仍是启发值 | 若真机出现滞后，改事件驱动 |
| 7 | M1 落点：`chat.cjs` 的 `finally`（**未触 `loop.cjs`**） | 硬禁区 §3.8；自检已钉死「有 / 独立 try-catch / 不在 loop.cjs」 | 保持 |

**NOT_TESTED（如实标记）**：系统 DPI 缩放（非应用内 fontScale）、键盘导航 / 屏幕阅读器等无障碍实测 —— 本轮未做，`E:\CodexWorkbench\docs\research\` 各报告已标。

---

## 7. 红线与约束核对（逐条）

| 红线 | 结果 | 证据 |
|---|---|---|
| 不触 Runtime / 任务状态机 | ✓ | Phase 4 改动全在 `src/components` / `src/hooks` / `src/constants` / `src/index.css` / `electron/handlers/chat.cjs` 的收尾冲刷（非状态机）、`electron/core/prompt-*.cjs`（Phase 3） |
| 不触 IPC 通道 / 事件契约 | ✓ | 未动 `electron/ipc-channels.cjs`；自检 `134-ipc-channels` 绿 |
| 不触权限模型 / 安全文件 | ✓ | 未动 `risk.cjs` / `capability.cjs` / `credentials.cjs` / `redact.cjs` / `navigation-policy.cjs` / `net-policy.cjs` |
| 不触任务台账 / 数据结构 | ✓ | 宽度仍按用户选的 px 持久化（缩放只在显示层换算），**无需迁移**；`data/` 字段无增删 |
| 保留所有诊断入口（错误 / 任务 / 日志 / 授权） | ✓ | 右栏 8 标签一个不减（批次 2/3 未动标签结构）；错误面板、任务中心、日志、授权卡片均在 |
| 防闪烁三件套一行未动 | ✓ | 见 §4（git diff 无输出） |
| 单文件 ≤ 300 行 | ✓ | check:lines：1112 文件全 ≤300 |
| 改了代码写 CHANGELOG | ✓ | 每个 commit 都带 CHANGELOG 条目（钩子校验） |
| 数据只落 `data/`、密钥不落盘 | ✓ | 未新增落盘路径；密钥扫描绿 |
| 不引新依赖 | ✓ | `package.json` / `package-lock.json` 两侧一致（36 依赖） |

---

## 8. 证据索引

| 证据 | 位置 |
|---|---|
| verify 完整日志（8035 行） | `%TEMP%\p4-verify-final.log` |
| 窄窗口/缩放探针 | `tmp/p4-probe.mjs`（本轮清理时按卫生红线删除；如需可重建） |
| 改前 / 改后探针快照 | 报告 §2 的对照表（批次 3 提交前后各跑一次，逐行比对） |
| 防闪烁三件套核查 | 本文 §4（可复现的命令） |

---

## 9. 收尾

- 本报告随 Phase 4 批次 5 一起提交（**只加文档，不改代码**）。
- 提交后 `git push` 到 `origin/main`，并核对远端 HEAD 与本地一致、落后 0 个 commit。
