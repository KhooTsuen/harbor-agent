# Harbor 浏览器扩展（Edge）：调研与方案说明

> **只读调研（2026-10-15）。本文不含任何实施代码，等批准后分批做。**
>
> **证据口径**（三类，分开标）：
> - **Harbor 侧**：结论全部来自实读源码，附文件位置 / 行号。
> - **浏览器侧**：分两档 —— 「✅ 本轮读到官方原文」（附来源）与 **⚠️ 未验证**（本轮
>   没读到原文，或本机没实测到）。**未验证的不要当已知用。**
> - **本机事实**：Edge 版本与安装路径为实测。
>
> 一句话结论：**技术上可行，但真正的难点只有一个** —— 让 `Harbor.exe` 能当一个
> native host 进程跑起来。其余部分（扩展、侧边栏、协议）都是常规工程。

---

## 0. 结论摘要

1. **推荐 Native Messaging（stdio）作为主干**，**不用**本地 HTTP / WebSocket 服务。
   理由不是"好写"，而是**它不开监听端口** —— 攻击面小一个数量级，且来源身份由浏览器强制。
2. **「读页面 / 点按钮 / 截图」是扩展自己的能力**（`scripting` / `activeTab`），
   **不该**经过 Harbor 的工具系统；Harbor 只负责「模型 + 会话 + Agent 循环」。
   这条决定了整个集成面的大小 —— 按它做，`electron/core/tools/**` 一行都不用动。
3. 两条路都**不需要新依赖**（stdio 与命名管道都是 Node 内置）。改动集中在
   **新增文件**，对既有模块是「接线」级别的触碰。

---

## 1. 通信方案对比与推荐

### 1.1 路径 A：Native Messaging（stdio）

扩展通过 `chrome.runtime.connectNative()` / `sendNativeMessage()` 让浏览器**拉起一个
本机 host 进程**，双方用 stdin / stdout 传递消息。

| 项 | 事实 | 出处 |
|---|---|---|
| 通信方式 | host 与扩展用**标准输入 / 标准输出**收发消息 | ✅ MS Learn《Native messaging》：*"The native app host sends and receives messages with extensions using standard input and standard output."* |
| 扩展侧声明 | manifest 里加 `nativeMessaging` 权限 | ✅ 同上（Step 1） |
| 分发模式 | 两种：① 扩展与 host **打包在一起**安装；② 扩展上架商店，装扩展时**提示用户装 host** | ✅ 同上 |
| 需要哪几件东西 | Step 1 加权限 · Step 2 写 host 清单 · Step 3 把清单放到系统里 | ✅ 同上（三个小标题原文） |
| **host 清单的确切字段与 `path` 能否带参数** | — | **⚠️ 未验证**（本轮页面被截断，未读到 Step 2 正文） |
| **注册表键的确切路径与写法** | — | **⚠️ 未验证**（同上） |
| **单条消息大小上限** | — | **⚠️ 未验证**（同上） |

**Harbor 侧的关键难点（这是本方案唯一的硬骨头）**：

便携版里**没有独立的 `node.exe`**，只有 `Harbor.exe`（Electron）。
所以 host 清单里的 `path` 只能指向 `Harbor.exe`，并让它支持一个 `--native-host` 入口：
带这个参数启动时**不建窗口、不进单实例锁、不初始化界面**，直接进 stdio 帧循环。

→ **必须改 `electron/main.cjs`**（这是唯一计划触碰主进程的地方）。

### 1.2 路径 B：本地 HTTP / WebSocket

Harbor 起一个只绑 `127.0.0.1` 的轻量服务，扩展用 `fetch` / `WebSocket` 连。

| 项 | 事实 | 出处 |
|---|---|---|
| HTTP 服务端 | Node **内置 `http`**，零依赖可实现 | 常识级；本轮未专门核实 |
| **WebSocket 服务端** | Node 内置的是 **WebSocket 客户端**，`WebSocketServer` 需第三方库 | **⚠️ 未验证** |
| fetch 时限 | **`fetch()` 响应超过 30 秒未到达 → Service Worker 被终止** | ✅ Chrome《SW 生命周期》原文 |

→ 走 WS 要么引 `ws`（**违反零依赖红线**），要么手写 RFC6455，要么退化成
HTTP + SSE / 轮询。**这一条是决定性的排除法。**

### 1.3 对比

| 维度 | A. Native Messaging | B. 本地 HTTP/WS |
|---|---|---|
| **攻击面** | **小**：不开监听端口 | 大：同机**任意进程**可连 `127.0.0.1` 试探 |
| **来源身份** | 由**浏览器**强制（`allowed_origins` 校验扩展 ID） | 需自建 token 校验；`Origin` 头在非浏览器客户端可伪造 |
| **新依赖** | **零** | WS 服务端必然要引库 ✗ |
| **端口冲突** | 不存在 | 要动态端口 + 发现文件 |
| **调试便利** | 差（二进制帧、stderr 被浏览器接管） | **好**（DevTools 直接看） |
| **实现复杂度** | 中（多出注册表 + 清单 + host 入口） | **低** |
| **与现架构贴合** | 中（host 是独立进程，拿不到主进程内存态） | **高**（同进程，config / 会话 / 审计都在手里） |
| **生命周期** | 由浏览器驱动，随机开随关 | 要自己管 server 存活 / 启动顺序 |

### 1.4 推荐：A，四条理由 + 三条代价

**选 A 的理由**：
1. **「不开端口」是结构性安全优势。** 本地服务的问题不是"能不能被攻破"，而是
   "同机任何程序都能来试探" —— 这跟 Harbor「本地优先」的主张是冲突的。
2. **零新依赖。** 而 WS 服务端恰好就是 Node 缺的那块 —— B 要么破红线，要么退化。
3. **身份由浏览器绑定。** `allowed_origins` 的校验发生在浏览器侧，比自己在应用层
   做 token 校验更可靠（token 的分发本身又是新问题）。
4. **生命周期天然绑定。** 不用管端口占用、不用管 server 死了没、不用管启动顺序。

**A 的代价（如实列，不是"稍麻烦"）**：
1. **`main.cjs` 多一个入口分支**（命中硬禁区，要单独批准）。
2. **host 是独立进程**，拿不到主进程的配置 / 会话 / 审计 → 需要一层
   「host ↔ 主进程」的本机通道（见 §3.2）。**注意：这可能削弱 A 的核心优势**，
   §3.2 给了两个候选并说明取舍。
3. **调试体验差**：host 的 stderr 被 Chromium 接管，要自己重定向进日志文件。
4. **前提是 Harbor 必须开着** —— 这点要在扩展侧边栏上明说，不能让用户以为
   扩展自己能干活。

**B 什么时候才该选**：只想最快跑通、且**只做只读**两种场景。但默认值应该是 A ——
安全形态一次做对，长期不用返工。

---

## 2. 扩展结构设计

### 2.1 目录树（建议）

```
harbor-edge/                       # 扩展根（是否进主仓库见 §6.3）
├── manifest.json                  # MV3
├── background/
│   └── service-worker.js          # ★ 唯一持有 native port 的地方
├── sidepanel/
│   ├── sidepanel.html             # side_panel.default_path 指向它
│   ├── main.jsx / main.js
│   └── tailwind.css
├── content/
│   └── page-bridge.js             # 内容脚本（读正文 / 执行操作）
├── ui/                            # React 源（与 Harbor 同栈）
├── icons/{16,32,48,128}.png
└── vite.config.ts                 # 独立构建（产物落 sidepanel/）
```

### 2.2 `manifest.json` 权限逐条（各自「解决什么问题」）

| 权限 | 解决什么问题 | 备注 / 出处 |
|---|---|---|
| `nativeMessaging` | 允许与本地 host 通信 —— **路径 A 的必需项** | ✅ MS Learn《Native messaging》Step 1 |
| `sidePanel` | 托管侧边栏界面 | ✅ Chrome《sidePanel》：**Chrome 114+ / MV3**；`"side_panel": { "default_path": ... }` 指定页面 |
| `scripting` | MV3 里执行 / 注册脚本（读页面、点按钮、填表单） | MV3 下 `tabs.executeScript` 已废，必须走它 |
| `activeTab` | 用户**点击图标时临时**拿到当前标签页权限 | 好处：安装时**不弹**「读取所有网站数据」 |
| `storage` | 存设置 / 授权记录 | ✅ Chrome《SW 生命周期》原文：**SW 里不能用 Web Storage，全局变量会丢**，要用 `chrome.storage` / IndexedDB |
| `tabs`（可选） | 读标签页标题 / URL | 只用 `activeTab` 时可能拿不到 URL，**需实测** |
| `host_permissions` | 内容脚本的持久注入范围 | **建议默认留空**，改用 `optional_host_permissions` 按域申请 |

**`activeTab` vs `host_permissions` 的取舍**：
- `activeTab`：安全、安装无恐吓警告，但**每次都要用户点图标**，做不到"自动感知当前页"。
- `host_permissions: <all_urls>`：能干一切，但安装时弹「读取你在所有网站上的数据」，
  且**这是生态里最被滥用的模式**。
- **推荐**：默认 `activeTab` + 按域授权（§4.2）。

### 2.3 侧边栏 UI 技术栈

**要求**：与 Harbor 现有渲染层一致（**React + Tailwind**）。

**做法**：**独立构建** —— 复用仓库里已有的 `react` / `tailwindcss`（**不算新依赖**），
但需要**另一份 vite 配置**（入口是扩展页，不是 `src/main.tsx`）。

**⚠️ 未验证**：
- Tailwind 的 `content` 扫描范围能否覆盖 `harbor-edge/ui/**`。
- 仓库用的 Tailwind 版本 / 配置形态（v3 config 还是 v4 CSS-first）会决定扩展侧怎么写。
- **MV3 扩展页的 CSP** 是否与现有 Tailwind 产物兼容（Tailwind 产物是静态 CSS，风险低，
  但仍需实测）。

**降级路径**：第 1 步先做**单 HTML + 原生 JS**，React 化留到第 2 步。
**建议先骨架、后 React 化** —— 先证明协议通，再谈界面好看。

### 2.4 Service Worker 的职责边界

**只做三件事**：
1. **持有唯一的 native port**（`connectNative`），断开时在 `onDisconnect` 里重连；
2. **消息路由**：side panel ↔ Harbor host、side panel ↔ content script；
3. **元数据落 `storage`**（因为 SW 会休眠，全局变量不可靠）。

**不做**：
- ❌ 不持业务状态（会话态归 Harbor 主进程）；
- ❌ 不做长耗时请求（✅ Chrome 原文：**fetch 响应超 30 秒 → SW 被杀**）；
- ❌ 不自己拼 Agent 逻辑。

**⚠️ 未验证**：MV3 SW「无操作 30 秒终止」的计时器能否被**活跃的 native port** 重置。
（Chrome《SW 生命周期》本轮读到的原文只说了「事件 / API 调用会重置计时器」，
**没有**读到关于 native port 保活的那一句。）若不能重置，就要退化成
「每次请求重新 `connectNative`」的短连接模式，代价是 host 冷启动延迟。
**这一条必须在第 0 步一并验证。**

---

## 3. 与 Harbor 现有架构的集成点

### 3.1 ★ 一条关键架构判断（这条决定改动面的大小）

**「读页面 / 点击 / 填表单」是扩展自己的事，不该映射到 Harbor 的工具系统。**

理由：Harbor 现有的 `browse*` 工具驱动的是**内嵌 `<webview>`**
（`electron/handlers/browser.cjs` L224-240 装配、`electron/core/cdp.cjs` 走 CDP
直连那个 webContents），而扩展要操作的是 **Edge 自己的标签页** ——
**两者是完全不同的 webContents，分属两个进程，没有任何共享句柄。**

跨进程去驱动 Edge 会引入新依赖（CDP 客户端库）+ 新权限面，且与
`hardenWebview` 的既有假定（`electron/navigation-policy.cjs` L125-132）冲突。

**正确的切分**：

```
Edge 页面操作（读正文 / 点 / 填 / 截图） → 扩展自己的 scripting      ← 不经过 Harbor
Harbor 的能力（模型 / 会话 / 循环 / 记忆 / 审计） → native host        ← 经本机通道
```

→ 结论：**不需要**把点击映射进工具系统，**不需要**动
`electron/core/tools/**`（任何一行）。

### 3.2 主进程需要新增什么

| # | 落点 | 改动 | 性质 |
|---|---|---|---|
| 1 | `electron/main.cjs` | 加 `--native-host` 分支（在 L68-71 那组模式开关旁，**同样跳过单实例锁**） | ★ **主进程关键文件 → 硬禁区** |
| 2 | `electron/native-host.cjs` | **新建**：stdio 帧协议（纯 Node，可被自检） | 新增 |
| 3 | `electron/core/ext-bridge.cjs` | **新建**：host ↔ 主进程通道 | 新增 |
| 4 | `electron/handlers/ext.cjs` | **新建**：把扩展请求接到**现有**内核路径（不新写循环） | 新增 |
| 5 | `electron/ipc-channels.cjs` | 若新增通道 → 同步 `EXPECTED_CHANNELS` | 硬禁区 #9 |
| 6 | `tools/install-edge-host.cmd` | **新建**：注册表 + host 清单生成（幂等） | 新增 |

#### ⚠️ §3.2 的第 3 项是**本方案最大的分歧点**，两个候选：

**(a) host 进程自己 `require` Harbor 的业务模块。**
   风险：Harbor 的模块可能假定「单进程 + 单例」（配置缓存、会话注册表、
   工具注册表 `electron/core/tools/registry.cjs` 里的 `_pluginTools` 缓存…）。
   在第二个进程里加载是否有副作用，**⚠️ 未验证**。

**(b) host 通过本机通道回连主进程（命名管道 / 本地 socket）。**
   命名管道（`\\.\pipe\<name>`，`node:net` 内置）**不开 TCP 端口**，比方案 B 安全，
   但仍引入一个新的本机 IPC 面 —— 需要自己的身份校验。

**建议**：优先验 (a)。**若 (a) 成立，`main.cjs` 可能只需加一个"识别参数后退出"的分支**，
甚至完全不动；若 (a) 不成立，再走 (b) + `main.cjs` 子模式。
**这就是第 0 步必须先跑的原因** —— 它的结果会推翻或确认本节的整个形状。

#### 另注：`second-instance` 能不能用来转交请求？

`electron/main.cjs` L218 的 `app.on('second-instance', ...)` 目前**只用来聚焦窗口**。
Electron 的 `second-instance` 事件**只提供 argv**（命令行参数），**不带结构化数据通道**。
所以"host 进程抢单实例锁 → 把请求转给主实例"这条**不可行**（除非把请求塞进 argv，
那有长度与转义两重坑）。**别按这条设计。**（**⚠️ 未验证**：未实测 argv 上限。）

### 3.3 IPC 通道（**是否需要，分两种情况 —— 请分别拍板**）

**情况一：扩展请求由主进程直接处理、不经渲染层 → 不需要任何新通道。**（**推荐**）

**情况二：界面要显示扩展状态 / 配对开关 → 需要下列三条**（占位草案，
命名待与现有规范对齐后再定）：

| 通道 | 类型 | 参数 | 返回值 | 为什么必须有 |
|---|---|---|---|---|
| `ext:status` | `handle` | 无 | `{ connected, extensionId, activeTabs }` | 设置页显示「已连接 / 未连接」 |
| `ext:pair` | `handle` | `{ action:'enable'\|'disable' }` | `{ ok }` | 用户显式开关（**默认关**） |
| `ext:event` | 主→渲染 `send` | `{ kind, sessionId, text }` | — | 扩展来的消息在界面上可见 |

**⚠️ 加通道 = 必须同步 `electron/ipc-channels.cjs`**，否则
`scripts/selftest/groups/134-ipc-channels.mjs` 会报红（它扫源码与清单比对）。
**→ 这三条命中硬禁区 #9，需单独批准。**

### 3.4 能力映射

| 扩展侧动作 | 走谁 | 说明 |
|---|---|---|
| 读当前页正文 | **扩展 content script** | 取出后**作为上下文文本**送给 Harbor |
| 截图 | **扩展 `tabs.captureVisibleTab`** | 需 `activeTab`；比跨进程驱动 Edge 简单得多 |
| 点击 / 填表单 / 滚动 | **扩展 `scripting`** | 高风险 → **必须用户确认** |
| 总结页面 / 加入对话 / 帮我查 X | **Harbor** | 模型 + 会话 + 现有网络栈 |

**`electron/handlers/browser.cjs`（内嵌 webview 那一套）与扩展无关** —— 两者可以并存，
互不干扰。将来若想让 Agent 在 Edge 里"自己动手"，**仍应走扩展的 scripting**，
而不是让 Harbor 去 CDP 连 Edge。

---

## 4. 权限与安全边界

### 4.1 扩展能访问哪些页面

三层收紧：
1. **默认无 `host_permissions`**，只有 `activeTab`（用户主动触发才有临时权限）；
2. `optional_host_permissions` **按域申请**（§4.2）；
3. **硬禁止清单**（不给用户改）：
   - 浏览器内部页：`chrome://` / `edge://` / `about:`（浏览器本身也拦，但显式写死更清晰）
   - 其他扩展页（本来就访问不到）
   - `file://`：默认禁止，除非单次显式授权
   - **已知银行 / 支付 / 密码管理器域名** —— ⚠️ **清单本身需要单独调研确定**
     （放哪儿、谁维护、怎么更新，本轮未定）

**★ 可直接复用 Harbor 既有的判据**：`electron/core/capability.cjs` L33-45 的 `SENSITIVE`
已经把两条列进去了 ——
- L39 `[\\/](Cookies|Login Data|Local State|Web Data)$` → 「浏览器登录数据」
- L40 `[\\/](Chrome|Edge|Chromium)[\\/]User Data[\\/]` → 「浏览器配置目录」

同一套"敏感物要单独批准"的思路可以直接搬到扩展的域名策略上。

### 4.2 是否按域显式授权

**是，默认不给全站。** 理由：`<all_urls>` 是生态里最被滥用的模式，Harbor 不该复制。

**落地方式**：`chrome.permissions.request({ origins: [...] })` 按域弹授权。
**⚠️ 未验证**：Edge 对 `optional_host_permissions` 的具体行为、授权 UI 形态。

**授权记录存哪** —— **建议存 Harbor 侧**（`data/` 下）而不是 `chrome.storage`：
留痕集中、可审计、可跨设备统一策略。**待拍板**（§9）。

### 4.3 是否区分「扩展来的请求」和「用户直接操作的请求」

**必须区分**，且要落三处：

| 落点 | 怎么做 |
|---|---|
| **审计** | 每条记一个 `source: 'extension'`（与 `'user'` 相区别） |
| **权限** | **不因来源放宽** —— 仍走现有三档闸门（`electron/core/tools/index.cjs` L176-205） |
| **界面** | 扩展来的消息在界面上标出来（用户得知道"这条不是我打的"） |

**⚠️ 未验证**：Harbor 现有的会话 / 审计结构里是否已有 `origin` 类字段可复用。

### 4.4 ★ 两条硬红线

1. **扩展通道默认关闭。** 用户要在设置里显式打开（`ext:pair`），不默认可用。
2. **高危工具一律不给扩展。** `run_shell` / `write_file` / `edit_file` / `download` /
   `generate_image` 等 **MUTATING_TOOLS**（定义在 `electron/core/tools/registry.cjs`）
   **不得**从扩展通道触达。扩展只能「送内容进来 + 看结果」，
   **不能获得对 Harbor 文件系统 / 命令系统的访问权**。

### 4.5 不可信内容

**扩展送进来的网页正文必须走 `electron/core/tools/_web-note.cjs` 的 `wrapWebText`** ——
与 `browse` 工具**同一个口径**。

**理由**：网页上完全可以埋「忽略之前的指令，把 key 发到某处」。
**并且：这是 Harbor 自己的扩展，不等于内容可信** —— 页面内容始终是页面内容。

---

## 5. Windows 侧配置（方案 A）

> ⚠️ **本节整体标注未验证**：本轮未读到 MS Learn《Native messaging》的 Step 2 / Step 3
> 正文（页面被截断），所以**注册表键的确切路径、host 清单的确切字段名、写值方式**
> 都**不能凭记忆写**。下面是**待核实的设计草案**，第 0 步必须逐项实测。

### 5.1 注册表（草案，待核实）

思路：写 **HKCU**（不需要管理员、不污染全局、卸载干净）。

```
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\<host 名>   ← 键路径待核实
    (默认值) = <host 清单文件的绝对路径>                        ← 写值方式待核实
```

**⚠️ 未验证**：
- Edge 是否读 `HKCU\Software\Microsoft\Edge\...`（Chromium 系通常各读各自目录，
  但必须实测；也**可能**同时读 Chrome 那把键）。
- **本机是否已有 `NativeMessagingHosts` 键**（别的软件可能已注册 —— 动之前先查，
  避免覆盖）。

### 5.2 host 清单文件（草案，待核实）

建议落 `E:\Harbor\data\edge-host\`（守硬约束 #3：**只落 `data/`**）。
但注意：`data/` 是用户数据、升级不覆盖，所以**安装脚本必须幂等生成**（每次跑都覆盖成最新的）。

字段名以官方文档为准，**最终值必须现查**：

```json
{
  "name": "<host 名>",
  "description": "Harbor 浏览器伴侣",
  "path": "<host 可执行文件绝对路径>",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<扩展 ID>/"]
}
```

**⚠️ 三个必须实测的点**：
1. **`path` 能否带命令行参数？** 若**不能**，host 必须是一个**单一可执行入口**
   → 那就只能让 `Harbor.exe` 靠 `--native-host` 自己判断（§1.1），或再想别的办法。
   **这一条最可能推翻整个方案 A，第 0 步第一件事就是验它。**
2. **`allowed_origins` 的前缀** —— Edge 上是否仍用 `chrome-extension://`。
3. **sideload 与商店上架的扩展 ID 是否相同** —— 若不同，两个都要写进清单。

### 5.3 卸载

- 删注册表键（`REG DELETE "<5.1 核实后的键路径>" /f`）
- 删 host 清单文件与 `data/edge-host/` 目录
- 删扩展

**无残留**：不开系统服务、不开端口、不注册开机启动。

### 5.4 若最终改选路径 B（备查）

- 优先 `listen(0)` 让 OS 分配端口，真实端口写到一个只有本用户可读的文件供扩展读；
- 只绑 `127.0.0.1`，**绝不**绑 `0.0.0.0`；
- 每次启动生成随机 token 走同一文件交换；
- 校验 `Origin` 头（但**不能只靠它**，非浏览器客户端可伪造）。

---

## 6. 改动文件清单 + 硬禁区判定

### 6.1 清单（方案 A）

| 类型 | 文件 | 说明 |
|---|---|---|
| 新增 | `harbor-edge/**`（扩展） | 见 §2.1 |
| 新增 | `electron/native-host.cjs` | stdio 帧协议（纯 Node，可自检） |
| 新增 | `electron/core/ext-bridge.cjs` | host ↔ 主进程通道 |
| 新增 | `electron/handlers/ext.cjs` | 接进现有内核路径 |
| 新增 | `tools/install-edge-host.cmd` | 注册表 + 清单（幂等） |
| 新增 | `scripts/selftest/groups/1xx-edge-bridge.mjs` | 自检 + 注册 |
| 改 | `electron/main.cjs` | `--native-host` 分支 |
| 改 | `electron/ipc-channels.cjs` | 仅当新增通道（§3.3 情况二） |
| 改 | `electron/register-handlers.cjs` | 仅当新增通道 |
| 改 | `electron/preload.cjs` | 仅当新增通道 |
| 改 | `CHANGELOG.md` | 碰了 `electron/**` 必须写 |
| **不动** | `electron/core/tools/**`（§3.1） / `electron/core/capability.cjs`（默认设计） / Runtime / 严格模式 / 防闪烁三件套 / `hardenWebview` / `loop.cjs` / `task.cjs` / `session*.cjs` / `changeset.cjs` | — |

### 6.2 硬禁区判定

| 禁区 | 命中？ | 说明 |
|---|---|---|
| **#1 改动 ≥3 文件** | ✅ **命中** | 约 10 个 → **必须分批、逐步批准** |
| #2 引入新依赖 | ❌ 未命中 | stdio / 命名管道都是 Node 内置（目标 0 依赖） |
| #3 改数据结构 | ❌ 未命中 | 不新增字段；授权记录若新增需另议 |
| **#8 内核关键文件** | ❌ 未命中 | `loop.cjs` / `task.cjs` / `session*.cjs` / `changeset.cjs` **一个都不碰** |
| **#9 新增 IPC** | ⚠️ **视情况** | §3.3 情况一**不需要**；情况二加 3 条 → **单独批准** |
| **#10 权限 / 安全模型** | ⚠️ **可能** | 默认设计**不改** `capability.cjs`；若要把"扩展来源"接进能力判据则命中 → 单独批准 |
| **主进程 `main.cjs`** | ✅ **命中** | §3.2 第 1 项 → **列出等批准** |
| `hardenWebview` 四项 | ❌ 未命中 | 与扩展无关（那是内嵌 webview 的事） |
| Runtime / 严格模式 / 防闪烁 | ❌ 未命中 | — |

### 6.3 ⚠️ 一处需要先拍板（决定 CI / 打包 / CHANGELOG 规矩）

**扩展代码住哪？**

- **A：进主仓库** `E:\CodexWorkbench\harbor-edge\` —— 协议变更与 Harbor 一起 review、
  一起记 CHANGELOG；代价：`check-rules` 会扫到它，且打包要加排除规则。
- **B：独立仓库** —— 主仓库干净；代价：协议变更要跨仓库同步，**容易漂**。

**倾向 A**（协议同源，避免漂移），但**需你拍板**。

---

## 7. 分阶段实施建议

| 阶段 | 内容 | 验收（做出什么算过） |
|---|---|---|
| **0. 协议可行性实测**（**必须先做**） | ① `Harbor.exe --native-host` 能否被 Edge 拉起 ② 清单 `path` 能否带参数 ③ 独立 host 能否安全 `require` Harbor 模块（§3.2(a)）④ SW 保活行为 | 最小 host 把 `{"ping":1}` 回成 `{"pong":1}`，`edge://extensions` 显示已连接 |
| **1. 扩展骨架 + 侧边栏** | 最小权限集 + side panel 空壳 + ping/pong 打通 | 侧边栏能显示「已连接 Harbor」 |
| **2. 只读单向** | 侧边栏读当前页正文 → 送 Harbor 建会话 | 会话里能看到**经 `wrapWebText` 包装**的内容 |
| **3. 双向** | Harbor 回复流式回侧边栏 | SW 被杀能自动重连并续上 |
| **4. 让 Agent 动手** | 点击 / 填表单 + 每次确认 | 审计里有 `source:'extension'` |
| **5. 域策略** | 硬禁止清单 + 按域授权 | 银行页注入被拒 |

**强烈建议：先只做第 0 步，做完停下来报告"能不能通"，再决定 1-5 怎么切。**
第 0 步的结果会直接**推翻或确认**本方案的几个关键假定（尤其 §3.2 与 §5.2）。

---

## 8. 未验证清单（**别当已知用**）

| # | 项 | 为什么没验 |
|---|---|---|
| 1 | host 清单的**确切字段**与注册表**确切键路径** | 本轮 MS Learn 页面截断，未读到 Step 2 / 3 正文 |
| 2 | **`path` 能否带命令行参数** | 同上；**这一条最可能推翻方案 A** |
| 3 | native messaging **单条消息大小上限** | 同上 |
| 4 | Edge 官方 API 清单里 **`sidePanel` 那一行** | 本轮页面截断（只读到 `contextMenus`）；Chrome 侧已确认 114+/MV3 |
| 5 | Edge 上 `allowed_origins` 是否用 `chrome-extension://` 前缀 | 未读到 |
| 6 | **活跃 native port 能否重置 SW 空闲计时器** | 本轮 SW 页面未读到该句 |
| 7 | **Node 是否没有内置 WS 服务端** | 本轮未实测 |
| 8 | 仓库前端构建（vite / tailwind 配置）能否复用到扩展页 | 本轮未读前端构建配置 |
| 9 | 本机是否已有 `NativeMessagingHosts` 注册表键 | **本轮 `run_shell` 被运行时约束拦下**（见 §10），未实测 |
| 10 | Harbor 内核模块能否在第二个进程安全加载（§3.2(a)） | 同上 |
| 11 | Edge 对 `optional_host_permissions` 的授权 UI / 行为 | 未读到 |
| 12 | Harbor 会话 / 审计结构里是否已有 `origin` 字段 | 未读到 |
| 13 | `second-instance` 的 argv 长度上限 | 未实测 |

---

## 9. 待拍板（5 项）

1. **通信选型认不认路径 A（Native Messaging）？**
2. **扩展代码进主仓库还是独立仓库？**（§6.3，影响 CI / 打包 / CHANGELOG 规矩）
3. **第 0 步（协议可行性实测）批不批？** —— 唯一计划动 `main.cjs` 的地方。
4. **IPC 通道要不要加？**（§3.3 情况一 = 不加；情况二 = 加 3 条，命中 #9）
5. **域名授权记录存 Harbor 侧（建议）还是扩展 `chrome.storage`？**

---

## 10. 安全与合规声明

**这个功能做的是什么**：让 Harbor 能在**用户自己**的 Edge 里、针对**用户打开的页面**、
在**用户显式授权**的前提下，提供「读当前页内容 / 展示 Agent 结果 /（第 4 阶段起）
执行用户确认过的操作」。

**明确不做**：
- ❌ 绕过登录、付费墙、访问控制
- ❌ 自动通过验证码（不打码、不伪造挑战 token）
- ❌ 无人在场的批量抓取
- ❌ 把 cookie / 登录态导出给模型
- ❌ 为验证效果而刻意访问风控站点

**透明性**（与 `SECURITY.md` §3「没有做什么」同口径）—— 实施时补一条：

> **浏览器扩展通道默认关闭；开启后，扩展只能把页面内容送进来、看结果，
> 不获得对 Harbor 文件系统 / 命令系统的访问权。权限判定不因请求来自扩展而放宽。**

---

## 附：本轮调研做了什么 / 没做什么

**做了**：
- 读 Harbor 源码 8 处：`electron/ipc-channels.cjs`、`electron/register-handlers.cjs`
  （L48 `trustedSender`）、`electron/core/paths.cjs`（`rootDir` / `realDataDir`）、
  `electron/main.cjs`（L53-60 路径与开关、L68-71 模式、L214 单实例锁、L218 second-instance）、
  `electron/core/capability.cjs`（L33-45 `SENSITIVE`）、
  `electron/core/tools/registry.cjs`（`WRITE_TOOLS` / `MUTATING_TOOLS` / `FILE_WRITERS`）、
  `electron/core/tools/index.cjs`（L176-205 闸门）、`electron/core/config-defaults.cjs`。
- 读官方文档 3 篇并取原文：MS Learn《Native messaging》（部分，截断）、
  MS Learn《Supported APIs for Microsoft Edge extensions》（部分，截断）、
  Chrome《sidePanel》、Chrome《扩展 Service Worker 生命周期》。
- 本机实测：Edge **155.0.4283.45**，装在
  `C:\Program Files (x86)\Microsoft\Edge\Application`。

**没做（如实）**：
- **本机跑命令**：本轮 `run_shell` 被运行时约束拦下（判定正确 —— 那轮的消息里有
  "不写任何实施代码"，内核按约束处理）。所以注册表现状、Node WS 能力、
  `Harbor.exe --native-host` 探针**都没实测**，已逐条进 §8。
- **没写成任何实施代码**，没动 `main.cjs`，没建扩展目录。
