# 侧边栏布局返工 · 交付报告

> 2026-10-16。用户指出理解偏差：侧边栏被做成了「上中下三段」（状态 / **常驻**会话列表 /
> 对话区），而期望是对齐 ChatGPT 插件那种形态。本轮**只改布局**，3b 的逻辑一行未动。

---

## 1. 改了什么

| 文件 | 动作 | 说明 |
|---|---|---|
| `harbor-edge/src/sidepanel/SessionList.tsx` | **删** | 常驻区块没了；取数逻辑搬进抽屉 |
| `harbor-edge/src/sidepanel/SessionDrawer.tsx` | **新增** 209 行 | 点顶栏 ▾ 才挂载的覆盖式抽屉（`absolute inset-0`） |
| `harbor-edge/src/sidepanel/ReadPageButton.tsx` | **新增** 96 行 | 「读当前页」压成输入框左端的图标按钮 |
| `harbor-edge/src/sidepanel/App.tsx` | 改 255 行 | 顶栏一行（状态点 · 标题▾ · 新建 · 设置）+ 对话区；删常驻列表与「读当前页」区块 |
| `harbor-edge/src/sidepanel/ChatPanel.tsx` | 改 303 行 | 消息区外层 `relative overflow-hidden`，抽屉装在里面；状态行上提到 App |
| `harbor-edge/src/sidepanel/sidepanel.css` | 改 | 加 `drawer-in` 动画（自上滑下），遵守全局 `data-animations='off'` |
| `harbor-edge/lib/ext-probe-panel.cjs` | **新增** 105 行 | 面板 DOM 锚点（从 `ext-probe.cjs` 拆出；调用点不变） |
| `harbor-edge/lib/ext-probe.cjs` | 改 244 行 | 再导出上面那份；`CLICK_READ_EXPR` 改按 `aria-label` 找 |
| `harbor-edge/tools/accept-phase2.cjs` | 改 | ⑨ 改按 `aria-label` 找（原来按按钮文字 → 返工后必红） |
| `harbor-edge/tools/accept-phase3a.cjs` | 改 302 行 | 加 ⑥b（会话列表**默认不常驻**）+ 读列表前先点开抽屉 |
| `harbor-edge/tools/accept-phase3b.cjs` | 改 | `PANEL_READY` 改判据；**修一处验收脚本自身的环境依赖 bug**（见 §4） |
| `scripts/selftest/groups/158-ext-chat.mjs` | 改 183 行 | +6 条布局断言（含「验收锚点与渲染层一致」） |
| `CHANGELOG.md` / `harbor-edge/README.md` | 改 | 记账 |

**`electron/**` 与 `src/**`（主应用）零改动** · 零新依赖 · 单文件 ≤300（产品源码）✓

---

## 2. 布局实测（400×812，真 Chrome + CDP 量的）

| 项 | 值 |
|---|---|
| 顶栏 | y=0，**41px** |
| **对话区** | y=41，**682px**（改前被常驻列表压到只剩几条消息） |
| 输入框 | bottom=766（视口 812，下方是那行说明文字） |
| 会话列表（收起） | **DOM 里没有** ✓ |
| 抽屉（点 ▾ 后） | `{x:0, y:41, w:400, h:682}` = **与消息区完全同位置**（覆盖，不是并排） |
| 抽屉 bottom | 723 ≤ 输入框顶 738 → **不盖输入框** ✓ |

几何探针 **10/10**（`tmp/_layout_probe.mjs`，跑完即删）。

---

## 3. 三项回归验收（布局改完复跑，全绿）

| 脚本 | 结果 | 说明 |
|---|---|---|
| `accept-phase2.cjs` | **18/18** | 「读当前页」→ 包装 → 落会话 → 审计，全通 |
| `accept-phase3a.cjs` | **14/14** | 含新判据「会话列表默认不常驻」；`NO_HARBOR` / `TIMEOUT` 仍给人话 |
| `accept-phase3b.cjs` | **15/15** | **流式 12 片逐片到 · 忙时被拒 · assistant 落盘 · 主窗口同一条** |
| 自检 | **4723 / 0** | +6 条布局断言 |
| 内核 | lint / typecheck 与基线一致 | — |

> ★ 3b 那 15 条是本轮**最该看的回归**：它证明「抽屉 + 图标按钮」这一通改，
> **没碰**流式、落盘、SESSION_BUSY 任何一步。

---

## 4. 过程中发现并修的**真问题**

### ① 验收脚本会「静默失效」（本轮最大风险，已全部堵上）

「读当前页」原来是**带文字**的按钮，三个判据都按 `textContent` 找它。改布局后它成了**图标按钮
（没有文字）**→ 按文字找**永远不成立**，而脚本**照跑不误**（表现为假红/假绿，不是报错）。

| 位置 | 改法 |
|---|---|
| `ext-probe-panel.cjs` 的 `CLICK_READ_EXPR` | 改按 `aria-label="读当前页"` |
| `accept-phase2.cjs` ⑨ | 同上 |
| `accept-phase3b.cjs` 的 `PANEL_READY` | 拆成 `{send, read, title}` 三条，`read` 按 aria-label |

**同一族的第二个坑**：`STATUS_TEXT_EXPR` 取文档里**第一个** `[role=status][aria-live=polite]`。
我在顶栏加了连接状态文字 —— 若给它带 `aria-live`，就会把状态行那份顶掉，
accept-phase2/3a 的「读当前页给人话」当场变假红（**看起来像产品坏了**）。
处理：顶栏的连接文字是**纯文本**、抽屉里的提示用 `role=alert`，各自文件头写明；
自检加一条断言钉死「对话区恰好一个 `role=status`、顶栏一个都没有」。

### ② `accept-phase3b.cjs` 自身的环境依赖 bug（本轮复跑红了两次）

**现象**：⑥b「连上的是我装的 host」FAIL + 后续流式全无输出。
**根因**：Edge 一起来，SW 就按**当时**的注册表 `connectNative`；等脚本读到 extId 再改注册表，
**它已经连上旧 host 了** —— 而**换注册表不会让它重连**。上一版的修法（「杀掉指向 repo 路径的
host」）漏掉了「旧注册表指向 dist-portable」这种情形（本轮就是这么红的）。
**修法**：**起 Edge 之前先摘注册表**（`S.regDel`）→ SW 首次必失败 → 装好隔离 host 后它按
`RECONNECT_MS=3000` 自己重连。`killStrayHosts()` 删除。
⚠️ **副作用**：若此刻正开着 Edge 用扩展，会短暂显示「未连接」，脚本 `finally` 恢复注册表原值。

### ③ 我自己写的一条断言被注释误伤

新断言写的是 `!/aria-live/.test(appSrc)`，而 `App.tsx` 文件头**正好在解释这件事**
（"顶栏里绝不能出现 `[role=status][aria-live=polite]`"）→ 被自己的注释判红。
改成匹配带引号的属性形态 `aria-live="polite"`。（与 156 那次「注释里提到 `pendingRead`」同族。）

---

## 5. 我拍的默认（你要改就说，都是十几行的事）

| # | 我选了 | 为什么 / 改起来多贵 |
|---|---|---|
| 1 | 顶栏放 `● 连接状态` + `[标题 ▾]` + `＋` + `⚙` | 你要的形态里有「← + ▾」（返回到哪一步？侧边栏没上一页）。用状态点替代 ←，信息量更大 |
| 2 | **不加**「读当前页」到顶栏 | 顶栏会被挤爆（400px）。挪到输入框左端当图标 —— 离「发消息」近，都是输入动作 |
| 3 | 设置用齿轮**图标**，不写「设置」 | 图标省宽度，且你写的就是「图标」。`aria-label="设置"` 保住可访问名 |
| 4 | 列表项**不可点** | 点选 = 3c，而 3b 起会话由 Harbor 主窗口决定。做成能点却没反应更糟。3c 时把它们变 `button` 即可（**渲染层**够） |
| 5 | 顶栏标题 = 从会话列表快照里查标题 | 不让 `session-active` 回标题是为了**不动 SW**（本轮边界）。代价：Harbor 刚点「新建对话」时 active 是临时 id（`pending_…`），快照里查不到 → 显示成「Harbor」 |

---

## 6. 建议的下一步（你定）

1. **3c**：抽屉里的条目变可点 → 切换侧边栏对话。需要新 kind（`session:select`）+ SW/host 透传 ——
   命中硬禁区，要单独批。
2. 顶栏 `＋`（新建对话）与 `⚙`（设置）：同样是新 kind，或干脆去掉（本轮是占位，点了只提示一句）。

---

## 7. 是否违反约束

零新依赖 ✓ · 不碰 Runtime / 严格模式 / 防闪烁 / `hardenWebview` / 工具系统 / 权限模型 ✓ ·
`main.cjs` **0 行** ✓ · 不新增 IPC 通道 ✓ · 未做 3c / Phase 4 ✓ ·
产品源码单文件 ≤300 ✓（`accept-phase2/3a/3b.cjs` 是 `tools/` 验收资产：302 / 367 行，
`line-limit.mjs` 的本仓口径**不覆盖** `harbor-edge/**`；367 行那条是 3b 就有的，已记在 3b 报告 ·
CHANGELOG ✓
