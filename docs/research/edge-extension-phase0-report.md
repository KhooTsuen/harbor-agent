# Phase 0 · Edge Native Messaging 协议可行性实测报告

> 日期：2026-10-15 · 类型：**实测报告**（Phase 0 唯一授权范围）
> 四个未验证点逐条给出「通过 / 不通过」，每条都指得出**实测命令与输出**，测不到的一律写明。
> **未实施 Phase 1**，`electron/` 一个字节未动。

---

## 0. 结论摘要（四问四答）

| # | 未验证点 | 结论 | 一句话 |
|---|---|---|---|
| 1 | host 清单 `path` 能否带命令行参数 | **❌ 不通过** | Edge 把整串当路径 → `Specified native messaging host not found.` |
| 1b | （替代）`path` 指向 `.cmd` 包装器 | **✅ 通过** | 端到端 `ping → pong` 跑通 —— 这条救回了方案 A |
| 2 | 注册表键的确切路径 | **✅ 通过** | `HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\<name>`（64 位视图实测可用） |
| 3 | 独立 host 能否安全 `require` Harbor 模块 | **✅ 通过** | 15 个核心模块顶层不依赖 electron，纯 Node 下全部加载成功 |
| 4 | 活跃 native port 能否重置 SW 空闲计时器 | **✅ 通过** | 真机实测 40.8 秒端口未断、SW 上下文未丢 |

**总判定：方案 A（Native Messaging）成立**，但原设计有 **3 处必须修正**（见 §7）——其中第 1 条的修正正是让方案从「不通过」变成「通过」的关键。

---

## 1. 实测环境（都是真实观察，不是记忆）

| 项 | 值 | 取证 |
|---|---|---|
| Edge | **155.0.4283.45** | `list_dir`：`C:\Program Files (x86)\Microsoft\Edge\Application\155.0.4283.45\` |
| Node | **v24.19.0** @ `E:\nodejs\node.exe` | `where node` / `node -v` |
| Electron | 44.3.0（宿主 Harbor 用） | `process.versions` 实读 |
| 探针扩展 | `E:\CodexWorkbench\harbor-edge\phase0\ext`（MV3，仅 `nativeMessaging`） | 本轮新建，见该目录 |
| **实测扩展 ID** | **`fgiopdanmkafnmpcjiiofkbbgikmdljn`** | 从 `Secure Preferences` 的 `extensions.settings` 读出 |
| 注册表（实测前） | `HKCU\...\Microsoft\Edge\NativeMessagingHosts` **不存在** | `reg query` 返回空 |
| 注册表（本机已有） | `HKCU\...\Google\Chrome\NativeMessagingHosts` 下 **3 个** | 含 **`com.openai.codexextension`**（Codex 浏览器扩展） |

> **★ 意外收获**：本机已经躺着一个**真实可跑的参考实现** —— Codex 的 host 清单。
> 它的 `path` 指向一个**专门的 `extension-host.exe`，不带任何参数**（`C:\Users\BinLin\.codex\plugins\cache\openai-bundled\chrome\latest\extension-host\windows\x64\extension-host.exe`）。
> 这独立印证了 §3 的实测结论，也说明「为扩展单做一个 host 可执行入口」是业界做法。

---

## 2. 点 1（最关键）：`path` 能否带命令行参数 → **❌ 不通过**

### 实测矩阵（4 组，每次写注册表 → 起 Edge → CDP 调 `connectNative` → 读 `lastError`）

| 组 | 注册表视图 | `path` 写法 | `lastError` | host 是否被拉起 |
|---|---|---|---|---|
| **A** | 64 位 | `E:\nodejs\node.exe`（**纯 exe**） | `Error when communicating with the native messaging host.` | **★ 是**（argv 拿到了） |
| C | 32 位 | `node.exe "…\probe-host.cjs"` | `Specified native messaging host not found.` | 否 |
| D | 64 位 | `node.exe "…\probe-host.cjs"` | `Specified native messaging host not found.` | 否 |
| E | 64 位 | 纯 exe + `NODE_OPTIONS=--require …` | `Error when communicating…` | **★ 是**（argv 拿到了） |

**判读**：A 与 C/D 的错误**不同**，这是决定性证据 ——

- **A（纯 exe）**：错误是「**通信**出错」= Edge **找到了并启动了** host，只是协议没谈成；
- **C/D（带参数）**：错误是「**找不到 host**」= Edge 把 `node.exe "脚本"` **整串当成一个文件路径**去查，当然找不到。

→ **结论：`path` 只能是一个「不带参数的可执行文件路径」。**

### 为什么 A 组协议没谈成（这不是协议写错）

用**本地喂帧**单独验证了协议实现本身：

```
→ 发 {"ping":1}
← host stdout 共 51 字节
  帧头声明的长度 = 47
  帧体 = {"pong":1,"echo":{"ping":1},"markerSeen":false}
  ★ 解析成功：pong=1
```

**协议实现完全正确。** 问题在 `node.exe` **无参数**时的行为：它会把 **stdin 当作「脚本源」整个读掉**（证据：连发 3 次消息，Edge 把 host 拉起 **3 次**，全程 **0 条 `got-message`**，只报 `Native host has exited.` / `communicating error`）。

### 1b（替代路径）：`path` 指向 `.cmd` 包装器 → **✅ 通过**

```
=== path = E:\CodexWorkbench\harbor-edge\phase0\host.cmd ===
  host 阶段 = ["started","got-message","started","got-message",...]
  ★ host 收到 = {"ping":1,"at":1792064354686}
  ★ 协议跑通 = 是
```

**这条件原本是死路，`.cmd` 包装器把它打通了** —— Edge 能启动 `.cmd`，由它再调 node，node 就正常以「脚本模式」运行，不再抢 stdin。

> ⚠️ 但 `.cmd` 这条路有个**必须知道的副作用**：Edge 传给 host 的参数（origin / `--parent-window`）会落到 **`cmd.exe`** 手里，**不会自动转发给 node**。要用得写 `%*` 转发。所以它只适合做「本机自用的旁路」，**不适合当 Harbor 的生产形态**。

---

## 3. 点 2：注册表键的确切路径 → **✅ 通过**

### MS Learn 官方原文（本轮**读全了** Step 2 / Step 3 正文）

注册表键（原样抄自官方文档）：

```
HKEY_CURRENT_USER\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.my_company.my_app
HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.my_company.my_app
```

官方给的命令行写法（原样）：

```cmd
REG ADD "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.my_company.my_app" /ve /t REG_SZ /d "C:\path\to\nmh-manifest.json" /f
```

**Edge 的搜索顺序**（官方原文，之前那版报告里我写的是「未验证」，现在有原文了）：

```
HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\
HKCU\SOFTWARE\Chromium\NativeMessagingHosts\          ← Chrome/Chromium 兜底
HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\
HKLM\SOFTWARE\WOW6432Node\Microsoft\Edge\NativeMessagingHosts\
…（32 位视图先查，再查 64 位视图）
```

> ⚠️ 官方原文还有一条**容易踩的**：Edge **不查** `HKCU\SOFTWARE\WOW6432Node`（64 位机器上该节点不被搜索）。
> 以及：**只读第一个命中的位置**的那份清单 —— 所以若同时上架 Edge 商店和 Chrome 商店，**两个扩展 ID 都得写进 `allowed_origins`**。

### 清单字段（官方原文，含 `path` 的真实约束）

| 键 | 官方原文要点 |
|---|---|
| `name` | 只能含小写字母数字 / 下划线 / 句点；不能以句点开头结尾；句点后不能再跟句点 |
| `path` | **Windows 上可以是相对清单所在目录的相对路径**；host 进程的 **cwd 会被设成 host 二进制所在目录** |
| `type` | 唯一合法值 `stdio` |
| `allowed_origins` | 不能含通配符；格式 `chrome-extension://<ID>/` |

### 本机实测

- 写 `HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.harbor.phase0.probe`（**64 位视图**，`reg ADD` 默认）→ **Edge 认到了**（A 组 host 被成功拉起即为证据）。
- ⚠️ **32 位视图未单独定论**：B 组（32 位视图）那次实验失败是因为 Edge 起得太慢、没找到扩展 SW，**不是注册表的问题**。官方说法是「先查 32 位再查 64 位」→ **生产脚本两边都写最稳**。

---

## 4. 点 3：独立 host 能否安全 `require` Harbor 模块 → **✅ 通过**

方法：静态扫「顶层是否 `require('electron')`」+ 动态**真跑一遍**（`HARBOR_UNIT_TEST=1` 隔离到 `data/unit-test-data`）。

| 模块 | 顶层要 electron | 纯 Node 下真 require |
|---|---|---|
| `core/paths.cjs` | 否 | ✅ 10 个导出 |
| `core/log.cjs` | 否 | ✅ 8 个 |
| `core/config.cjs` | 否 | ✅ 20 个 |
| `core/capability.cjs` | 否 | ✅ 10 个 |
| `core/webview-permissions.cjs` | 否 | ✅ 4 个 |
| `core/browser-identity.cjs` | 否 | ✅ 9 个 |
| `core/audit.cjs` / `core/risk.cjs` / `core/redact.cjs` | 否 | ✅ 8 / 5 / 11 个 |
| `core/tools/registry.cjs` / `core/tools/index.cjs` | 否 | ✅ 10 / 8 个 |
| `core/session.cjs` | 否 | ✅ 15 个 |
| `core/chat-emit.cjs` / `core/browse-read.cjs` | 否 | ✅ 1 / 2 个 |
| **`handlers/browser.cjs`** | **是** | ⚠️ 见下 |

**★ 一个必须记住的坑**：`handlers/browser.cjs` 顶层解构 electron —— 在纯 Node 里它**「require 成功」但拿到的全是 `undefined`**。
**「能加载」≠「能用」**：独立 host 里凡是碰 electron API 的模块都不能直接用，必须走「host ↔ 主进程」那层桥。

**隔离验证**：`HARBOR_UNIT_TEST=1` → `dataDir = E:\CodexWorkbench\data\unit-test-data`（**不碰用户真数据**）。

---

## 5. 点 4：活跃 native port 能否重置 SW 空闲计时器 → **✅ 通过**

用了**健康端口**（`.cmd` 包装器那条路，协议已确认跑通）做测量，关键是**先断开 CDP**（Chrome 118+ 明文：debugger 会话**自己也会保活 SW**，不断开就测的是 debugger 而不是 port）。

```
=== path = host.cmd ===
  ★ 协议跑通 = 是
  → 端口是健康的，接着测保活：断开 CDP，等 40 秒
  40 秒后 = {"hasT0":"number","aliveMs":40851,"ev":[]}
                               ↑              ↑
                    全局变量还在      ★ 0 条 disconnect 事件
```

**判读**：
- `aliveMs = 40851` → **SW 上下文 40.8 秒后仍在**（`globalThis` 未丢 → 未被终止过）；
- `ev = []` → **端口全程没有断开过一次**。

→ **Edge 155 实测：健康的 native port 确实能保活 SW**（与 Chrome 105+ 的官方说明一致）。

**反面印证**（同一机制的另一半）：之前 node 替身那条路端口在 **251ms** 就断了（`Native host has exited.`），此时 SW **8 秒还在、45 秒后没了** —— 正好说明「**端口一断，保活就失效**」。官方原文也是这么说的（host 崩溃则端口关闭，须在 `onDisconnect` 里重连）。

---

## 6. 另外三条实测事实（Phase 1 会直接用上）

### 6.1 ★ Edge 拉起 host 时真实传的 argv（含一个被 Node 改坏的陷阱）

`path = 纯 node.exe` 时，host 侧收到的 argv：

```
[0] E:\nodejs\node.exe
[1] E:\nodejs\chrome-extension:\fgiopdanmkafnmpcjiiofkbbgikmdljn   ← ⚠️ 被「Node 脚本路径解析」改坏了
[2] --parent-window=0
```

同样两个参数喂给 **Electron**（`electron.exe script.cjs chrome-extension://<ID>/ --parent-window=0`）：

```
argv = ["...electron.exe", "tmp\\_electron_argv.cjs", "chrome-extension://fgiopdanmkafnmpcjiiofkbbgikmdljn/", "--parent-window=0"]
```

**判读**：
- 官方说第一个参数是 origin —— **确实传了**，但在 node.exe 下被路径解析污染成了 `E:\nodejs\chrome-extension:\<ID>`。
- **`--parent-window=` 在两种环境下都原样传递** → **这是最可靠的「我是被 Edge 拉起的」判据**。
- ⚠️ 官方原文提醒：**调用上下文是 Service Worker 时该值是 `0`** —— 所以只能用「**参数存在**」判定，不能用「值非零」判定。

### 6.2 unpacked 扩展 ID **不能自己算**

我按 Chromium 的 `GenerateIdForPath`（sha256(绝对路径) 前 16 字节 → a–p）本地算得 `doacoiidbmccehjb`，
**实测加载后是 `fgiopdanmkafnmpcjiiofkbbgikmdljn`** —— **不一致**。

→ 生产安装脚本**必须**「加载一次 → 读 `Secure Preferences` 拿真 ID」，不能靠算。

### 6.3 Edge 155 里 `--load-extension` **需要显式打开开关**

Chromium 137+ 用 feature 开关 `DisableLoadExtensionCommandLineSwitch` 关掉了这个命令行参数。实测：

- 只传 `--load-extension=<dir>` → **不加载**（Preferences 里 0 个扩展）；
- 加上 `--disable-features=DisableLoadExtensionCommandLineSwitch` → **加载成功**。

→ 影响的是**开发期 sideload 与我的自动化测试**；用户正常安装（edge://extensions 手动加载）不受影响。

---

## 7. 原设计必须修正的 3 处

| # | 原设计 | 修正为 | 依据 |
|---|---|---|---|
| **1** | `path` 指向 `Harbor.exe` 并让它支持 `--native-host` | **`path` 只能是纯 `Harbor.exe`（零参数）**；Harbor 靠 **`--parent-window=` 参数存在** 判定「我是被 Edge 拉起的」 | §2 点 1 实测 |
| **2** | `--native-host` 分支放在 `main.cjs` | 分支判据改为 **`process.argv` 里有 `--parent-window=`**（无需自造开关） | §6.1 |
| **3** | 用路径算扩展 ID | 安装脚本**加载一次读真实 ID**再写 `allowed_origins` | §6.2 |

> 修正 1 之后，「path 不能带参数」这条**从致命伤变成了非问题** —— 因为 Harbor 本来就不需要参数：它只要在启动那 1ms 看一眼 argv 就知道自己该走哪条路。

---

## 8. Phase 1 实施计划（**等你确认后再动**）

**范围**：扩展骨架 + 侧边栏 + 打通 ping/pong。**不含**页面操作。

| 步 | 做什么 | 落点 | 验收 |
|---|---|---|---|
| 1.1 | host 入口：`process.argv` 判 `--parent-window=` → 进 stdio 帧循环 | **`electron/native-host.cjs`（新建）** | 纯 Node 可自检（帧编解码是纯函数） |
| 1.2 | 主进程接入：启动最早期判 argv → 走 host 分支 | **`electron/main.cjs`（改，最小）** | 真机：Harbor.exe 被 Edge 拉起时不建窗口 |
| 1.3 | 扩展骨架：MV3 + `sidePanel` + SW 持 port + `onDisconnect` 重连 | `harbor-edge/src/**` | `edge://extensions` 加载无错 |
| 1.4 | 侧边栏 UI（React + Tailwind，复用 Harbor 令牌） | `harbor-edge/src/sidepanel/**` | 能显示「已连接 / 未连接」 |
| 1.5 | 安装脚本（写注册表 + 生成清单 + 读真实扩展 ID） | `harbor-edge/install-host.cmd` | 跑一次 → Edge 里能连上 |
| 1.6 | 自检组 | `scripts/selftest/groups/154-*.mjs` | 帧协议 + argv 判据 |

**需要你另外批准的**（现在不动）：
- `electron/main.cjs` 加 host 分支 —— **命中「主进程关键文件」**；
- `harbor-edge/` 进主仓库后要加**打包排除规则**（你说的「后续处理」）。

---

## 9. 遗留 / 未验证

1. **32 位注册表视图未单独定论**（§3）—— 生产脚本两边都写即可，不阻塞。
2. **store 上架后的扩展 ID 与 sideload 不同**（官方原文提醒）—— 那时 `allowed_origins` 要加新 ID。
3. **`path` 指向 `.cmd` 时参数不自动转发**（§2）—— 生产形态用 `Harbor.exe`，不受影响。
4. **host 正式入口（`Harbor.exe`）本机未实测** —— 它要等 Phase 1 建出来才知道；但 argv 行为已用 `electron.exe` 等价验证（§6.1）。
5. **`data/` 下 host 清单落点未定**：守硬约束 #3，但 `data/` 是用户数据、升级不覆盖 → 安装脚本要**幂等生成**。

---

## 10. 边界遵守声明

- **只做了 Phase 0**，未动 Phase 1；`electron/` **一个字节未改**（本轮全部产物在 `harbor-edge/phase0/`）。
- 零新依赖（只用 Node 内置 + 系统自带 `reg`）。
- 未碰 Runtime / 严格模式 / 防闪烁三件套 / `hardenWebview` / 工具系统 / 权限模型。
- **未加任何 IPC 通道**。
- 探针用的 Edge 实例**全部独立 profile**（`--user-data-dir` 指向探针目录），**未碰你正在用的 Edge**；收尾时 **24 个 msedge 进程核对、探针 profile 全删、注册表键全删**（已复核为空）。
- 未为验证访问任何风控站点；未注册账号、未提交个人信息。

---

## 11. 取证文件（都在 `E:\CodexWorkbench\harbor-edge\phase0\`）

| 文件 | 用途 |
|---|---|
| `step-d-matrix.cjs` | 点 1 的 4 组矩阵（注册表视图 × path 形态） |
| `step-e-exe-only.cjs` | 纯 exe 形态 + 抓真实 argv |
| `step-f-protocol.cjs` | 本地喂帧验协议实现（不依赖 Edge） |
| `step-g-swkittest.cjs` | 连接/发消息对照 + 保活实验（含 CDP 必须断开的原因） |
| `step-h-cmd-wrapper.cjs` | **决定性**：`.cmd` 包装器 → 协议跑通 + 40 秒保活 |
| `probe-host.cjs` | host 侧最小实现（帧协议 + argv 落盘） |
| `host-report-h.json` | 决定性证据：`started` / `got-message` 记录 |
| `ext/` | 探针扩展（**纯 MV3**，只声明 `nativeMessaging` + `background.service_worker`） |
