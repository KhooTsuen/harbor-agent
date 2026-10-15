# Harbor 安全策略与安全假设

> **这份文档的目标不是让你放心，而是让你知道边界在哪。**
>
> 它描述 Harbor **真实**的安全姿态：哪些地方它替你挡了，哪些地方它**根本不挡**。
> 每一条都能在对应源码里找到实现（路径都写出来了），也能用 `npm test` 或
> 设置 →「权限与安全」页面自己核对。**如果你只读一段，请读第 1 节。**

---

## 1. 默认安全假设：你对自己的 API Key 和本地文件负责

**Harbor 不是沙箱。它不是为“运行不可信代码”而设计的。它假设你是可信用户，
假设你清楚自己在让模型对什么做事。**

具体来说，这句话意味着：

| 假设 | 含义 | 后果（你要知道的） |
|---|---|---|
| **你信任你配的模型** | 模型会看到你让它读的文件内容、会话历史、以及系统提示 | 别把你不放心交给第三方的机密，放在让它读得到的地方 |
| **你对 API Key 负责** | 密钥由你填入、由你的账号扣费、泄露风险由你承担 | 见第 6 节：它如何存、什么时候是明文 |
| **你对本地文件负责** | 它能读写你工作目录里的文件，默认能跑 shell 命令 | **它会改坏你的文件**。它内置了改动撤回，但那**不是备份** |
| **你自己判断“该不该批准”** | 它弹确认框时，是在把决定权交给你 | 闭着眼睛点“允许”，等于把上面的假设全部作废 |
| **你不指望它替你隔离模型** | 模型输出的命令**就在你的机器上、以你的身份**执行 | 没有虚拟机、没有容器、没有 seccomp。见第 3 节 |

> **一句话**：Harbor 的安全模型是「**事先的护栏 + 事后的账本**」，不是「**运行时隔离**」。
> 护栏（权限档 / 风险分级 / 确认框）帮你**少犯错**；账本（审计 / 改动快照 / 撤回）
> 帮你在犯错后**查得到、退得回**。它**不会**把模型的破坏力限制在一个笼子里 ——
> 因为那个笼子就是你的机器。

---

## 2. 它真的做了什么

下面每一条都指得出实现文件。**这些是降低误操作的措施，不是安全认证。**

### 2.1 进程与窗口隔离

| 项 | 状态 | 位置 |
|---|---|---|
| 渲染层 `contextIsolation: true` | ✅ 开 | `electron/main.cjs` |
| 渲染层 `nodeIntegration: false` | ✅ 关（渲染层没有 Node） | `electron/main.cjs` |
| 渲染层 `sandbox: true` | ✅ 开 | `electron/main.cjs` |
| 渲染层只能走 preload 白名单 IPC | ✅ | `electron/preload.cjs`、`electron/ipc-channels.cjs` |
| 外链走白名单 + 导航策略 | ✅ | `electron/core/url-policy.cjs`、`electron/navigation-policy.cjs` |
| 内嵌浏览器（右栏网页标签）挂载时强制加固 | ✅ `sandbox` / `contextIsolation` / `webSecurity` 全开、关 `nodeIntegration`、删 preload | `electron/navigation-policy.cjs` 的 `hardenWebview()` |
| 网页权限请求**默认全拒** | ✅ 摄像头 / 麦克风 / 录屏 / 定位 / 读剪贴板都要不到 | `electron/core/webview-permissions.cjs` |

> ⚠️ 顺带说清一个**容易被读反**的点：主窗口的 `webPreferences` 里
> `sandbox: true` 与 `webviewTag: true` **是并存的**（同一个对象，`main.cjs`）——
> 后者是内嵌浏览器这条功能所必需的。
> 也就是说：**「渲染层 sandbox」保护的是应用自己的界面，不是它去逛的网页。**
> 网页那侧的隔离靠上面那两行（挂载时 `hardenWebview` + 权限全拒），
> 而**这正是那两行存在的原因** —— 能开 webview 就说明这一层得单独加固。别把两套混为一谈。

**渲染层拿不到密钥**：`config.forRenderer()` 把 `apiKey` 一律返回掩码 `••••••••`，
真实值只在主进程发请求那一刻取（`electron/core/config.cjs`）。preload **没有**
暴露任何“给我密钥”的接口。

### 2.2 文件访问：能力边界

`electron/core/capability.cjs` —— 三档（`FILE_SCOPES`，**默认第一档**）：

| 档 | 行为 |
|---|---|
| `workspace`（**默认**） | 只在工作目录内自由读写；出去要授权 |
| `granted` | 工作目录 + 你批准过的路径 |
| `full` | 不设限（你在设置里明确选的） |

另外两层：

- **敏感路径**（`capability.cjs` 的 `SENSITIVE` 表）：**即使在工作目录里**，碰到
  `.ssh/`、`id_rsa`、`.aws/credentials`、`.env`、`.git-credentials`、`.npmrc`、
  浏览器 `Cookies` / `Login Data` / `Local State`、浏览器 Profile 目录、`.docker/config.json`、
  `.kube/config`、Windows 凭据存储目录 —— **也要单独批准**，确认框里会写明「为什么敏感」。
- **软链接逃逸防护**：所有路径先过 `fs.realpathSync.native` 再判断，且**用 realpath 之后的
  结果继续操作** —— 防止「先过检查、后换软链接」（TOCTOU）那条路
  （`electron/core/tools/_shared.cjs`）。

授权记录在 `data/capabilities.json`，支持**一次性 / 本会话 / 永久**三种。

### 2.3 Shell：按行为分级，不按命令名

`electron/core/risk.cjs` —— 命令按**它会造成什么**打四档：

```
low      只读、无副作用
medium   有副作用但可恢复
high     可能毁数据
critical 明确危险（格式化磁盘、递归删除、改注册表、提权…）
```

**两层分工**（`electron/core/tools/risk-gate.cjs`）：

- `shellPolicy`（设置 → 权限与安全 → Shell 风险策略）决定**这一类怎么办**：allow / ask / block
- `permission`（工具权限三档）决定**要不要打扰你**：

| 权限档 | 行为 |
|---|---|
| `readonly` | 不能写、不能跑修改性命令（写操作直接被拒） |
| `ask`（**默认**） | 写操作、中/高风险命令都会弹确认框 |
| `full` | **不问**（界面上写着「不给任何确认」），只留审计 |

**开箱默认值**（`electron/core/config-defaults.cjs`）：

```js
shellPolicy: { medium: 'ask', high: 'ask', critical: 'block' }
```

也就是说：**默认状态下，会毁数据的命令（critical）连问都不问，直接拒。**

> ⚠️ **准确的边界**：`critical: 'block'` 来自**默认值**，不是硬编码。
> `risk.decide()` 的实现是 `policy?.[level] ?? fallback[level]` —— **你把这个策略改成
> `allow`，它就会放行**（这是设计：设置里写了什么，执行时就照做，不做“偷偷降级”）。
> 所以“critical 一定拦得住”的说法**不成立**；准确的说法是“**默认**拦得住，改了就不拦”。

### 2.4 网络：一个会执行的策略，但**它不是防火墙**

`electron/core/net-policy.cjs` + `config-security.cjs` —— 全局网络策略，
**默认 `mode: 'ask'`**（写错也是 ask，fail-closed）：

- `deny` 一律不许；`ask` 每次先问；`allow` 不问就放行
- `denyHosts` **优先于** `allowHosts`
- 云元数据 / 链路本地地址（`169.254.0.0/16`）**任何档位都硬拒**（防 SSRF 读云凭据）

**它到底管哪几步 —— 这一条最容易误解，写准确：**

`net-policy.decide()` 只接受四种 `kind`：`'shell' | 'mcp' | 'webview' | 'skill'`。
实际接入的**只有 4 个点**：

| 接入点 | 管的什么 |
|---|---|
| `run_shell`（`tools/run_shell.cjs`） | 命令里的**联网语义**（`curl` / `git clone` / 下载…） |
| MCP 启动门（`mcp-network-guard.cjs`） | 要不要启动这个 MCP 服务器 |
| 浏览工具（`tools/browse.cjs`） | 主动访问的 URL |
| 浏览器跳转（`navigation-policy.cjs`） | 网页里点链接**跳去哪** |

> ⚠️ **它管不到应用自身的 API 请求。** 模型调用（`llm.cjs`）、搜索（`search.cjs`）、
> 生图（`image-task.cjs`）、下载（`download-engine.cjs`）、图片读取（`image-load.cjs` /
> `image-save.cjs`）都**不经过** `net-policy` —— 那些是你配置的功能，能跑就会跑，
> 网络策略**不会**因为它们的目标主机不在 `denyHosts` 里而额外拦一道。
> （`config-security.cjs` 的一句注释说它「能管到应用自己发起的网络请求」，**与实测不符**，
> 以这里和代码为准。）
>
> **它管不到**：MCP 子进程自己发的流量、浏览器标签页里的第三方脚本、你系统里别的程序。
>
> **真正要限制网络，靠系统防火墙或虚拟机，不是靠这个开关。**

**应用自身的网络出口**：主要实现是 `core/http.cjs`。它有两个出口，
**行为不同，这一点很关键**：

| 出口 | 底层 | 谁在用 | 读系统代理吗 |
|---|---|---|---|
| `fetch()` | Chromium 的 `net.fetch` | `image-task` · `llm-probe` · `search` | ✅ 读 |
| `fetchStream()` | Node 的 undici（全局 fetch） | **`llm.cjs`（聊天主路径）** | ❌ **不读** |

> ⚠️ 也就是说：**聊天 / 推理这条主路径不走系统代理**。这是有意的取舍 —— `net.fetch`
> 的响应体在流卡住时会把主线程一起拖死（2026-09-25 真机踩过：整个主进程几分钟零日志），
> undici 的 `read()` 才是真异步，空闲看门狗能按时把挂住的请求报成可重试的 timeout。
> 代价就是挂代理的用户聊天会失败（见 `http.cjs` 的注释）。

**另有 3 个模块用裸 `fetch`，完全不经过 `http.cjs`**：

```
core/download-engine.cjs   下载（含并行分段；自带超时）
core/image-load.cjs        读取 http(s) 图片（无超时封装）
core/image-save.cjs        读取 http(s) 图片（无超时封装）
```

**没有任何遥测 / 上报**（全仓无 telemetry / analytics / sentry 之类）。
（以上都能用本文件末尾的命令自己复核 —— 注意要同时扫 `fetch` 与 `fetchStream`。）

### 2.5 MCP：子进程按“不可信扩展”对待

- 子进程**默认不继承**你的环境变量（`inheritEnvironment: false`）
- 即使你显式开启继承，也**过滤掉密钥类变量**（`config-mcp-env.cjs` 的
  `MCP_ENV_ALLOWLIST` —— 只放行明确列出的名字）
- 启动前要过网络策略；工具名限定 `mcp__` 前缀

### 2.6 脱敏与审计

- **全局脱敏**（`electron/core/redact.cjs`）：已登记的密钥值、`sk-` 前缀、
  `Authorization` / `Bearer` / `Basic` 头、`api_key` / `secret` / `token` 这类字段名，
  一律替换成占位符（`***已隐藏***`）。
- **落盘前再脱敏一次**：会话写入走 `session-io.cjs` 的 `scrubStorage` 递归清洗
  （`core/redact.cjs` 是「别把密钥写进文件」的**唯一**规则处）。
- **审计**：每次工具调用、每次授权/拒绝、每次风险拦截都记一条（`data/audit/`，按天一个
  jsonl），设置 →「权限与安全」里能翻。

### 2.7 可恢复（不是防护，是止损）

- **改动事务**（`changeset`）：`write_file` / `edit_file` / `download` 动过的文件会做快照，
  可以按文件回滚到某个检查点。
- **改动撤回 ≠ 备份**：它只覆盖它自己动过的文件；你手工改的、别的程序改的，它不负责。
  **重要数据请另做备份。**

---

## 3. 它**没有**做什么（别以为有）

这一节和上面一样重要 —— **这些都是真实的缺口，不是“待办”**。它们来自
[`docs/安全模型.md`](docs/安全模型.md) 的第 8 节（那份是实现的真相源），以及写这份文档时
的复核。**列在这里，是为了让你不要在需要这些保护的时候误用它。**

| 没做的事 | 意味着什么 |
|---|---|
| **没有沙箱 / 容器 / 虚拟机** | 模型跑的命令**就在你的机器上、以你的身份**执行。它读得到你读得到的、删得掉你删得掉的 |
| **没有对模型输出的命令白名单** | 命令能不能跑，看的是**风险分级 + 你的授权**，不是一张固定的“允许清单”。模型编出一条你没预料到的命令，判断依据只有风险档 |
| **会话正文默认不加密** | `security.encryptSessions` **默认 `false`**（`config-security.cjs`）—— 会话文件在磁盘上是**明文 JSONL**（只做了密钥脱敏，没做内容加密）。这个开关**存在且有实现**，但要你在配置里显式打开；开启会**重写你已有的全部会话文件**，所以默认关 |
| **密钥可能是明文** | 拿不到系统加密时（纯 Node 环境、Linux 无 keyring、某些容器），`credentials.status().backend` 会变成 `'plain'` —— **密钥以明文存在本机文件里**。设置页会提示。软件**不假装**加密了 |
| **网页内容会被模型当数据读进来（注入面）** | 内嵌浏览器本身是加固过的（见 2.1），但它**装的是不可信网页** —— 网页上的文字会被模型当**数据**读进上下文，而其中可能藏着试图指挥它的指令。软件有提示词层的边界规则，但**没有**机制能保证模型不被注入操纵 |
| **内置浏览器的 UA 会伪装成标准 Chrome** | 网页标签发出的 User-Agent 被改写成标准 Chrome 的写法（去掉了应用名与 `Electron`），并补上真 Chrome 一定会发的 `sec-ch-ua` 三件套（实现见 `electron/core/browser-identity.cjs`）。**这是为了避免被误判为机器人**（默认 UA 里带着应用名与 Electron 是显式的自动化标记，会让正常网页误判）。它**不改变权限判定**（敏感权限仍默认全拒）、**不绕过任何访问控制**、**不用于绕过登录 / 付费墙 / 验证码**。这条是**如实告知**：你的浏览器身份在网页看来不是本应用 |
| **“完全访问”档下几乎没有确认** | 那一档的定义就是“不问”：高风险命令、工作目录外的文件、敏感文件**都直接执行**，只留审计。想留保险就别选它 |
| **备份不自动脱敏** | 「导出」/「备份」是整体拷贝；**密钥文件在未加密环境下是明文**，会在里面。导出的**数据库导出**会过脱敏，但**文件备份不会** |
| **网络策略不是防火墙** | 见 2.4 —— 它的执行点**只有 4 个**（shell 联网语义 / MCP 启动 / 浏览工具 / 浏览器跳转），**应用自身的模型调用 · 搜索 · 生图 · 下载都不经过它**；也管不到 MCP 子进程流量、浏览器第三方脚本、系统里别的程序 |
| **本地插件在宿主进程内执行，没有沙箱** | `data/plugins/<名>/run.cjs` 是被主进程 `require` 进来的（`plugins.cjs`）—— **它和 Harbor 同权限**，能 `require('node:fs')` 读写任何你有权限碰的东西、能联网。工具层只按 manifest 声明的权限过闸（联网/写文件算「有副作用」），**但拦不住插件代码本身想干什么**。真沙箱化是未做的（源码注释里叫 P2） |
| **技能的 `permissions:` 是声明，不是强制** | `SKILL.md` 里写的 `network: deny` 这类**只有被钉到某次对话后才生效**；`file` / `shell` 两档目前**只是声明 + 界面展示**，拦不住任何一次工具调用。真正拦人的是工具层（只读档 / 写确认 / `allowNetwork`）和 `capability.cjs` 的文件范围 |
| **没有防御提示词注入** | 它能读到网页、文件、工具返回的内容 —— 那些内容**可能试图指挥它**。软件有分层提示与边界规则（写在 `AGENT.md`、`prompt-stack.cjs`），但**没有**机制能保证模型不被注入操纵。**别让它对着不可信内容跑高权限操作** |
| **没有“停下来就不花钱”的硬闸** | 有 token 用量统计和用量闸（按 token 数设日/月上限，**默认关**），但没有“超了就断网/杀进程”的强制机制 |
| **没有对高价值/生产/合规环境的设计** | 它不是等保 / ISO 27001 / SOC 2 / PCI-DSS 意义上的安全产品，**不要**用它保护这类系统 |
| **数据是「跟着安装目录走」的，不是「跟着 Windows 账户走」的** | `data/` 在 **exe 同级**（便携版设计，整个文件夹可搬走），所以**同一台机器上、用同一份安装的多个 Windows 账户会共用同一个 `data/`**：会话、日志、审计、改动快照都在里面。**密钥是例外** —— `safeStorage`（DPAPI）绑当前账户，**别的账户解不开**（表现是「有凭证但读不出来」）。**多人共用一台机器时，请各用一份安装，或确认你接受别人能看到你的会话** |

---

## 4. 开箱默认值：你拿到手时的真实姿态

| 项 | 默认值 | 意味着 |
|---|---|---|
| 工具权限 | `ask` | 写操作、中高风险命令会问你 |
| 文件范围 | `workspace` | 只在工作目录内自由读写，出去要授权 |
| Shell 风险策略 | `medium: ask` / `high: ask` / `critical: block` | 危险命令**默认直接拒** |
| 网络策略 | `ask` | 联网动作每次先问 |
| 会话加密 | `false` | **会话正文明文落盘**（密钥仍脱敏） |
| 用量闸 | `enabled: false` | **默认不限量** —— 不会自动拦你的花费 |
| 自动重试 | `maxRetries: 3` | 单个工具失败自动救一把 |
| 预热请求 | `cache.prewarm: false` | 不自动发请求（会产生真实费用） |
| MCP 继承环境 | `false` | 子进程不继承你的环境变量 |
| 遥测 / 上报 | **无** | 不发任何统计数据 |

> **默认是“偏安全”的，但不是“安全”的**：默认档会问你，但你一旦点“允许”、
> 或把权限调成“完全访问”，上面的保护就基本退场了。**默认值保护的是“还没想清楚的人”，
> 保护不了“想清楚了但想错了的人”。**

---

## 5. 你的责任（按风险从高到低）

1. **重要数据先备份。** 撤回功能不是备份。这是最容易出事、也最容易避免的一条。
2. **别对没备份的目录跑高权限操作。** 尤其别在 `full` 权限 + `critical: allow` 的组合下。
3. **确认框出现时，真的看一眼再点。** 那是这套设计里唯一的“人类判断”环节。
4. **保管好 API Key。** 它会进 `data/credentials.json`（加密与否见第 6 节）。
   别把 `data/` 整个目录传到公开的地方（里面有会话、记忆、审计、快照）。
5. **给它一个专用的工作目录。** 别把整个盘当工作目录，也别把密钥目录设成工作目录。
6. **小心提示词注入。** 别让它对着不可信网页/文件跑高权限操作；读完陌生内容后，
   对“它接下来想干的事”多看一眼。
7. **留意费用。** 用量闸默认关。模型调用是**你**在付费；长任务可能很贵。
8. **遵守第三方条款。** 你接入的每个供应商都有自己的可接受使用政策。

---

## 6. 你的密钥与凭证

```
config.json            →  只有 credentialRef（如 "provider:deepseek"），没有密钥
data/credentials.json  →  真正的密钥
```

- 主进程用 Electron 的 `safeStorage` 加密（Windows 底层是 **DPAPI**，绑定当前账户）。
  选它不选第三方库，是因为它零新依赖。
- **明文兜底是明确的失败**：拿不到系统加密时，`backend` 会变成 `'plain'`，
  设置页会显示“当前环境拿不到系统加密，密钥是明文存在本机文件里”。**不假装加密了。**
- **换机器 / 换 Windows 账户后解不开**：密钥绑账户，换环境后 `safeStorage` 解密失败，
  软件会**停止写入**（保护你的旧密文，不会被覆盖），并提示你重新填。
- 读出的密钥会**登记进脱敏表** —— 之后日志、会话、导出里出现它一律被替换。

**你要做的**：别把 `data/credentials.json` 分享出去；换机器时记得重新填密钥；
怀疑泄露就**先去供应商后台吊销，再换**。

---

## 7. 数据在哪、去哪

| 数据 | 位置 | 是否出网 |
|---|---|---|
| 会话 | `data/sessions/`（默认明文 JSONL，密钥已脱敏） | ❌ 不出网 |
| 记忆 | `data/memory.json`（结构化条目；老的 `memory.md` 迁移后留作 `memory.md.migrated`） | ❌（但**会进对话**，见下） |
| 任务台账 / 计划 / 步骤 | `data/tasks/` | ❌ |
| 用量统计 | `data/stats.json`、`data/logs/token-metrics.jsonl` | ❌ |
| 密钥 | `data/credentials.json` | ❌ |
| 改动快照 | `data/changesets/` | ❌ |
| 审计 | `data/audit/`（每次调用/授权/拦截一条，按天一个 jsonl） | ❌ |
| 日志 | `data/logs/` | ❌ |

**会把数据发出去的动作只有三类**（下载是「只取不发」，另算）：

- 模型调用：**系统提示 + 相关记忆 + 会话历史 + 你让它读的文件内容** —— 这些进模型供应商的服务器
- 搜索 / 抓网页：搜索词、目标 URL 进搜索引擎或目标站点
- 生图：你写的图片提示词进生图服务

**下载**（`download` 工具 / 网页里点下载）只从远端**取**文件，不把你的数据发出去 ——
但**目标站点会看到你的 IP 与请求**，这一点和用浏览器下载一样。

> **这就是“你信任你配的模型”的真实含义**：你让它读的文件，会离开你的机器。

---

## 8. 报告漏洞

**请用 GitHub 的私密渠道**：仓库页 → `Security` 标签 → `Report a vulnerability`
（Private vulnerability reporting）。别开公开 Issue —— 那等于把细节先交给所有人。

报告里尽量带上：

- 版本（设置 → 关于，或 `package.json` 的 `version`）
- 复现步骤（哪一步、什么配置、权限档是什么）
- 期望行为 vs 实际行为
- **脱敏后**的日志片段（见第 10 节）

我会尽快回。这个项目是个人维护，没有 SLA，但安全问题会优先看。

**特别欢迎的报告**：绕过了权限档 / 风险分级 / 文件边界的路径；密钥被写进不该写的地方；
脱敏漏了某种格式；确认框能被绕过。

**不算漏洞的**（见第 3 节，这些都是已知设计）：在“完全访问”档下不弹确认；
会话默认明文；网络策略管不到 MCP 子进程；模型被提示词注入操纵。

---

## 9. 请**不要**贴这些东西

| 别贴 | 为什么 | 替代做法 |
|---|---|---|
| API Key / Token | 公开 Issue 是永久的 | 只描述“用了哪家的 key”，值用 `sk-***` |
| 完整 `data/` 目录 | 里面有会话、记忆、审计、改动快照 | 只贴必要文件，且先删掉正文 |
| 未脱敏的日志 | 日志里有你的工作目录与文件路径 | 用第 10 节的“脱敏日志”做法 |
| 会话 / 诊断包原文 | 诊断包含对话摘要 | 只贴相关那几行 |

---

## 10. 脱敏日志的做法

日志在 `<应用目录>/data/logs/`。用编辑器把 `C:\Users\<你的名字>\...` 这类路径替换成
`<path>`，再贴。

应用自带的诊断包（任务 → 详情 → 诊断 → 复制全文）**已经过 `redact` 处理** ——
API Key / Token / Authorization / 私钥一律替换成占位符，只报长度与前后几位。

---

## 11. 已知问题

### dev 依赖的安全告警（已清零）

以前 `npm audit` 会报 5 条（1 critical / 1 high / 3 moderate），全部落在**开发链**上：

```
vitest（critical，路径穿越）· vite（high，dev server 路径穿越）
esbuild / vite-node / @vitest/mocker（moderate）
```

**影响面**：只影响“跑 `npm run dev` 的开发服务器”和“跑测试的环境”，**不进发布产物**
（它们是 `devDependencies`；打包出来的 exe 里 `resources/app/node_modules` 不含它们 ——
可以自己 `ls dist-portable/*/resources/app/node_modules | grep -E 'vite|esbuild|vitest'` 验证）。

**现在已修**（1.5.1）：把 vite 升到 8、vitest 升到 5（跨了三个大版本），`npm audit` 现在是
**0 vulnerabilities**。升级本身也做了一整轮验证：tsc / eslint / prettier / 前端 476 项 /
内核 1659 项 / 构建 / **打包后真跑一遍**全部通过。

---

## 12. 支持范围

只支持**最新 release**。老版本的问题请先升级再看是否仍存在。

---

## 附：自己核对这份文档

上面每条都指得出实现。想验证的话（**Windows 的 cmd 里没有 `grep`，用下面这些
`node -e` 单行命令 —— 都已实测能跑**）：

```bash
# 默认值：权限档 / 文件范围 / shell 风险策略 / 会话加密 / 网络策略
node -e "const d=require('./electron/core/config-defaults.cjs').DEFAULTS;console.log(d.tools.permission,d.tools.fileScope,JSON.stringify(d.tools.shellPolicy),'limits.enabled='+d.limits.enabled)"
node -e "const s=require('./electron/core/config-security.cjs').SECURITY_DEFAULTS;console.log('encryptSessions='+s.encryptSessions,'network.mode='+s.network.mode)"

# 三档 / 四档枚举的唯一真相源
node -e "const c=require('./electron/core/config-constants.cjs');console.log(c.PERMISSIONS,c.FILE_SCOPES,c.RISK_LEVELS)"

# 敏感路径表（打印 SENSITIVE 那一整段）
node -e "const t=require('fs').readFileSync('electron/core/capability.cjs','utf8');console.log(t.match(/const SENSITIVE = \[[\s\S]*?\n\]/)[0])"

# 网络的出口：走 http.cjs 的 + 裸 fetch 的（应 4 + 3，且不含 http.cjs 自己）
node -e "const fs=require('fs'),p=require('path');const w=(d,a=[])=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f,a);else if(e.name.endsWith('.cjs'))a.push(f)}return a};const g=w('electron').filter(f=>!/http\.cjs$/.test(f));const A=g.filter(f=>/http\.(fetch|fetchStream)\(/.test(fs.readFileSync(f,'utf8')));const B=g.filter(f=>/(?<![.\w])fetch\(/.test(fs.readFileSync(f,'utf8'))&&!A.includes(f));console.log('走 http.cjs ('+A.length+'):');A.forEach(f=>console.log('  '+f));console.log('裸 fetch ('+B.length+'):');B.forEach(f=>console.log('  '+f))"

# 有没有遥测（应该没有）
node -e "const fs=require('fs'),p=require('path');const w=(d,a=[])=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f,a);else if(e.name.endsWith('.cjs'))a.push(f)}return a};const t=w('electron').filter(f=>/telemetry|analytics|sentry|posthog/i.test(fs.readFileSync(f,'utf8')));console.log(t.length?'发现: '+t.join(', '):'无遥测')"
```

实现的完整说明在 [`docs/安全模型.md`](docs/安全模型.md)（那份文档的标题就叫
「实际实现」，并且专门有一节「没做的（别以为有）」）。

---

*最后再说一次：**这不是沙箱**。它是一把好用的刀，握在你自己手里 ——
护栏能让你少割到手，但刀锋是冲外的，你朝哪儿挥，是你的决定，也是你的责任。*
