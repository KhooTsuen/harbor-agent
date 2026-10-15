# Phase 1a · Native host stdio 帧协议 —— 实施与验收报告

> **结论先行：Phase 1a 部分达成。**
>
> ✅ 达成：`main.cjs` 的 host 分支（识别 / 不建窗口 / 不抢单实例锁）、帧编解码、
>    ping→pong 协议逻辑（本地与纯 Node 端到端**全绿**，自检 41 条钉住）。
>
> ❌ **未达成**：真实 `Harbor.exe` 被 Edge 拉起的**端到端 ping/pong**。
>    卡点**不在** Phase 1a 的代码里，而在一个 Phase 0 **没覆盖到的架构假定**：
>    **`Harbor.exe` 是 GUI 子系统程序，它的 stdout 与 Edge 的 native messaging 管道不连通。**
>
> **这一条需要你拍板替代方案，我不继续往下试。**（见 §5）

---

## 1. 实测证据链（全部可复现）

宿主清单 `path` = `E:\CodexWorkbench\dist-portable\Harbor\Harbor.exe`（**零参数**），
Edge 用独立 profile + Phase 0 探针扩展拉起它。

### 1.1 分支**正常进了**（诊断文件原文）

```json
host-enter.json:
{"argv":["E:\\CodexWorkbench\\dist-portable\\Harbor\\Harbor.exe",
         "chrome-extension://fgiopdanmkafnmpcjiiofkbbgikmdljn/",
         "--parent-window=0"],
 "isPackaged":true}
```

进程命令行（Edge 拉起的那一个）：

```
pid=10536  ppid=13268
cmd="E:\CodexWorkbench\dist-portable\Harbor\Harbor.exe"  chrome-extension://<id>/ --parent-window=0
```

→ **argv 判据、路径锁、`isPackaged` 全部正确。**

### 1.2 host 侧**读到了 ping、也"写成功"了**

```
host-note.log:
  已就绪（pid=17980）
  readSync 读到 33 字节        ← ping 真的到了（4 帧头 + 29 帧体）

host-diag.json:
{"step":"wrote","frameLen":51,"ret":51,"err":null,
 "frame":"/\u0000\u0000\u0000{\"pong\":1,\"echo\":{\"ping\":1,\"at\":1792066230974}}"}
```

`fs.writeSync(1, frame)` **返回 51**（帧长 51，写"成功"）、帧头 `2f000000` 正确、
无异常 —— **但扩展一个字节都没收到**，Edge 报
`Error when communicating with the native messaging host.`

### 1.3 根因：**PE 子系统不匹配**

| 二进制 | PE 子系统 |
|---|---|
| `node.exe` | **CONSOLE(3)** |
| `Harbor.exe` / `electron.exe` | **GUI(2)** |
| `msedge.exe` | GUI(2) |

实测方法：读 PE 头 `OptionalHeader.Subsystem`（偏移 `0x3C → PE → +0x5C`）。

**GUI 子系统程序的 stdout 不会被接到父进程给的管道上** —— 这正是
「读得到（fd 0 由 Windows 代为连接）、写不出去（fd 1 指向别处）」的原因。

> ⚠️ 顺带排除一条看起来能救的路：`ELECTRON_RUN_AS_NODE=1` **不改 PE 子系统**
> （那是编译期写死的），所以它在**写**这条路上同样不通。实测确认。

### 1.4 「不建窗口 / 不抢锁」是**成功**的

| 指标 | 结果 |
|---|---|
| host 模式下的 Harbor 进程数峰值 | **4 → 4（没涨）** —— 正常启动是 3–5（主/GPU/utility/renderer + 托盘） |
| 日志里有没有「托盘已就绪」/「启动：Electron…」 | **没有**（那几句在 `whenReady` 里，host 模式根本没走到） |
| 单实例锁有没有被抢 | 没抢（分支在 `requestSingleInstanceLock` 之前） |

**Phase 1a 这句要求的两个行为目标都达成了** —— 只是协议回不去。

### 1.5 Phase 0 为什么没发现（这一条必须记下来）

Phase 0 测协议用的是 **`node.exe`（CONSOLE 程序）**：

| Phase 0 实验 | 底层二进制 | stdout 通不通 |
|---|---|---|
| 本地协议验证 | `node.exe` | ✅ 通 |
| `.cmd` 包装器跑通 ping/pong | **`node.exe`**（cmd 里跑的是 node） | ✅ 通 |
| 真机保活测试 | `node.exe` | ✅ 通（读那侧） |

→ **Phase 0 的所有"通过"都建立在 console 进程上。**
它证明了「协议 + 判据」成立，但**没有覆盖「Harbor.exe 自己当 host」这一步**。
当时我把这一步列为「Phase 1a 用真实 Harbor.exe 端到端验证」——
现在验了：**判定为不通过**。

---

## 2. 交付的代码（保留，但**不可用于生产**，见 §5）

| 文件 | 内容 | 状态 |
|---|---|---|
| `electron/native-host.cjs` | **新建**（260 行）：帧编解码纯函数 + 身份判据 + 白名单 + `run()` | ⚠️ 逻辑正确，但生产形态卡在 §1.3 |
| `electron/main.cjs` | **改**（297 行，只加 2 行分支 + 压了 3 处装饰性分隔块腾行） | ✅ 分支行为正确 |
| `scripts/selftest/groups/154-native-host.mjs` | **新建**（162 行，**41 条断言**） | ✅ 全绿 |
| `scripts/selftest/groups.mjs` | 注册（+2 行） | ✅ |
| `harbor-edge/phase0/host-wrapper.cmd` | 失败实验的留存（`.cmd` 包装器） | 证据，**不用于生产** |

**是否在授权范围内**：`electron/native-host.cjs`（新建）、`electron/main.cjs`（只加分支）、
自检组（新建）—— **三项全在 Phase 1a 授权内**。未动任何其他源文件。

`run()` 为什么是**同步阻塞**（而不是事件流）：CJS 顶层 `return` 会撞 tsc 的 **TS1108**，
去掉 return 的唯一办法就是让它永不返回。实测 `fs.readSync(0, …)` 在 Windows
**管道**上可用（读那侧确实是通的，见 §1.2）。

### 2.1 ★ 过程中发现并修掉的一个真 bug（我自己的）

真机跑完后核对进程表，逮到一个残留进程：

```
pid=10536  cmd="...Harbor.exe"  chrome-extension://<id>/ --parent-window=0   ← 带了 host 参数
           ← 但它走了**正常启动**：建了窗口 + 托盘 + 3 个子进程（gpu / utility / renderer）
```

**根因**：`main.cjs` 的分支写成 `if (isHostArgv()) run()`（**没有 return** —— 顶层 `return`
会撞 TS1108，见上），而 `run()` 在 **EOF 时用的是 `return`**。`run()` 一返回，
`main.cjs` 后面的代码（抢单实例锁 → `whenReady` → `createWindow` → 装 IPC）**就继续执行了**。

→ **host 模式会偶发变成「开一个窗口」**（取决于那一刻单实例锁 / 时序）。
这正是我为了消除 TS1108 而改掉 `return` 时**引入**的回归 —— 自检当时没覆盖到。

**修法**：`run()` 的三处收尾（读失败 / EOF / 协议失步）全部改成 `process.exit(0)`。
`fs.writeSync` 是同步的，已写出的帧不会因 exit 被截断。
自检加一条断言钉住「**不是 return**」。

**修后验证**（不依赖 Edge，可复现）：

```
spawn Harbor.exe "--parent-window=0" + 立刻关 stdin
  → 退出码 0
  → repo 副本 Harbor 进程数 = 0   ← 没建窗口
  → stderr: [native-host] 已就绪（pid=14276）  ← 确认走了 host 分支
```

---

## 3. 验证数据

| 项 | 结果 |
|---|---|
| 本地喂帧（纯 Node 子进程，真 spawn） | `{"ping":1}` → `{"pong":1,"echo":…}` ✅ |
| 自检 154 组 | **41 条全绿**（帧编解码 13 / 判据 7 / handleMessage 4 / 白名单 6 / 接线 5 / stdout 保命线 6） |
| 内核自检总数 | **4544 / 0**（改前 4497，**+47**） |
| `typecheck:kernel` | 与基线一致（181 条，**未新增**） |
| 行数 | `main.cjs` 297 / `native-host.cjs` 260 / 154 组 162 —— 全 ≤300 |
| 真机端到端 | **❌ 未通过**（§1.3） |

真机实验中**修掉的两处自己的坑**（都是自检抓出来的）：
① 帧编解码断言里 `require('./native-host.cjs')` 这种**字符串字面量**被「相对 require 路径都要存在」
   那条静态检查当成了真 require（`98-rollback-preview.mjs` 的注释早警告过，我踩了）；
② 一条断言在改成同步阻塞后**过时**了（还要求 `return`）——自检报红才发现。

---

## 4. 清理与边界

| 项 | 状态 |
|---|---|
| 注册表 `HKCU\...\NativeMessagingHosts\com.harbor.phase0.probe` | **已删**（复核为空） |
| 探针 Edge profile | 已删 | 
| 副本上的临时诊断代码（`argv-probe` / `host-diag` / `host-note`） | **已还原成正式版**（副本与仓库 sha 一致） |
| 实验产物文件（`host-*.json` 等） | 已清 |
| **是否碰过 `E:\Harbor`（你正开着的那份）** | **没有**，一个字节都没动。实验只用 `E:\CodexWorkbench\dist-portable\Harbor` |
| 是否杀过 `Harbor-Dev` 那 6 个进程 | **没有** —— 它们的父进程是 `explorer.exe`（你双击开的），我只按路径过滤 `CodexWorkbench` |
| Runtime / 严格模式 / 防闪烁 / `hardenWebview` / 工具系统 / 权限模型 | **未碰** |
| 新依赖 | **零** |
| 新增 IPC 通道 | **零** |

---

## 5. ★ 卡点与替代方案（**需要你拍板**）

### 卡点一句话

**Edge 只能拉一个"可执行文件"（清单 `path` 不能带参数），而 Harbor 发行版里
唯一的可执行文件是 GUI 子系统的 `Harbor.exe` —— 它的 stdout 通不到 Edge。**

发行目录实测只有：`Harbor.exe`（GUI）。
`node_modules/electron/dist/` 也只有 `electron.exe`（GUI）。**没有 console 二进制。**

### 三个替代方案

| # | 做法 | 代价 | 评价 |
|---|---|---|---|
| **A** | **随包发一个 console 子系统的 host 二进制**（一个几十行的 C 桥接，或打包 node.exe） | 要**新增一个二进制** + 构建步骤；`node.exe` 约 90MB（太重） | 技术上最干净，但引入新构建产物 |
| **B** | **降级到本地 HTTP/WebSocket**（原方案 B） | 要开监听端口；WS 服务端 Node **没有内置** → 要么手写、要么引依赖（破零依赖） | 与原「不开端口」的安全取向相反 |
| **C** | **在 host 分支里 spawn 一个 console 子进程转发** | 我**已经试过这个方向**（`stdio:'inherit'`）：子进程仍是 GUI 子系统 → **不通**。若改为 spawn `node.exe` → 依赖用户装了 Node → 不可接受 | **已实测排除** |

### 我的建议

**A 的轻量形态**：写一个 ~30 行的 C 程序（`harbor-host.exe`，console 子系统），
它只做一件事：**把 stdin/stdout 原样透传给 `Harbor.exe` 跑 host 模式**——
也就是**用 console 进程来"持有"管道**。

- 需要：一个 C 文件 + 一条 `cl`/`gcc` 编译命令（`build-portable.mjs` 里加一步）。
- 不需要新依赖（系统 cl 或随项目已有的工具链）。
- ⚠️ **但这是「新增构建产物」，命中硬禁区 #1/#6 的精神，必须你批准。**
- ⚠️ 而且我**不确定它一定成功**（GUI 子进程的 stdout 未必能接上父进程的管道）——
  要**先做一个最小实验**再承诺。

**或者 B**：如果你觉得「开个本地端口」可以接受，B 的实现量最小
（`node:http` 零依赖，扩展侧 fetch + SSE），而且**不依赖任何二进制**。

---

## 6. Phase 0 报告需要更正的一处

Phase 0 §5 我写过「`.cmd` 包装器 ✅ 通过」并把「零参数 `Harbor.exe` + argv 判据」
当作生产形态。**这一条要更正**：

- `.cmd` 那次通过，是因为它底下跑的是 **`node.exe`（console）**；
- 换成 `Harbor.exe`（GUI）后**读能通、写不通**。

**Phase 0 的结论「协议 + 判据成立」仍然有效**（§1.1 证明了判据正确），
但「生产形态可行」这个推论**被 Phase 1a 证伪**。

---

## 7. 待你决定

1. **替代方案选 A（新增 console 桥接二进制）还是 B（降级本地服务）**？
2. 若选 A：先批准我做一个**最小可行性实验**（就一个 C 文件 + 手动编译，不进构建链），
   验证「console 父进程能否让 GUI 子进程的 stdout 通到 Edge」。
3. 当前这份 `main.cjs` 分支 + `native-host.cjs` **要不要保留**？
   （建议保留：判据与帧逻辑是对的，替代方案落地时改的是「谁来持有管道」，这两块能直接复用。）

**我没有继续往下试，也没有动授权范围外的任何东西。等你拍板。**
