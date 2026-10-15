# Phase 1c 第二步：真侧边栏 UI（骨架 + 连接状态）

> 2026-10-15 · 承接《Phase 1c 第一步：扩展构建链路验证报告》。
> 本轮**不含**对话功能（Phase 3）、**不含**读页面（Phase 2）。

## 0. 一句话结论

**侧边栏真的出现了，并且显示「已连接」** —— 这个「已连接」不是写死的文案，
而是 **真 Edge → 真扩展 → 真 native host → 真 `Harbor.exe` 回 `{"pong":1}`** 这条链
跑通之后才推出来的。真机验收 **10/10 通过**。

| 项 | 结果 |
|---|---|
| 构建 | ✅ CSS 20.23 kB / JS 166.10 kB（引入 `Button` 后比第一步大，见 §4） |
| 23 个关键类全编出（含跨目录 `Button` 的 9 个） | ✅ 缺失 **0** |
| **真机端到端** | ✅ **10/10** |
| 视觉与主应用一致 | ✅ 背景/文字色/状态点/按钮文字色**逐个对着源码变量核过** |
| `npm run verify` | ✅ 全绿 |

---

## 1. 用户拍板过的两件事

1. **「共享 CSS」不拆，先整份 import** —— 理由：拆会动 `src/**`（硬禁区），
   且当前体积可接受、收益在没写真 UI 前不明确。→ 本步按这个办（`sidepanel.css` 两行 `@import`）。
2. **真扩展新建 `harbor-edge/extension/`，探针 `harbor-edge/ext/` 一字不动** ——
   探针是 Phase 1b 的验收资产（`accept-host.cjs` 靠它上报），保留 = 不破坏已有回归资产；
   `REPORT_URL` 自然不会带到真扩展（真扩展是**新文件**，没有那段代码）。

   > 注：第三步原话「删除 Phase 1b 探针里硬编码的 REPORT_URL」与边界红线
   > 「探针扩展保留不动」**互相冲突**（那条 URL 就在探针的 `service-worker.js` 里）。
   > 按用户选的 A 方案：真扩展里**没有** REPORT_URL，探针原样保留。

---

## 2. 新增/改动的文件

### 新增

| 文件 | 行数 | 是什么 |
|---|---|---|
| `harbor-edge/extension/manifest.json` | 16 | 真扩展清单（MV3） |
| `harbor-edge/extension/service-worker.js` | 130 | **唯一**持 native port 的地方（连 / 断线重连 / 状态广播 / 点图标开面板） |
| `harbor-edge/src/sidepanel/App.tsx` | 164 | 侧边栏 UI（连接状态 + 占位 + 输入框占位） |
| `harbor-edge/tools/accept-extension.cjs` | 191 | 第二步端到端验收 |
| `harbor-edge/README.md` | 88 | 目录说明 + **「禁止固定毫秒等待」硬规则** |

### 改动

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `vite.config.ext.ts` | 加 `publicDir`（→ `extension/`）+ `@` 别名 | 让 `manifest.json` / SW **原样**进产物；让侧边栏能 import 主应用组件 |
| `postcss.config.js` | `content` 加 `./src/components/ui/Button.tsx` | Tailwind 是**文本扫描**；不扫到那份文件 → `bg-cta` 等类编不出来 |
| `src/sidepanel/sidepanel.css` | 加 `@import theme-primer-dark.css` | 与主应用 `main.tsx` **同序**（那是实际默认主题，见 §3） |
| `src/sidepanel/main.tsx` | 渲染真 `App`（不再是一句 Hello） | 第一步只是构建链路验证 |
| `lib/driver.cjs` | 加 `openTab` / `pollEval` | 两个验收脚本共用；CDP 代码写两份迟早漂（硬约束 #9） |
| `tools/read-extid.cjs` | 加 `--ext=<目录>` | 原来写死读探针目录 —— 装真扩展时必须读**真扩展**的 ID |
| `install-host.cmd` | `EXT_DIR` 指向 `dist\sidepanel`；加产物存在性检查；调 read-extid 带 `--ext` | 同上；且产物没构建时要**明确报错**而不是装出一个错 ID |

---

## 3. ★ 关键：视觉「与主应用一致」不是照抄样式，是走同一套东西

侧边栏的样式来源只有三处，**没有一处是重抄的值**：

```
tailwind.config.js (theme)          ← postcss.config.js 继承（同一份对象）
src/index.css                        ← CSS 变量 ①②③
src/styles/theme-primer-dark.css     ← 主应用**实际**的默认主题（在 index.css 之后覆盖）
src/components/ui/Button.tsx         ← 直接 import 主应用那个组件
```

### 这一步逮到我自己的一个判据错误（值得记下来）

第一次跑验收，⑤ 报 **FAIL**：我断言背景应是 `rgb(16,16,16)`，实际是 `rgb(13,17,23)`。

我**没有直接改判据**，而是回去查源码 —— 结果发现**判据是我写错的**：

| 实测值 | 出处（源码行） |
|---|---|
| `rgb(13, 17, 23)` = `#0d1117` | `theme-primer-dark.css:83` `--bg-default: #0d1117` → `:125 --bg-canvas: var(--bg-default)` |
| `rgb(240, 246, 252)` = `#f0f6fc` | `:87 --fg-default` → `:142 --text-primary` |
| `rgb(63, 185, 80)` = `#3fb950` | `:98 --success-fg` → `:164 --success` |
| `rgb(145, 152, 161)` = `#9198a1` | `:88 --fg-muted` → `:143 --text-secondary` |

`rgb(16,16,16)` 是 `src/index.css` 里 **default 主题**的值（`#101010`）——
但主应用 `main.tsx` 在 index.css **之后**又引了 `theme-primer-dark.css`，
把 `--bg-canvas` 覆盖成 `#0d1117`。**所以主应用自己渲染的就是 `#0d1117`。**

→ 判据改成 `rgb(13,17,23)` 之后通过，而且它**比原来更有意义**：
它证明的是「扩展的配色层次和主应用**完全一致**」，不只是「走了一套 token」。

（另修一处太弱的断言：⑧ 原来只看 Button「有没有背景色」，可 ghost 变体本来就
`bg-transparent` —— 透明也放行。改成看**文字色** `#9198a1`。）

---

## 4. manifest 权限（最小化，按用户要求）

```json
"permissions": ["nativeMessaging", "sidePanel", "storage"]
```

| 权限 | 为什么必须 |
|---|---|
| `nativeMessaging` | 与 Harbor native host 通信 |
| `sidePanel` | 侧边栏容器 |
| `storage` | **SW 会被杀**（MV3 空闲 30 秒终止）→ 连接状态不能只放内存，得有快照 |

**明确没加**（都是后续阶段的事，本步不许加）：`scripting` / `activeTab` / `host_permissions` / `tabs`。

---

## 5. Service Worker 的职责边界

**只做四件**：① 持 native port（断了按 `RECONNECT_MS` 重连）；
② 维护状态（`chrome.storage` 快照 + `sendMessage` 广播）；③ 点图标开侧边栏；④ 应答「来一次 ping」。

**不做**：不持业务状态、不做 UI 逻辑、不拼 Agent 逻辑。

**连线判据的位置**（这点重要）：`port.onMessage` 里 —— **host 真的回了消息**才算「已连接」。
`RECONNECT_MS` 是**重连节奏**，不是「等 N 毫秒就认为连上了」—— 后者正是 README 里禁的那种写法。

---

## 6. 真机验收（10/10）

链路：真 Edge 加载 `dist/sidepanel` → SW `connectNative` → 注册表 → `harbor-host.cmd`
→ `ELECTRON_RUN_AS_NODE=1` + `Harbor.exe` + `native-host.cjs` → 回 `{"pong":1}` → SW 广播 → DOM。

```
PASS  ① 注册表已写（指向 com.harbor.agent 的清单）      -- rc=0
PASS  ② 侧边栏页面加载（DOM 有内容）                    -- 节点数=27
PASS  ③ ★ 显示「已连接」（端到端：host 真回了消息）      -- connected=true 等了 2 轮
PASS  ④ 状态点文案 = 已连接                             -- aria-label="已连接"
PASS  ⑤ ★ 背景 == Primer 深色 --bg-canvas（#0d1117）    -- rgb(13, 17, 23)
PASS  ⑤b ★ 文字色 == --text-primary（#f0f6fc）          -- rgb(240, 246, 252)
PASS  ⑥ ★ 状态点 == --success（#3fb950）                -- rgb(63, 185, 80)
PASS  ⑦ 输入框是占位态（disabled）                       -- true / true
PASS  ⑧ ★ 复用的 Button 文字色 == --text-secondary      -- rgb(145, 152, 161)
PASS  ⑨ 外部样式表被加载                                -- stylesheets=1
```

**为什么 ③ 是硬判据**：那两个字只能由「host 真回了消息」推出来。中间任何一环断
（注册表没写 / host 没起 / 协议失准 / SW 没连）都会停在「未连接」。
它不是「界面看起来对不对」，是端到端。

### 与第一步的差别

第一步是**把构建产物包成临时扩展**验「能不能加载」；这一步是
**装真 host + 加载真扩展 + 验真的连上了**。所以脚本里多了装/卸 host 两段，
收尾顺序也讲究：**先杀 Edge → 再卸 host → 再删 profile**。

---

## 7. 关于 `harbor-edge/README.md`（用户要求固化）

按用户要求把「**禁止固定毫秒等待当就绪判据**」写成了仓库里的硬规则，含：

- 两次真实栽跟头的记录（Phase 1b `read-extid` / Phase 1c 第一步 `accept-sidepanel`），带症状与修法；
- **为什么固定等待必错**（等够 = 每次白等；不够 = 偶发假失败，而假失败会让人开始怀疑代码）；
- 正确写法（轮询 + 超时上限）的代码对照；
- **适用范围**（哪些等待**不是**判据、别误伤）：`RECONNECT_MS` 是重连节奏、
  `sleep(500)` 是轮询间隔 —— 判据永远是「目标状态真的出现了」，不是「睡了多久」。

---

## 8. 已知遗留（**没做的，如实**）

1. **扩展侧代码没有 tsc / eslint 兜底。** `tsconfig.json` 的 `include` 是 `["src", "vite.config.ts"]`，
   `npm run lint` 也只扫 `src` —— 所以 `harbor-edge/src/**` **不在任何类型检查范围内**。
   要给它加检查得引 `@types/chrome`（**新依赖，红线**），本步没做。**这是真实的缺口**：
   `chrome.*` 写错、类型不匹配**不会被任何检查拦住**（本步靠真机验收兜着）。
2. **`sidepanel.css` 仍整份 `@import` 主应用两份 CSS**（用户已拍板先这样）。
   现在 CSS 20.23 kB —— 等 Phase 2/3 真长出 UI 再看要不要拆。
3. **侧边栏的输入框是 disabled 占位**，不能真发（对话是 Phase 3）。
4. **「重试」按钮**只是再发一次 `ping` —— 没装 host 时点了不会变魔术，状态仍是未连接（预期行为）。
5. **`harbor-edge/dist/` 是构建产物**，已进 `.gitignore`；但 **`dist/sidepanel` 本身就是要
   让用户「加载已解压的扩展」的那个目录** —— 所以别把它当临时目录清掉。
6. **探针扩展 `harbor-edge/ext/` 保留未动**（用户要求），`accept-host.cjs` 仍指向它、仍可用。
7. **`.gitignore` 里 `harbor-edge/dist/` 的忽略规则**是第一步就加的，本轮沿用。

---

## 9. 是否违反约束

零新依赖 ✓ · **未碰 `electron/**`** ✓ · **未碰 `src/**` 的产品代码**（只在 `src/components/ui/Button.tsx`
里被 `content` 扫描，文件本身**一个字没改** —— `git status src` 为空）✓ ·
未碰 Runtime / 严格模式 / 防闪烁 / `hardenWebview` / 工具系统 / 权限模型 ✓ ·
**未做读页面**（Phase 2）✓ · **未加 scripting / activeTab / host_permissions** ✓ ·
单文件全 ≤300（最大 244）✓ · 探针全隔离、跑完注册表 `rc=1`、profile 已删 ✓ ·
未碰用户正在用的 Edge 与 `E:\Harbor` / `E:\Harbor-Dev` ✓

---

## 10. 下一阶段

**Phase 2：读页面内容。** 在此之前的待决项（供用户拍板）：

1. **要不要给扩展侧加类型检查**（会引 `@types/chrome`，属新依赖，需单独批）。
2. **`content script` 的注入范围**：Phase 2 要读当前页正文 —— 用 `activeTab`（用户点一下才授权）
   还是 `scripting` + 按域授权？（技术方案里推荐 `activeTab` 优先。）
3. 侧边栏与主应用窗口的**通信形态**：Phase 1b 已确定「扩展请求由主进程直接处理、不经渲染层」，
   Phase 2 第一次真正用到，要把那条链落下来。
