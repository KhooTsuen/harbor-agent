# Edge native host stdout 连通性：三组实验报告

> **只做实验，未改产品代码**（`git status electron/` 为空）。
> 每条结论都附实测命令与原始输出。凡未实测的，写明「未验证」。
>
> 一句话结论：**stdout 一直是通的** —— Phase 1a 报的「写成功但收不到」是**误判**。
> 真实原因是 **Chromium 初始化往 stdout 写了一个 `\r\n`（2 字节）**，Edge 把它当帧头
> 读出 1,837,581 这么个荒谬长度，于是报协议错。
> 关掉 Chromium 初始化（**`ELECTRON_RUN_AS_NODE=1`**）→ stdout 立刻干净。
>
> 三组实验：**实验 1 不通过**（四个候选开关全无效）· **实验 2 通过**（SEA exe 是 CONSOLE(3)，
> 且经真实 Edge 跑通）· **实验 3 通过**（`.cmd` + 自带 Electron，三个变体全通）。

---

## 0. 实验环境与隔离

| 项 | 值 |
|---|---|
| Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（GUI 子系统） |
| 探针扩展真实 ID | **`chmojfjfoolkplcjdgcccjhanfglikpm`**（加载一次读回；不是算出来的） |
| 注册表键 | `com.harbor.exp1` / `exp2` / `exp3`（**独立于生产的 `com.harbor.agent`**） |
| profile | `harbor-edge/exp/profiles/*`（独立；跑完删） |
| 判据来源 | 探针扩展自己把 `connectNative` 的结果 POST 到本地报告服务器 |

**没碰**：用户正在用的 Edge 实例（本机 25 个 `msedge.exe` 全是他的）、`E:\Harbor`、
`E:\Harbor-Dev`（那 6 个 `Harbor.exe` 是他的，父进程 explorer）。

---

## 1. ★ 根因：那个 `\r\n`

### 1.1 本地 spawn 直接对比（不依赖 Edge）

把 host 的 stdio 接成我们的管道，喂一帧 `{"ping":1}`，dump stdout 原始字节：

| host | STDOUT hex | 解读 |
|---|---|---|
| `node.exe` + probe-host.cjs（正对照） | `1c0000007b22706f6e67…` | **纯帧，干净** |
| `Harbor.exe --parent-window=0` | `0d0a` **+** `1c0000007b22706f6e67…` | **帧前多了 CRLF** |

→ **Harbor.exe 的帧真的写出来了**。Edge 读到的前 4 字节是 `0d 0a 1c 00`
= 小端 1,837,581 = 一个不可能的长度 → 协议失步 → `Error when communicating with the
native messaging host.`

**这纠正了 Phase 1a 的结论**：那里写的「写入 fd 1 返回 51（成功），但 Edge 一个字节
收不到」**前半句对、后半句错** —— 收到了，只是前面多了 2 字节垃圾。

### 1.2 `\r\n` 从哪来（4 个变体）

| 变体 | STDOUT | 结论 |
|---|---|---|
| ① 不写 stdin | `0d0a`（**只有 2 字节**） | 是**启动期**写的，不是读 stdin 触发 |
| ② 写 stdin | `0d0a` + 帧 | — |
| ③ `ELECTRON_NO_ATTACH_CONSOLE=1` | `0d0a` + 帧 | **无效** |
| ④ `--no-stdio-init` | `0d0a` + 帧 | **无效** |
| ⑤ `ELECTRON_ENABLE_LOGGING=0` | `0d0a` + 帧 | **无效** |
| ⑥ `--enable-logging=file --log-file=…` | `0d0a` + 帧 | **无效** |
| ⑦ **`ELECTRON_RUN_AS_NODE=1`**（不写 stdin） | **空（0 字节）** | 🎯 无 CRLF |
| ⑧ **`ELECTRON_RUN_AS_NODE=1`**（写 stdin） | `1c000000{…}` | 🎯 **纯帧** |

→ **不是「GUI 子系统写不出管道」**（Phase 1a 的猜测），是 **Chromium 初始化污染 stdout**。
`ELECTRON_RUN_AS_NODE=1` 绕开整个 Chromium 初始化，stdout 就是干净的 console 行为。

---

## 2. 实验 1：Electron / Chromium 开关 —— ❌ 不通过

**问**：有没有官方开关能阻止 Chromium 动 stdout？

**查到的候选**（Electron 官方文档原文）：

| 候选 | 原文 | 结果 |
|---|---|---|
| `ELECTRON_NO_ATTACH_CONSOLE` | *"Don't attach to the current console session."* | ❌ 实测无效 |
| `--no-stdio-init` | *"Disable stdio initialization during node initialization."* | ❌ 实测无效 |
| `ELECTRON_ENABLE_LOGGING=0` | — | ❌ 实测无效 |
| `--enable-logging=file --log-file=` | *"logs will be written to the given path"* | ❌ 实测无效 |

**经真实 Edge 也都不通过**：
```
D 经 Edge 基线（Harbor.exe 零参数）      → ❌ 不通过
E 经 Edge + ELECTRON_NO_ATTACH_CONSOLE=1 → ❌ 不通过
   扩展上报 = …"error":"Error when communicating with the native messaging host."
```

**结论**：`Harbor.exe` 本体（走 Chromium 初始化）**没有任何开关能救**。
但实验顺带找到了 **`ELECTRON_RUN_AS_NODE=1` 这条路**（见 §1.2 ⑦⑧），它不是「开关」，
是「换一种启动模式」—— 由实验 3 落地。

---

## 3. 实验 2：Node 24 SEA —— ✅ 通过

**问**：SEA 打包出来的 exe，PE 子系统是 CONSOLE 吗？协议通不通？

```
步骤 1：node --experimental-sea-config sea-config.json
        → rc=0  blob=1277 字节
步骤 2：copy node.exe → host-sea.exe
        → PE 子系统 = CONSOLE(3)
步骤 3：npx postject host-sea.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse …
        → rc=0  💉 Injection done!
        → （警告：The signature seems corrupted! ← 注入破坏了签名，见「遗留」）
步骤 4（★ 核心判据）：注入后 PE 子系统 = WINDOWS_CONSOLE  → ✅ 是 CONSOLE(3)
步骤 5：经真实 Edge → ✅ 通过
        扩展上报 = …"stage":"message","msg":{"pong":1,"echo":{"ping":1,…}}
```

**结论**：**通过**。SEA 产物 = `node.exe` 副本 + 注入资源段 —— 不动 PE 可选头，
所以子系统仍是 **CONSOLE(3)**。

**代价（按红线列出）**：
- v24 **没有** `--build-sea`（那是 v26 的新 API），注入必须用 **`postject`**
  （npm 包，实测 `postject@1.0.0-alpha.6` 可装）→ **构建期依赖**，需你批准
- 注入破坏数字签名（`The signature seems corrupted!`）→ 若将来要签名发布需重新签
- 产物约 100+ MB（整个 node 运行时）

---

## 4. 实验 3：`.cmd` 包装器 —— ✅ 通过（3a/3b/3c）

**问**：`.cmd` 当 native host，不依赖 path 带参数，能不能跑通？

### 4.1 ★ 第一次失败：`.cmd` 里的中文注释

首轮 3a 失败，stderr（GBK 乱码）是 `'──────' 不是内部或外部命令`。

**根因**：`cmd.exe` 按 **OEM 码页（本机 GBK）** 读 `.cmd`，而文件是 UTF-8 ——
中文注释变成乱码，**被当命令执行**。
⚠️ **不能用 `chcp 65001` 修**：`chcp` 会往 stdout 写字，直接污染协议帧。

### 4.2 改纯 ASCII 后：本地预检 + 经真实 Edge 全通

**本地预检**（判据：STDOUT 必须**恰好**一帧 = `1c000000{…}` 32 字节）：
```
3a host-node.cmd            → ✅ 干净（恰好一帧）
3b host-electron-node.cmd   → ✅ 干净（恰好一帧）
3c 同目录 harbor-host.cmd   → ✅ 干净（恰好一帧）
```

**经真实 Edge**（判据：扩展自己收到 pong）：
```
3a .cmd → node.exe → native-host.cjs            → ✅ 通过
3b .cmd → RUN_AS_NODE + Harbor.exe              → ✅ 通过
3c 真实部署形态（.cmd 与 exe 同目录，纯相对路径）→ ✅ 通过
   扩展上报 = …"stage":"message","msg":{"pong":1,"echo":{…}}
```

三个 `.cmd` 形态（`harbor-edge/exp/host-node.cmd` / `host-electron-node.cmd`，
部署形态 `dist-portable/Harbor/harbor-host.cmd`）都是**纯 ASCII**，内容只有：
```
@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0Harbor.exe" "%~dp0resources\app\electron\native-host.cjs"
```

---

## 5. 推荐方案

### ★ 首选：路径 2 —— `.cmd` + `ELECTRON_RUN_AS_NODE` + 自带 Electron

| 理由 | 事实依据 |
|---|---|
| **零新依赖** | 只用 Harbor 自带的 `Harbor.exe`（实验 3b/3c 实测）；不用 postject、不用 C 编译器 |
| **不需要用户装 Node** | `ELECTRON_RUN_AS_NODE` 复用的就是随包分发的 Electron 二进制 |
| **已按真实部署形态实测通过** | 3c：`.cmd` 与 `Harbor.exe` 同目录、纯相对路径 → 扩展收到 pong |
| **不需要方案 A（C 桥接）** | 实验证明桥接是多余的 |

### 备选：路径 1 —— SEA exe

单文件、不依赖 `.cmd` 行为；代价是 postject（构建期依赖）+ 失去签名 + 体积。**若将来
Node 升到 v26**（原生 `--build-sea`），这条路的代价会降到零，届时可再评估。

### 明确排除

- ❌ 让 `Harbor.exe` 零参数直接当 host（实验 1：无开关可救那个 CRLF）
- ❌ 方案 A 的 C 桥接（不需要了；且要编译器）
- ❌ Node.exe 直接当 host（Phase 0 已排除：无参数时把 stdin 当脚本源读掉）

---

## 6. 对 Phase 0 / Phase 1a 结论的修正

| 原结论 | 修正 |
|---|---|
| Phase 0：「`path` 只能是**不带参数**的可执行文件」 | **仍成立**。`.cmd` 是**一个文件路径**，不是「exe + 参数」—— 不矛盾 |
| Phase 1a：「写入 fd 1 成功但 **Edge 收不到**」 | **前半对、后半错**。收到了；被前置 `\r\n` 污染导致 Edge 解帧失败 |
| Phase 1a：「初步定位为 Electron/Chromium 对标准句柄的处理问题」 | **精确化**：是 Chromium **初始化期往 stdout 写 `\r\n`**；`ELECTRON_RUN_AS_NODE=1` 可完全规避 |
| Phase 1a：`main.cjs` 的 `--parent-window=` 判据 | **不再需要**（路径 2 由 `.cmd` 直接指定脚本，不需要 argv 判据）。留着无害，但 Phase 1b 可简化 |

---

## 7. 遗留 / 未验证

1. **`.cmd` 的部署位置**：放 `Harbor.exe` 同级（3c 形态）。⚠️ 升级时 `robocopy` 会不会
   覆盖/删除它 —— **未验证**，实施时要在安装脚本里保证幂等重建。
2. **postject 签名警告**：SEA 产物 `The signature seems corrupted!` 的实际影响 —— **未验证**
   （本实验只验证了协议能通，没验证签名场景）。
3. **`ELECTRON_RUN_AS_NODE` 与 fuse**：官方原文 *"If the `runAsNode` fuse is disabled,
   ELECTRON_RUN_AS_NODE will be ignored."* —— 本仓库 `scripts/build-portable.mjs` 是
   `cpSync(Electron 运行时)`，**不动任何 fuse**，所以可用；但这条**依赖「将来不启用
   runAsNode fuse」**，实施时要加自检钉住。
4. **`--no-stdio-init` 的真实语义未深究**：实测无效即止，没去查它到底管什么。
5. **本报告只验协议（ping/pong）**，没验业务消息、大帧、多帧粘包（那些 Phase 1a 的自检已覆盖）。
6. **临时工具**（按红线列出）：`postject`（实验 2 注入用，`npx` 拉取，**未写进
   package.json**）。

---

## 8. 边界遵守声明

零新依赖 ✓（postject 是实验期临时工具、未落进依赖清单）· 零 IPC 改动 ✓ ·
**未改任何产品代码**（`git status electron/` 为空）✓ · 未碰 Runtime / 严格模式 /
防闪烁 / `hardenWebview` / 工具系统 / 权限模型 ✓ · 未碰用户正在用的 Edge 与 Harbor ✓ ·
注册表键 / profile / SEA 产物已全清（复核：`Edge\NativeMessagingHosts` 下无任何键）✓
