# 内置浏览器反拦截：调研与方案说明

> **只读调研（2026-10-15）。本文不含任何实施代码，等批准后分批做。**
>
> 调研方式：读源码取行号 + 真机跑探针取实测值。**每一条实测值都附了取证方式**，
> 凡是我没测到的，文里写明「没测到 / 推测」，不编。
>
> 一句话结论：**Harbor 的内置浏览器把自己是谁直接写在脸上**（UA 里带 `harbor-agent/1.30.0`
> 与 `Electron/44.3.0`），并且**完全不发 Client Hints**。这两条是所有反爬厂商的现成判据。
> 但——本轮**没能复现出"被拦截"**（见 §2.3，这一点必须诚实说清）。

---

## 1. 当前实现地图（文件 + 行号）

| 面 | 在哪 | 关键行 |
|---|---|---|
| **内嵌浏览器元素** | `src/components/layout/BrowserTab.tsx` | L249-285 `<webview>`；**L262 `partition="persist:agent-browser"`**；L263 `webpreferences="sandbox=yes,contextIsolation=yes,nodeIntegration=no"`；L264 `allowpopups="true"` |
| **主窗口隔离** | `electron/main.cjs` | L93-100 `webPreferences`（L95 contextIsolation / L96 nodeIntegration / L97 sandbox / **L99 `webviewTag: true`**） |
| **用户数据路径** | `electron/main.cjs` | L53-54 硬设到 `<data>/chromium`（不写 C 盘） |
| **命令行开关** | `electron/main.cjs` | **L59-60，全仓只有这两个**：`disk-cache-dir` / `disable-gpu-shader-disk-cache` |
| **webview 加固** | `electron/navigation-policy.cjs` | **L125-132 `hardenWebview()`**（`delete preload` + nodeIntegration=false + contextIsolation=true + sandbox=true + webSecurity=true）；L147-149 挂 `will-attach-webview` |
| **导航拦截** | `electron/navigation-policy.cjs` | L33-78 `decide()`；L95-116 `wireNavigationGuard` |
| **权限闸** | `electron/core/webview-permissions.cjs` | **L29 `HARMLESS = {'fullscreen','clipboard-sanitized-write'}`**；L32 `PARTITION`；L35-37 `decide`；L49-67 `install`（request + check 两个 handler） |
| **权限闸装在哪** | `electron/handlers/browser.cjs` | L224-240 `app.whenReady()` → `session.fromPartition(PARTITION)` → `webviewPermissions.install` |
| **下载接管** | `electron/handlers/browser.cjs` | L229-238 `downloadIntake.install` |
| **主进程驱动（CDP）** | `electron/core/cdp.cjs` | 全文（`attach` / `send` / `evaluate` / `getFullAxTree`） |
| **渲染层驱动** | `src/components/layout/browser/useBrowseDriver.ts` | L60-86 推 `webContentsId` |
| **preload** | `electron/preload.cjs`（299 行） | **只给主窗口**；webview 侧被 `hardenWebview` 主动 `delete`（L126） |

### 1.1 几个「没有」也很重要（都是全仓搜出来的）

| 项 | 结论 | 取证 |
|---|---|---|
| **UA 设置** | **全仓没有 `setUserAgent`**。只有 `electron/core/search.cjs:43` 给**搜索 API**发了 UA（那是主进程出网，与浏览器无关） | `findstr /s /n /i "setUserAgent useragent user-agent" electron\*.cjs electron\core\*.cjs` |
| **反检测脚本** | **一处都没有**。没有 `navigator.webdriver` / `plugins` / `chrome` 的任何改写 | 同上 + `addScriptToEvaluateOnNewDocument` 全仓搜不到 |
| **webview 的 preload** | **没有**（且 `navigation-policy.cjs:126` 明确 `delete`） | 读 L125-132 |
| **新依赖** | 无（本轮零引入） | — |

---

## 2. 实测记录

### 2.1 请求头铁证（本地 HTTP 探针）

**做法**：本地起一个记录请求头的服务器，让 Harbor 的 webview 访问它。
取证脚本：`tmp/_browser_probe.mjs`（本轮临时文件，非产品代码）。

`GET /landing` 实际收到的请求头：

```
user-agent : Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
             (KHTML, like Gecko) harbor-agent/1.30.0 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36
accept                    : text/html,application/xhtml+xml,...
sec-ch-ua                 : 【无】
sec-ch-ua-mobile          : 【无】
sec-ch-ua-platform        : 【无】
accept-language           : zh-CN
accept-encoding           : gzip, deflate, br, zstd
sec-fetch-site/mode/user/dest : 有（正常）
全部键（11 个）: host, connection, upgrade-insecure-requests, user-agent, accept,
                sec-fetch-site, sec-fetch-mode, sec-fetch-user, sec-fetch-dest,
                accept-encoding, accept-language
```

→ **UA 里明明白白写着 `harbor-agent/1.30.0` 和 `Electron/44.3.0`**，且**一个 Client Hint 都没有**。

### 2.2 决定性对照：真 Chrome 访问同一个地址

**做法**：同一个本地地址，让「Harbor 的 webview」和「本机真 Chrome」各访问一次，
对比服务器收到的请求头。取证脚本：`tmp/_browser_probe3.mjs`。

| 请求头 | Harbor webview | 本机 Chrome |
|---|---|---|
| `user-agent` | `...harbor-agent/1.30.0 Chrome/152.0.7977.78 Electron/44.3.0...` | `...HeadlessChrome/156.0.0.0...` |
| `sec-ch-ua` | **【无】** | `"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"` |
| `sec-ch-ua-mobile` | **【无】** | `?0` |
| `sec-ch-ua-platform` | **【无】** | `"Windows"` |
| `accept-language` | `zh-CN` | `zh-CN,zh;q=0.9` |
| 请求头总数 | 11 | 15 |

→ **这一条排除了「http 下本来就不发 CH」这个解释** —— 同一个地址、同一台机器，
Chrome 发三件套，Harbor 一个都不发。**这是 Harbor 独有的缺口，不是环境问题。**

### 2.3 真实站点实测 —— ⚠️ 本轮**没有复现出拦截**

| 站点 | Harbor 表现 | 说明 |
|---|---|---|
| `https://example.com/` | ✅ 正常（标题 `Example Domain`，正文 911 字符） | — |
| `https://www.cloudflare.com/` | ✅ **正常**（标题、9,317 字符正文、h1 都正常） | 官网本身没上挑战 |
| `https://nowsecure.nl/` | ⚠️ 正文只有 `NOWSECURE BY NODRIVER`（43 字符），并出现 2 个 Cloudflare Turnstile iframe | **见下，不是拦截** |
| `https://bot.sannysoft.com/` | ✅ 检测表能正常打开（见 2.4） | 指纹检测站 |
| `https://arh.antoinevastel.com/bots/areyouheadless` | ❌ `502 Bad Gateway`（站点自身故障，nginx） | 与 Harbor 无关 |

**关于 nowsecure.nl 必须说清（这是本轮最容易误判的一条）**：
Harbor 打开它时，target 列表里**同时出现两个 Cloudflare Turnstile 挑战 iframe**
（`challenges.cloudflare.com/cdn-cgi/challenge-platform/.../turnstile/`），
正文停在 `NOWSECURE BY NODRIVER`。看起来像"卡在验证"。

**但我用本机真 Chrome 访问同一个站，看到的内容一模一样**（标题 `nowsecure.nl`、
正文 `NOWSECURE BY NODRIVER`、同样两个 Turnstile iframe）。
取证脚本：`tmp/_browser_probe7.mjs`。

→ **结论：那不是 Harbor 被拦，是那个站本身就是这个内容**（它是个 3D 展示页）。
**本轮我没有复现出用户说的"经常被拦截"。**

这不妨碍方案的成立 —— UA 暴露 + 无 CH 是**客观存在的暴露面**（§2.1/2.2 是硬证据），
只是"它导致拦截"这一步，我这次没拿到现场。要真正确认，需要用户给出**具体被拦的 URL**
（见 §6 的验证计划）。

### 2.4 指纹检测站：`bot.sannysoft.com` 实测表

| 检测项 | Harbor 实测结果 | 判定 |
|---|---|---|
| **User Agent** | `...harbor-agent/1.30.0 Chrome/152.0.7977.78 Electron/44.3.0...` | ★ **暴露** |
| WebDriver (New) | `missing (passed)` | ✅ 过 |
| WebDriver Advanced | `passed` | ✅ 过 |
| Chrome (New) | `present (passed)` | ✅ 过 |
| Permissions (New) | `granted` | ⚠️ 见 §3.6（与真 Chrome 默认 `default` 不同） |
| Plugins Length | `5` | ✅ 与真 Chrome 一致 |
| Plugins is of type PluginArray | `passed` | ✅ 过 |
| Languages | `zh-CN,zh-Hans-CN,en-US` | ✅ 正常 |
| WebGL Vendor / Renderer | `Google Inc. (NVIDIA)` / `ANGLE (NVIDIA, NVIDIA GeForce GTX 950M ... D3D11)` | ✅ 真实 GPU |
| Broken Image Dimensions | `16x16` | ✅ 正常 |

**这张表只报了一行异常：UA。** 其余常见特征（webdriver / plugins / WebGL）Harbor 都过。

### 2.5 API 与方案可行性实验（隔离环境）

**A. UA 该走哪条路 —— 三条路我都试了**（`tmp/_ua_exp2.cjs` / `_ua_exp3.cjs`）

| 路子 | 实测结果 |
|---|---|
| `app.userAgentFallback = <UA>` | ❌ **赋值直接把进程搞崩**（无异常，静默退出）—— 不能走 |
| `app.commandLine.appendSwitch('user-agent', UA)` | ❌ **没生效**（请求头 UA 未变） |
| `session.setUserAgent(ua, acceptLanguages)` | ✅ **有效**（`getUserAgent()` 与请求头都变了） |
| `ses.webRequest.onBeforeSendHeaders` | ✅ **有效**（能改 UA，也能补 CH，见 B） |

**B. Client Hints 能不能补上**（`tmp/_ua_exp4.cjs`）—— **这是方案的关键，实测可行**：

```
装了 onBeforeSendHeaders 之后，服务器实际收到：
  user-agent        : ...Chrome/152.0.0.0 Safari/537.36      ← 已是标准 Chrome UA
  sec-ch-ua         : "Not:A-Brand";v="8", "Chromium";v="152", "Google Chrome";v="152"
  sec-ch-ua-mobile  : ?0
  sec-ch-ua-platform: "Windows"
  accept-language   : zh-CN,zh;q=0.9,en;q=0.8
```

**C. 只 setUserAgent 不够**（`tmp/_ua_exp3_session.cjs`）：
UA 变了，但 `sec-ch-ua` 仍**没有**；且 `accept-language` 变成了
`zh-CN,zh;q=0.9;q=0.9,en;q=0.8;q=0.8` —— **Electron 把 q 值重复了一遍**（明显畸形，比不发还糟）。
→ 所以 **UA 与 CH 必须一起处理**，只改 UA 会留下"UA 说 Chrome、CH 说没有"的矛盾。

### 2.6 权限实测（产品口径复刻）

复刻 `webview-permissions.cjs` 的口径跑一遍：

```
Notification.permission : denied
notifications     : denied      clipboard-read : denied     clipboard-write : granted
geolocation       : denied      camera : denied             microphone      : denied
persistent-storage: denied      midi : denied               accelerometer   : denied
```

→ **权限闸工作正常，而且比真 Chrome 更紧**（真 Chrome 里 `Notification.permission`
默认是 `default` = "还没问过"）。**这一面不是拦截原因。**

---

## 3. 根因清单（每条带代码位置 + 实测值）

> 分三档：**★ 确认暴露**（有实测值）· **◇ 推断**（有实测值但"是否被用作判据"未证）· **✅ 实测无问题**（别浪费工）｜

### 3.1 ★ UA 直接自报家门

- **实测值**：`...harbor-agent/1.30.0 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36`
- **代码位置**：**没有设置处** —— 这是 Electron 的默认 UA（`app.userAgentFallback`，
  实测值 `...Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36`，应用名是 Electron 自动拼的）
- **为什么是问题**：反爬厂商的规则库里，"UA 含 `Electron`" 与 "UA 含非浏览器产品名"
  都是低成本高分判据。**这是最该修的一条，也最好修。**

### 3.2 ★ Client Hints 完全缺失

- **实测值**：`sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` **三个全无**
- **对照**：同一地址真 Chrome 三个全发（§2.2）
- **代码位置**：**没有设置处**
- **为什么是问题**：现代风控（Cloudflare / Akamai / 各家 WAF）**优先读 CH**。
  "UA 说是 Chrome 152，但一个 CH 都没有" —— 这是**自相矛盾**，比 UA 本身更容易被挑出来。
  而且 `sec-ch-ua` 缺失是**很难伪造得自然**的一项：真 Chrome 一定会发。

### 3.3 ★ `navigator.userAgentData.brands` 缺 `Google Chrome`

- **实测值**：`[{"brand":"Not?A_Brand","version":"24"},{"brand":"Chromium","version":"152"}]`
- **真 Chrome 对照**（本机）：`[{"brand":"Not:A-Brand","version":"8"},{"brand":"Chromium","version":"156"},{"brand":"Google Chrome","version":"156"}]`
- **代码位置**：没有设置处（Chromium 按 UA 推导）
- **三个具体异常**：① 缺 `Google Chrome` 品牌；② `Not?A_Brand` 的 `?` 位置不对
  （真 Chrome 是 `Not:A-Brand`）；③ GREASE 版本号 `24` 不像真 Chrome 的 `8`。
  → **注意**：③ 可能随版本变化，不宜照抄；① 才是硬的。

### 3.4 ★ `window.chrome` 是空对象

- **实测值**：`typeof window.chrome === 'object'`，**`Object.keys(window.chrome) === []`**
- **真 Chrome 对照**：`["loadTimes","csi","app"]`
- **代码位置**：没有设置处
- **◇ 但要小心**：这三样在真 Chrome 里是 **native binding**，返回值有特定形状
  （`csi()` 返回带 `onloadT` / `startE` 等真实时间戳）。**用 JS 假造一个 `{loadTimes(){},csi(){}}`
  可能比空对象更容易被识破** —— 这条我**建议不动**，理由见 §4.3。

### 3.5 ★ `accept-language` 与 JS 自报不一致

- **实测值**：请求头 `accept-language: zh-CN`（单值），而 JS 里 `navigator.languages`
  = `["zh-CN","zh-Hans-CN","en-US"]`
- **真 Chrome 对照**：请求头 `zh-CN,zh;q=0.9`
- **代码位置**：没有设置处
- **为什么是问题**：**请求头与 JS 不一致本身就是判据**（真实浏览器两者由同一处配置推导）。
  且只 setUserAgent 会把 q 值弄坏（§2.5-C，实测 `zh-CN,zh;q=0.9;q=0.9,...`）。

### 3.6 ◇ 权限全 `denied`（推断，未证）

- **实测值**：`Notification.permission === 'denied'`（真 Chrome 默认 `'default'`）
- **代码位置**：`electron/core/webview-permissions.cjs:29` 的 `HARMLESS` 白名单
  （只有 `fullscreen` / `clipboard-sanitized-write`，其余全拒）
- **◇ 这一条我很不确定**：理论上"所有权限都被用户拒绝过"对一个真人浏览器很反常，
  可能被当特征。但我**没有实测证据**证明它导致拦截；而且**放开权限的代价更大**
  （见 §5）。所以列为"知道有这回事"，**不建议改**。
- **一处我解释不了的矛盾**：sannysoft 表里 `Permissions` 显示 `granted`，
  而我实测 `navigator.permissions.query` 全是 `denied`（§2.6）。
  我没查清 sannysoft 那一行的判据 —— **如实标注，不下结论**。

### 3.7 ◇ GPU 合成走软件渲染

- **实测值**：`app.getGPUFeatureStatus().gpu_compositing === 'disabled_software'`
- **代码位置**：`electron/main.cjs:59-60` 只关了 **shader 磁盘缓存**（避免写 C 盘），
  **没关 GPU** —— 所以软渲染多半是环境（无显示 / 远程会话 / 驱动）导致
- **为什么可能相关**：WebGL renderer 仍报真实 GPU（`sannysoft` 实测通过），
  所以**指纹面没问题**；但软渲染会影响**帧率**，进而影响某些行为判据（鼠标轨迹等）。
- **我不建议本轮动它**：理由见 §4.4。

### 3.8 ✅ 实测「其实没问题」的（别在这里浪费工）

| 项 | 实测值 | 判定 |
|---|---|---|
| `navigator.webdriver` | `false` | ✅ 正常（新式 WebDriver 检测也 passed） |
| `navigator.plugins` | 5 个（PDF Viewer 系列），是真正的 `PluginArray` | ✅ 与真 Chrome 一致 |
| `navigator.platform` | `Win32` | ✅ 真 Chrome 也是 `Win32` |
| `navigator.vendor` / `productSub` | `Google Inc.` / `20030107` | ✅ 正常 |
| WebGL vendor/renderer | 真实 NVIDIA GTX 950M + ANGLE/D3D11 | ✅ 正常 |
| `process` / `require` / `module` / `global` | 全部 `undefined` | ✅ 沙箱有效 |
| 窗口内注入的应用 API | 只有 `ondragenter` / `originAgentCluster`（非自定义） | ✅ 没泄露 `workbench` |
| 时区 / 屏幕 / devicePixelRatio | `Asia/Shanghai` / 1920x1080 / 1 | ✅ 正常 |

---

## 4. 方案设计

**总原则**：只补「真实浏览器一定会有的东西」，**不伪造「需要 native 支撑的东西」**。
判据是：**伪造得像 vs. 不伪造，哪个更容易被识破。** 这一条决定了 §4.2/4.3 的取舍。

### 4.1 【核心】UA 与 Client Hints 一起补

**做法**（两处，都在**主进程**）：

```
① 新建 electron/core/browser-identity.cjs
   - CHROME_UA 常量（版本号从 process.versions.chrome 取，不写死）
   - install(ses, { log })：
       ses.setUserAgent(CHROME_UA, 'zh-CN,zh;q=0.9,en;q=0.8')
       ses.webRequest.onBeforeSendHeaders(...)   ← 补 sec-ch-ua 三件套 + Accept-Language

② electron/handlers/browser.cjs:226-227 那一处
   （已经拿到 session.fromPartition，加一行 install 即可）
```

**为什么两处都要**（实测依据 §2.5-C）：只 `setUserAgent` → UA 变了但 CH 没有（自相矛盾）；
只 `onBeforeSendHeaders` → JS 层 `navigator.userAgent` 还是旧的（又一层矛盾）。
**必须两处一起，UA 与 CH 才同源。**

**版本号怎么取**：`process.versions.chrome`（如 `152.0.7977.78`）→ 取主版本 `152`。
不写死（写死会在 Electron 升级后漂）。GREASE 品牌那一项（`Not:A-Brand`）**照当前 Chrome 的
写法拼即可，但要留注释说明它随 Chrome 变**。

**风险**：低。只影响 `persist:agent-browser` 这一个分区（主窗口 session 不碰）。

### 4.2 【核心】JS 层的 `userAgentData.brands`

**做法**：需要往 webview 里注入脚本。三条路对比（都实测过 API 存在性）：

| 方式 | 落点 | 实测/评估 |
|---|---|---|
| **webview preload** | 改 `navigation-policy.cjs:126`（现在 `delete preload`）+ 新建一个 preload 文件 | 最干净；但要**动 `hardenWebview`**（那是安全加固），且 webview preload **必须自带全套**（沙箱下不能 require 兄弟模块 —— 项目里踩过，见 `preload.cjs` 文件头 L10-11） |
| `executeJavaScript` | 渲染层 driver | ❌ **时机不对**：页面脚本可能已先跑过（反爬脚本通常在最前面） |
| CDP `Page.addScriptToEvaluateOnNewDocument` | 主进程 | ✅ 时机对（新文档创建前），但**只在已 attach 的 webContents 上生效**，而 browse 是"用时才 attach" —— 对**用户手动输入地址**的场景覆盖不到 |

**我的建议**：走 **preload**，但**范围压到最小** —— 只改 `userAgentData.brands`
（以及配合 §4.1 让 `navigator.userAgent` 一致）。
**注意**：这一步会让 `hardenWebview` 不再 `delete preload`，属于**动安全加固层**，
按 AGENT.md 是硬禁区 —— **必须单独批准**。

**也可以先不做这一层**：§4.1 做完后，`navigator.webdriver`/`plugins`/`WebGL` 本来就是干净的，
剩下的 `brands` 缺口影响面比 UA/CH 小得多。**建议放进第二批，看第一批效果再定。**

### 4.3 【明确不做】伪造 `window.chrome`

- 实测它现在是空对象（§3.4），但真 Chrome 的 `loadTimes` / `csi` / `app` 是 native binding。
- 用 JS 造 `csi()` 必须返回形状正确的时间戳对象，造得不对**比空对象更可疑**
  （检测脚本会对比 `csi().onloadT` 与 `performance.timing`）。
- **结论：这一条不建议做。** 收益不确定、风险明确。

### 4.4 【明确不做】动 GPU / WebGL

- 指纹面实测是干净的（真实 GPU、真 ANGLE 字符串，§3.8）。
- `disabled_software` 是**环境**导致（主进程只关了 shader 磁盘缓存，没关 GPU）。
- 用户机器是 **i5-6400（老机器）**：改 GPU 相关开关要拿改前/改后帧率数字说话，
  属于另一个议题。**本轮不碰。**

### 4.5 会话与权限

| 项 | 现状 | 建议 |
|---|---|---|
| 持久化 session | ✅ `persist:agent-browser` | **保持**（cookie / 登录态本来就该留） |
| 无害权限（全屏、剪贴板写入） | ✅ 已自动放行 | **保持** |
| 通知 / 地理位置 / 摄像头 / 麦克风 / 读剪贴板 | ✅ 默认全拒 | **保持**（理由：放开才是真风险；而且"全部拒绝"这个特征我没证据说它有害） |

---

## 5. 改动文件清单 + 硬禁区判定

### 5.1 第一批（建议只做这批）

| # | 文件 | 改什么 | 新增/改 |
|---|---|---|---|
| 1 | `electron/core/browser-identity.cjs` | **新建**：UA 常量 + CH 补齐 + `install(ses)` | 新增 |
| 2 | `electron/handlers/browser.cjs` | L226 之后加一行 `browserIdentity.install(ses, log)` | 改（1 行） |
| 3 | `scripts/selftest/groups/XXX-browser-identity.mjs` | **新建**断言：UA 不含 Electron/harbor-agent、CH 三件套齐、Accept-Language 无畸形 q | 新增 |
| 4 | `CHANGELOG.md` | 记账 | 改 |

### 5.2 第二批（要不要做，看第一批效果）

| # | 文件 | 改什么 | ⚠️ |
|---|---|---|---|
| 5 | `electron/core/browser-preload.cjs` | **新建**：最小注入（`userAgentData.brands`） | 新增 |
| 6 | `electron/navigation-policy.cjs` | L126：不再 `delete preload`，改为挂上上面那个 | **动安全加固层** |
| 7 | `src/components/layout/BrowserTab.tsx` | L263 `webpreferences` 可能要跟着调 | 改 |

### 5.3 硬禁区判定

| 禁区 | 第一批 | 第二批 |
|---|---|---|
| #1 改动 ≥3 个文件 | ✅ **命中**（4 个） | ✅ **命中**（3 个） |
| #8 动内核关键文件（`loop/task/session/changeset`） | ❌ 未命中 | ❌ 未命中 |
| #9 新增/改 IPC 通道 | ❌ **未命中**（复用现有 `session`，不新增通道） | ❌ 未命中 |
| #10 动**权限/安全模型** | ⚠️ **部分命中**：`handlers/browser.cjs` 是权限闸的装配处（但只加一行 install，**不改权限判定**） | ✅ **命中**：`navigation-policy.cjs` 的 `hardenWebview` 属于安全加固 |
| #12 往系统提示加数据 | ❌ 未命中 | ❌ 未命中 |
| 影响 Runtime / 会话 / 队列 | ❌ 未命中 | ❌ 未命中 |

**结论**：**第一批也命中硬禁区 #1**（4 个文件）→ **需要你批准**。
**第二批额外命中 #10**（动 `hardenWebview`）→ **要单独批准**。

**我建议**：先批**第一批**（不动安全加固层、不新增 IPC、不碰权限判定），
跑一段看效果；第二批等第一批的结果。

---

## 6. 验证方式

### 6.1 真机走查（每次改完必做）

```bash
npm run shot:electron -- --dev --js-file=tmp/<走查脚本>   # 起源码树实例，隔离
```

| 看什么 | 判据 | 怎么取 |
|---|---|---|
| **UA 不含应用标识** | 请求头 UA 里**搜不到** `harbor-agent` / `Electron` | 本地探针服务器（复用本轮 `tmp/_browser_probe3.mjs` 的做法） |
| **CH 三件套齐** | `sec-ch-ua` / `-mobile` / `-platform` 都有，且 `sec-ch-ua` 里**有 `Google Chrome`** | 同上 |
| **UA 与 JS 一致** | 请求头 UA === 页面内 `navigator.userAgent` | CDP 读 webview |
| **Accept-Language 无畸形** | 不含 `;q=0.9;q=0.9` 这种重复 | 请求头 |
| **权限闸没被碰坏** | `notifications/geolocation/camera/microphone` 仍 `denied`；`fullscreen` 仍放行 | 复用本轮 `tmp/_perm.cjs` |
| **导航策略没被碰坏** | 跨站跳转仍拦；`file://` 仍拦 | 自检 `09-browser` 组 + 手动点一个外链 |
| **指纹站对照** | `bot.sannysoft.com` 的 UA 一行变成标准 Chrome；其余行不变 | 复用本轮 `tmp/_detect.cjs` |
| **不误伤主窗口** | 主窗口 session 的 UA **不该变**（只有 `persist:agent-browser` 变） | 读主窗口请求 / `session.defaultSession.getUserAgent()` |

### 6.2 「到底有没有被拦」—— 需要你给一个真实现场

本轮**没复现出拦截**（§2.3）。要让验证有说服力，请提供一个**你实际被拦的 URL**
（以及当时的现象：白屏 / 验证循环 / 403）。**有现场才能证明"改完真的有用"** ——
否则我只能证明"特征面变干净了"，证明不了"拦截消失了"。

### 6.3 回归（防止改坏）

```bash
npm run verify        # 全链：typecheck / lint / 内核自检 / 行数 / 单测 / 构建
npm test              # 内核自检（改 electron/**/*.cjs 必跑）
```

---

## 7. 安全与合规声明

### 7.1 本方案**只**用于

- 让内置浏览器在**正常访问公开网页**时不被误判为机器人；
- 补齐真实浏览器**本来就会发**的标准请求头（UA / Client Hints / Accept-Language）。

### 7.2 本方案**不用**于（明确不做）

| 不做 | 说明 |
|---|---|
| **绕过登录 / 账号体系** | 不伪造身份、不伪造会话、不代填凭据 |
| **绕过付费墙 / 访问控制** | 不改动任何"受控内容"的取得方式 |
| **绕过验证码 / 人机挑战** | **不**自动解验证码、**不**打码、**不**伪造挑战 token。挑战该弹就弹，等你自己过 |
| **非法抓取 / 批量爬取** | 不改频率限制、不做并发伪装 |
| **社会工程 / 伪装成真人去骗系统** | 目标是"不被误判"，不是"骗过风控去做它本该拦的事" |
| **伪造 native 指纹** | 不造 `window.chrome.csi/loadTimes`、不改 WebGL 指纹（§4.3/4.4） |

### 7.3 边界不变

- **权限模型不动**：敏感权限仍默认全拒（§4.5）。
- **导航/网络策略不动**：该拦的跨站跳转、`file://`、禁止名单，一条都不放开。
- **安全加固不动**（第一批）：`hardenWebview` 的其余四项（`nodeIntegration=false` /
  `contextIsolation=true` / `sandbox=true` / `webSecurity=true`）**保持**。
- **用户可见**：改了 UA 这件事应该在文档里写明（不要让用户以为它就是 Chrome）。

### 7.4 一处需要你拍板的取舍

改 UA 之后，"这个浏览器是不是 Chrome"这个问题上，**应用会对网页说一个善意的假话**。
这是反检测的常规做法（所有内嵌浏览器都这么干），但它确实**降低了透明度**。
按本项目"透明优先"的一贯口径，我建议在 `SECURITY.md` 的「没有做什么」里
**加一条如实说明**：*"内置浏览器的 UA 会伪装成标准 Chrome；这是为了避免被误判为机器人，
不改变权限、不绕过任何访问控制。"*

---

## 附：本轮取证脚本（临时文件，均在 `tmp/`，非产品代码）

| 脚本 | 干什么 |
|---|---|
| `tmp/_browser_probe.mjs` | 本地探针 + 读 webview 指纹（§2.1） |
| `tmp/_browser_probe2.mjs` | 尝试抓 https 的 Client Hints |
| `tmp/_browser_probe3.mjs` | **同址对照**：Harbor vs 真 Chrome（§2.2） |
| `tmp/_browser_probe4.mjs` / `_5` / `_6` | 真实站点实测 + nowsecure 深读（§2.3） |
| `tmp/_browser_probe7.mjs` | 真 Chrome 访问 nowsecure 对照（§2.3 关键） |
| `tmp/_ua_experiment.cjs` / `_ua_exp2` / `_ua_exp3` / `_ua_exp4` | UA 三条路 + CH 补齐可行性（§2.5） |
| `tmp/_detect.cjs` | 指纹检测站（§2.4） |
| `tmp/_perm.cjs` | 权限实测（§2.6） |
| `tmp/_api_check.cjs` | Electron UA API 存在性 |

**这些脚本跑完即弃，没有改动任何产品代码。** `git status` 应只剩本轮新增的这份文档。
