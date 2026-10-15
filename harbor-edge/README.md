# harbor-edge —— Harbor 浏览器扩展（Edge）

这个目录是 **Harbor 接入本地 Edge 浏览器**的那一摊东西。它**不是**主应用的一部分：
主应用是 Electron 窗口，这里是浏览器侧的扩展 + 让两者说话的 native host。

> 阶段与实测记录见 `docs/research/edge-extension-*.md`。
> 当前状态：**Phase 3b 完成** —— 侧边栏能**发消息**、看**流式回复**，且与主窗口**同一条会话**。
> 布局经用户要求返工为「**顶栏 + 对话区 + 输入框 + 会话抽屉**」（会话列表不再常驻）。
> **Phase 3c 完成** —— 抽屉里点一条 = 侧边栏切过去（**主窗口不动**，用户拍板）；
> 没选会话时发消息会**自动新建一条**；顶栏 ＋ 也是真的。Agent 操作网页是 Phase 4 —— **未开工**。
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

`electron/core/ext-protocol.cjs` 的 `pipeName()` 直接对数据根字符串做 `sha1`。
现在 host 与主进程**恰好**算出同一个名字（两边字符串逐字符相同），但路径里
多一个结尾反斜杠、或盘符大小写不同，管道名就会**静默对不上**
（症状：永远「Harbor 没有在运行」，而两边其实都活着）。

**要做的**：算 hash 前先 `path.resolve()` + 统一小写（Windows 路径大小写不敏感）。

### ⏭ 待办：删 `main.cjs` 那条兼容分支（A4，独立小提交）

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
| `src/sidepanel/` | 侧边栏的 React 源：`index.html` / `main.tsx` / `App.tsx`（**顶栏三区：☰ / 状态区 / 设置+新建**）/ `ChatPanel.tsx`（**对话区**）/ `SessionDrawer.tsx`（**会话抽屉，从左侧滑出**）/ `ReadPageButton.tsx`（读当前页，**图标按钮**） |
| `src/sidepanel/ChatPanel.tsx` | 侧边栏**对话区**（3b）：发消息 + 流式回复显示（按 `seq` 丢弃重排的旧片） |
| `vite.config.ext.ts` | 扩展的独立 Vite 配置（root / postcss / outDir / alias 都跟主应用不同） |
| `postcss.config.js` | 扩展的 Tailwind 配置（theme 继承主 config、content 只扫扩展 + 用到的 UI 组件） |
| `harbor-host.cmd` | **native host 包装器**（纯 ASCII）——`ELECTRON_RUN_AS_NODE=1` + `Harbor.exe` + `native-host.cjs` |
| `install-host.cmd` / `uninstall-host.cmd` | 装 / 卸 native host（注册表 + 清单，幂等） |
| `lib/driver.cjs` | 验收共用的 Edge 驱动（隔离 profile / 注册表 / 读扩展 ID） |
| `lib/ext-probe.cjs` | 验收共用：CDP 求值 / 找 SW / 喂帧（**再导出**下一条） |
| `lib/ext-probe-panel.cjs` | 面板 **DOM 锚点**（**可访问文案的唯一真相源**，文件头带**归属表**）：状态行 / 读页面 / ☰ / 当前会话名 / 抽屉 / 会话列表 |
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
| `tools/accept-phase3a.cjs` | **双向通道 + 会话列表**（Phase 3a，**16 条判据**） | `node harbor-edge/tools/accept-phase3a.cjs` |
| `tools/accept-phase3b.cjs` | **侧边栏发消息 + 流式回复 + 两端同一条**（Phase 3b，**15 条判据**） | `node harbor-edge/tools/accept-phase3b.cjs` |
| `tools/accept-phase3c.cjs` | **选会话（只切侧边栏）/ 未选中自动新建 / ＋**（Phase 3c，**20 条判据**） | `node harbor-edge/tools/accept-phase3c.cjs` |
| `tools/accept-host.cjs` | Phase 1b 探针那条链路（native host ping/pong） | `node harbor-edge/tools/accept-host.cjs` |
| `tools/read-extid.cjs` | 起一次隔离 Edge、读**真实**扩展 ID | 由 `install-host.cmd` 调 |

全部脚本都**自己起隔离 Edge**（独立 `--user-data-dir` + 隔离数据根），**不碰**你正在用的那个。

> ⚠️ **`accept-phase3a/b/c.cjs` 必须串行跑，绝不能并行。**
> （2026-10-16 补：`3a` 原来是**只删不恢复注册表**的，跑一次就把用户手工装的那条抹掉 ——
> 现在三个脚本都会先快照、跑完**原样恢复**。）
> 两者都写同一个全局注册表键 `HKCU\...\NativeMessagingHosts\com.harbor.agent`
> （`finally` 里「摘 → 装隔离 → 恢复原值」）—— 并行会让它们互相踩，**键可能被删掉**
> （2026-10-16 真踩到，恢复要手工 `reg ADD` 回原值）。

> ⚠️ `accept-phase3a/b/c.cjs` 会**临时写 `com.harbor.agent` 注册表**（指到
> 隔离清单），跑完 `finally` 里**恢复原值** —— 如果你之前手动装过 host，跑完那条还在。
> 另：3b 那一跑需要**源码树实例**（3b 改的是渲染层，打包版里是旧的）—— 脚本自己拉
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
