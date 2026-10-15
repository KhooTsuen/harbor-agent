# harbor-edge —— Harbor 浏览器扩展（Edge）

这个目录是 **Harbor 接入本地 Edge 浏览器**的那一摊东西。它**不是**主应用的一部分：
主应用是 Electron 窗口，这里是浏览器侧的扩展 + 让两者说话的 native host。

> 阶段与实测记录见 `docs/research/edge-extension-*.md`。
> 当前状态：**Phase 1c 第二步**（侧边栏骨架 + 连接状态）。读页面是 Phase 2，对话是 Phase 3。

## 目录

| 路径 | 是什么 |
|---|---|
| `extension/` | **真扩展的源**（`manifest.json` + `service-worker.js`）—— 构建时原样拷进产物 |
| `src/sidepanel/` | 侧边栏的 React 源（入口 `index.html` / `main.tsx` / `App.tsx`） |
| `vite.config.ext.ts` | 扩展的独立 Vite 配置（root / postcss / outDir / alias 都跟主应用不同） |
| `postcss.config.js` | 扩展的 Tailwind 配置（theme 继承主 config、content 只扫扩展 + 用到的 UI 组件） |
| `harbor-host.cmd` | **native host 包装器**（纯 ASCII）——`ELECTRON_RUN_AS_NODE=1` + `Harbor.exe` + `native-host.cjs` |
| `install-host.cmd` / `uninstall-host.cmd` | 装 / 卸 native host（注册表 + 清单，幂等） |
| `lib/driver.cjs` | 验收共用的 Edge 驱动（隔离 profile / 注册表 / 读扩展 ID） |
| `tools/` | 验收脚本（见下） |
| `ext/` | Phase 1b 的**探针扩展**（历史验收资产，**不要动**） |
| `phase0/` `exp/` | Phase 0 / 三组实验的脚本与产物（历史资产） |
| `dist/sidepanel/` | 构建产物 —— **这个目录本身就是可加载的扩展** |

## 构建

在**项目根**跑（不是在这个目录）：

```cmd
npx vite build --config harbor-edge/vite.config.ext.ts
```

产物落 `harbor-edge/dist/sidepanel/`：`index.html` + `assets/` + `manifest.json` + `service-worker.js`。
Edge 里「加载已解压的扩展」直接选这个目录。

## 验收脚本

| 脚本 | 验什么 | 跑法 |
|---|---|---|
| `tools/accept-sidepanel.cjs` | 构建产物**能当扩展页加载**（Phase 1c 第一步） | `node harbor-edge/tools/accept-sidepanel.cjs` |
| `tools/accept-extension.cjs` | 真扩展 + native host **端到端**：能读到哪些状态（Phase 1c 第二步） | `node harbor-edge/tools/accept-extension.cjs` |
| `tools/accept-host.cjs` | Phase 1b 探针那条链路（native host ping/pong） | `node harbor-edge/tools/accept-host.cjs` |
| `tools/read-extid.cjs` | 起一次隔离 Edge、读**真实**扩展 ID | 由 `install-host.cmd` 调 |

三个脚本都**自己起隔离 Edge**（独立 `--user-data-dir`），**不碰**你正在用的那个。

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
