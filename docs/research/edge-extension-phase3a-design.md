# Phase 3a 设计说明：双向通信 + 会话列表读取（只读）

> **状态**：**已实施完毕（2026-10-15）** —— 三项裁决见 §11，探针 9/9 见 §9.1，
> 实施结果与实测见 [`edge-extension-phase3a-report.md`](./edge-extension-phase3a-report.md)。
> **范围**：只含 Phase 3a。不含发消息 / 流式回复（3b）、不含会话选择器 UI（3c）、不含 Agent 操作网页（Phase 4）。
> **前置阅读**：`docs/research/edge-extension-host-stdout-experiments.md`（host stdout 真因）、
> `docs/research/edge-extension-phase2-report.md`（单向管道现状）。

---

## 0. 一句话

现在 host 只会「**写完就走**」；3a 要让它「**问一句、等回话**」。这需要在命名管道上定义
**双向帧协议**，并把 host 主循环从**同步阻塞**改成**事件驱动**。难点不在协议，在**最后那一步**——
它牵动 `main.cjs` 的一行分支（§6.2）。

---

## 1. 现状（设计的出发点，全部来自源码）

| 位置 | 现在的样子 | 关键限制 |
|---|---|---|
| `electron/core/ext-bridge.cjs` | `net.createServer` 收管道；**累积到 `end` 才当一条消息**；处理完 `socket.write(reply)` | 回复**没人读**（host 已关连接）——源码里已如实标注 |
| `electron/core/ext-forward.cjs` | host 侧 `fs.writeFileSync(pipe, bytes)` | 前提是「**打开→写→关**」＋「**不等回复**」 |
| `electron/native-host.cjs` | `run()` = `for(;;)` + `fs.readSync(0,…)`，**同步阻塞**；`handleMessage()` 同步返回 | ★ 见 §2 |
| `harbor-edge/extension/service-worker.js` | 持 native port；`sendPageToHost()` 用 **单槽** `pendingRead` 等回帧 | 只能一条在途请求 |

**沿用不改的**：管道名 `\\.\pipe\harbor-ext-<sha1(dataDir) 前 12 位>`；token 落
`data/ext-bridge.token`（每次启动重写，fail-closed）；帧编码 **4 字节小端长度 + UTF-8 JSON**
（与 Edge native messaging 同构）。

---

## 2. ★ 硬约束：host 主循环为什么必须动

`native-host.cjs` 文件头那段 ⚠️ 是 **Phase 1a 真机踩出来的**：

> `run()` 一旦 `return`，**main.cjs 后面的代码就会继续执行**（抢单实例锁、建窗口、装 IPC）——
> host 模式当场变成「开一个窗口」。

根源是 `electron/main.cjs` 那一行：

```js
if (require('./native-host.cjs').isHostArgv()) require('./native-host.cjs').run()
```

**没有 `else`、也没有 `return`**（顶层 `return` 会撞 tsc 的 TS1108）。所以「`run()` 永不返回」
是**当前架构的承重墙**。

而双向通信要求 host 同时等两个来源：

```
          ┌── Edge 的 stdin（用户点按钮）────────┐
host 主线程 ─┤                                    ├─ 单线程同步循环做不到
          └── 主进程的管道回复（session:list）──┘
```

**这就是 3a 唯一真正的技术难点。**

---

## 3. 三条候选路线

### 路线 A（用户已选）：host 改成**事件驱动**

```
stdin.on('data')  → 解帧 → dispatch(可能 await 管道) → stdout.write(回帧)
pipe.on('data')   → 解帧 → 若是 push，直接转 stdout
```

- **优点**：与 3b 天然相配（主进程可随时 `push` 流式分片）；超时用 `setTimeout` 即可；只有一个循环。
- **代价**：`run()` 会**正常返回** → 必须处理 `main.cjs` 那行的贯穿（§6.2）。
- 保活：`stdin` 处于读取态即保活事件循环；`stdin.on('end')` → `process.exit(0)`。

### 路线 B（保命方案，未选）

host 保持**同步**，管道改成**常驻双向 fd**：

```js
const fd = fs.openSync(pipeName, 'r+')   // 常驻
fs.writeSync(fd, frame)                  // 发请求
fs.readSync(fd, buf, 0, n)               // 阻塞等回复
```

- **优点**：`run()` 仍永不返回 → **`main.cjs` 零改动**；实现最简单。
- **代价（两条真的）**：
  1. **没有超时** —— `fs.readSync` 无 timeout 参数，Windows 上 Node 也没给「带超时的管道读」。
     主进程卡住 → host 卡死在那次读上（连带后续所有请求）。
  2. **3b 基本要重做** —— 主进程**主动推送**（流式分片）要求 host 在「没发请求时」也能读到管道；
     同步循环正堵在 `readSync(0,…)` 上，读不到。

### 路线 C（考虑过，不推荐）

同步主线程 + worker 线程（`Atomics.wait` + `receiveMessageOnPort`，社区 `synckit` 那套）。

- **优点**：`main.cjs` 零改动、保留同步语义、**还有超时**。
- **不推荐**：它存在的**唯一目的**是「让 `run()` 不返回」——而这点的成本只是 `main.cjs` 的一行分支
  （§6.2）。为躲一行代码引入 worker + SharedArrayBuffer + Atomics 协议，收益与复杂度倒挂；
  且 push 仍受「主线程可能正阻塞」影响。

---

## 4. 双向帧协议

复用 Edge 那套编码（4 字节小端长度 + UTF-8 JSON）—— 编解码器已在 `native-host.cjs`，
且「半帧 / 粘包 / 长度离谱」三种情况都有自检钉着。管道这层**不再拿「连接结束」当消息边界**。

### 4.1 报文形状

**host → 主进程（请求）**

```json
{ "v": 1, "token": "<hex>", "id": "h-7", "kind": "session:list", "payload": { "limit": 50 }, "ts": 1792075418919 }
```

**主进程 → host（应答）**

```json
{ "v": 1, "id": "h-7", "kind": "session:list", "ok": true, "payload": { "sessions": [ … ] } }
```

**主进程 → host（错误应答）**

```json
{ "v": 1, "id": "h-7", "ok": false, "error": { "code": "UNKNOWN_KIND", "message": "Harbor 不认识这个请求（侧边栏比 Harbor 新？）" } }
```

**主进程 → host（主动推送，3b 用；3a 不实现，但形状现在就定死）**

```json
{ "v": 1, "push": true, "kind": "chat:delta", "payload": { "requestId": "…", "text": "…" } }
```

> **`push` 与「应答」靠 `id` 有无区分**：有 `id` = 应答；无 `id` = 推送。
> 这条现在不写进文档，3b 会想再改一次协议。

### 4.2 request id 匹配（两级）

| 层 | 谁产生 | 作用 |
|---|---|---|
| 扩展 ↔ host | **扩展**产生，如 `r<时间戳36进制>` | 扩展匹配「这次点击的回帧」 |
| host ↔ 主进程 | **host**产生，`h-<自增>` | host 匹配「主进程的应答」 |

host 维持 `Map<h-id, {extId, resolve, timer}>`：

```
Edge 发 { type:'ext:sessionList', id:'rABC' }
  → host 分配 h-3，记住 { h-3 → rABC }，写请求到管道
  → 主进程回 { id:'h-3', ok:true, payload:{…} }
  → host 查到 rABC，拼 { type:'ext:sessionList.result', id:'rABC', … } 写 stdout
  → 扩展按 rABC 兑现 Promise
```

**支持并发**：多张 `h-id` 同时在途（扩展侧那把「单槽 `pendingRead`」要改成按 id 的 Map）。

### 4.3 3a 的消息类型清单

| kind | 方向 | 3a | payload | 说明 |
|---|---|---|---|---|
| `ping` | 扩展→host | ✅（已有） | `{ping:1}` | 连接判据，**不走管道** |
| `ext:page` | 扩展→host→主进程 | ✅（已有，改走新协议） | `{url,title,text,truncated}` | 语义不变 |
| **`session:list`** | **扩展→host→主进程** | ✅ **新增** | `{limit?}` | 返回会话摘要数组 |
| `chat:send` / `chat:delta` / `chat:done` | — | 3b 预留 | — | 只占位 |

**`session:list` 应答 payload** —— 直接用 `session.list()` 的字段，**不另造形状**（硬约束 #9）：

```json
{ "sessions": [
  { "id": "sess_…", "title": "…", "mode": "pair", "model": "…",
    "workdir": "", "projectId": "", "messageCount": 4,
    "createdAt": 1791481906067, "updatedAt": 1791481906100 }
] }
```

> 侧边栏要的「id + 标题 + 最后活跃时间」→ `id` / `title` / **`updatedAt`** 都已在里面，
> **不需要新字段**。

### 4.4 错误码（唯一清单，两侧共用）

| code | 产生方 | 含义 | 侧边栏文案 |
|---|---|---|---|
| `NO_HARBOR` | host（connect 抛 ENOENT） | Harbor 没在运行 | 「Harbor 没有在运行（先启动 Harbor）」 |
| `TIMEOUT` | host | 主进程没在期限内回 | 「Harbor 没有响应（超时）」 |
| `BAD_TOKEN` | 主进程 | token 不对 | 「通道校验失败 —— 重启 Harbor 再试」 |
| `BAD_FRAME` | 主进程 | 帧解不开 | 「通道数据坏了（重启 Harbor）」 |
| `UNKNOWN_KIND` | 主进程 | 不认识的 kind | 「侧边栏比 Harbor 新，请升级 Harbor」 |
| `INTERNAL` | 主进程 | 处理时抛异常 | 「Harbor 处理失败：<message>」 |
| `TOO_LARGE` | 双方 | 超单帧上限 | 「内容太大」 |

超时值：**host 侧 8s**（`session:list` 是本地读盘，正常 <50ms）；扩展侧 15s（已有）。
**两级故意错开** —— 让 host 先超时、回一条**带 code 的人话**，比扩展自己超时（看不到原因）有用。

---

## 5. 三侧的改法

### 5.1 host 侧（路线 A）

```
runInteractive()                      ← 新：事件驱动
  ├─ console.log 改道 stderr          ← 保留（保命线）
  ├─ stdin.on('data')  → decodeFrames → dispatch(frame)
  ├─ stdin.on('end')   → process.exit(0)
  ├─ stdin.on('error') → process.exit(0)
  └─ client · 收到 push → encodeFrame 写 stdout

dispatch:
  ping         → { pong:1, echo }                       （同步，同今天）
  ext:page     → await client.request('ext:page', …)     （改：不再「写完就走」）
  session:list → await client.request('session:list', …) （新）
  其它         → { error: '只认 …' }                     （同今天）
```

**连接保活**：启动时**不**立刻连管道（Harbor 可能没开），在**第一次请求**时 `net.connect`；
连不上回 `NO_HARBOR`，下次请求再试。连上后**保持**，断了自动重连。

> 为什么不启动就连：Phase 2 的行为是「每次写现连」，语义上「Harbor 没开」**每次请求都能立刻知道**
> （ENOENT 不阻塞）。启动就连会让「Harbor 没开」变成进程启动期的静默失败，更难诊断。

**同步循环 `run()` 保留**：路线 A 下它只剩「兼容形态」一个用户（§6.2），**行为一字不改**。

### 5.2 主进程侧

| 文件 | 改什么 |
|---|---|
| `ext-bridge.cjs` | ① `onConnection` 从「累积到 `end`」改成**增量帧解码**、连接**保持**；② 加**分派表**；③ 回写带 `id` 的应答帧；④ 加 `push(kind,payload)`（3a 不调，3b 用）；⑤ **裸 JSON 兜底**（§6.1） |
| `register-handlers.cjs` | 注入不变（`session`/`audit`/`wrap`/`send` 已在）—— **预计不用改** |
| `main.cjs` | **0 行**（裁决 A3，§6.2） |

**分派放哪**：`ext-bridge.cjs` 已 288 行，加「分派表 + 应答写入 + 推送 + 兜底」会超 300 →
**拆一个 `electron/core/ext-ops.cjs`**（kind → 处理函数），bridge 只做 I/O。

> 为什么不让 bridge 直接 `require('session.cjs')`：现在依赖是**注入**的（`deps.session`），
> 自检才能喂假实现。拆出的 `ext-ops.cjs` 同样接收注入。

### 5.3 扩展侧

```
service-worker.js
  ├─ pending: Map<extId, {resolve, timer}>     ← 从「单槽」改成 Map（支持并发）
  ├─ onMessage 加 type==='ext:sessionList'     → postMessage 到 host，等回帧
  └─ 收到 {type:'ext:sessionList.result'}      → 按 id 兑现

sidepanel
  ├─ 新 SessionList.tsx（只读：标题 / id / 最后活跃）
  └─ App.tsx 放一个「会话列表」区块 + 刷新按钮（不点进、不发消息）
```

**冷启动**：结果写 `chrome.storage.local`（`harborSessions`），面板打开即有内容，再异步刷新
（与现有 `harborState` 同套路）。

---

## 6. 兼容性与迁移

### 6.1 组合矩阵

| host | 主进程 | 结果 |
|---|---|---|
| **旧**（裸 JSON、写完即关） | **新** | ✅ 靠「裸 JSON 兜底」—— 内容照样落会话，拿不到回执（与今天一样） |
| **新**（帧、保持连接） | **旧** | ❌ 旧主进程只在「连接结束」时处理 → 永不处理。**实际不会出现**（host 与主进程同一次安装；升级时旧 host 会断线） |
| **新** | **新** | ✅ |
| 旧扩展 → 新 host | — | ✅ `ext:page` 语义不变 |
| 新扩展 → 旧 host | — | ✅ 旧 host 回「只认 ping/ext:page」→ 面板显示「Harbor 版本较旧，请升级」 |

> 「旧 host → 新主进程」这条**必须**保住：用户在 Edge 开着时升级 Harbor，旧 host 进程还活着。

**裸 JSON 兜底判据**：主进程解码后按形状判 —— 有 `id` 且有 `kind` → 新协议；否则 → 旧单向路径。

### 6.2 `main.cjs` 的三个选项（**用户已选 A3**）

| 选项 | 做法 | `main.cjs` diff | 评价 |
|---|---|---|---|
| **A3** ✅**已选** | `run()` **保留**同步阻塞（兼容形态照旧），新增 `runInteractive()` 给路径 2 | **0 行** | 零风险、零回归；代价是**两个 I/O 驱动**（旧那个是死代码 —— CRLF 问题导致兼容形态本就跑不通） |
| A1 | host 分支外**套 `else { … }`** | 重排 ~240 行缩进 | 语义最干净（一个驱动）；diff 巨大，评审困难 |
| A4 | **删掉兼容分支**（`isHostArgv` 形态③ 只剩自检用） | 删 2 行 | 最小且最干净；但这是**行为变更**，超出 3a 范围 → **作为后续独立小提交**（已记入待办） |

**A3 下的一句诚实标注**：`run()` 与 `runInteractive()` 会**共用** `decodeFrames` / `dispatch` 的
同步部分，只有 I/O 驱动不同（约 35 行 × 2）。这算不算硬约束 #9 的「同一件事写两份」？
**判断：不算**（驱动层不同），但会在文件头写清「`run()` 是兼容形态的遗留驱动，
新功能一律进 `runInteractive()`」。

> **实施后（2026-10-15）**：`run()` 保留在 `native-host.cjs`（约 60 行），新驱动在
> `core/ext-host-loop.cjs`。**`main.cjs` 实测 0 行改动**（内核类型基线一致 + diff 为空）。
>
> **⏭ 待办（独立小提交，别混进 3b）**：**A4** —— 删掉 `main.cjs` 那条兼容分支
> （`if (isHostArgv()) run()`），同时删掉 `run()` 与 `isHostArgv` 的形态③。
> 它是**行为变更**（Edge 若直接拉 `Harbor.exe`，将来会「开一个窗口」而非「假装 host 然后失败」），
> 所以不在 3a 做。

---

## 7. 超时 / 错误处理

| 场景 | 行为 |
|---|---|
| Harbor 没开（管道不存在） | `net.connect` 抛 ENOENT → `NO_HARBOR`（**立刻**，不等待） |
| Harbor 卡住（不应答） | host 8s 超时 → `TIMEOUT`；在途请求全清，返回扩展 |
| 主进程处理抛异常 | 回 `INTERNAL`（带人话），**管道与连接不受影响** |
| 帧长度离谱 | 双方 `MAX_FRAME = 1 MB` 截断/断开（同今天的 `fatal`） |
| token 不对 | `BAD_TOKEN`，**不执行**任何操作 |
| 中途断（Harbor 退出） | host 清空在途请求（各回 `NO_HARBOR`），下次请求重连 |
| 扩展侧重发 | 按 id 匹配，重复 id 视为新请求（host 不缓存应答） |

主进程侧**不需要超时**（它总应答），但**必须 `try/catch`** —— 一条请求炸掉不能让管道服务器倒。

---

## 8. 改动清单与行数影响

| 文件 | 类型 | 预估 |
|---|---|---|
| `electron/core/ext-protocol.cjs` | **新** | 帧编解码 + 类型/错误码常量（**唯一真相源**，从 native-host.cjs 搬出） |
| `electron/core/ext-client.cjs` | **新** | host 侧管道客户端：连接 / 请求 / 超时 / 重连（取代 `ext-forward.cjs`） |
| `electron/core/ext-host-loop.cjs` | **新** | host 事件驱动主循环 + 分派（`native-host.cjs` 放不下第二个循环） |
| `electron/core/ext-ops.cjs` | **新** | 主进程侧 kind → 处理函数的分派表 |
| `electron/core/ext-forward.cjs` | **删**（用户已批准） | 前提（单向、不等回复）已失效；并入 ext-client（同步改 `SAFE_MODULES` 与自检引用） |
| `electron/native-host.cjs` | 改 | 搬走 codec 与分派后约 230；再加 `runInteractive()` |
| `electron/core/ext-bridge.cjs` | 改 | 增量帧解码 / 长连接 / 应答 / 推送 / 裸 JSON 兜底（288 → 需拆，故有 ext-ops） |
| `electron/main.cjs` | 改 | **0 行**（A3） |
| `harbor-edge/extension/service-worker.js` | 改 | 301 → **拆**（pending Map + 请求函数抽成 `lib/native.js`） |
| `harbor-edge/src/sidepanel/App.tsx` | 改 | 新增 `SessionList.tsx`（避免贴线） |
| `scripts/selftest/groups/156-ext-bridge.mjs` | 改 | 加：分派 / 超时 / 错误码 / 裸 JSON 兜底 / push 形状 |
| `harbor-edge/tools/accept-phase3a.cjs` | **新** | 真机验收（§10） |

> **实施后的实际行数**（设计时是预估，这里以实测为准）：
> `ext-protocol` 294 · `ext-client` 261 · `ext-host-loop` 160 · `ext-ops` 156 ·
> `native-host` 270（原 301）· `ext-bridge` 239（原 288）· `service-worker` 204（原 301）·
> `SessionList.tsx` 165 · `accept-phase3a` 287 · 157 自检组 300。
> 落地时**多拆了两个**文件（`ext-host-loop.cjs`、`harbor-edge/lib/ext-stage.cjs`）——
> 详见交付报告第一节。

**零新依赖** ✅ · **零新增 IPC 通道** ✅（扩展走管道，不走 IPC）· 不碰 Runtime / 严格模式 /
防闪烁 / `hardenWebview` / 工具系统 / 权限模型 ✅

---

## 9. ★ 未验证假设（开工第一步必须先验，验不过就改设计）

1. **路线 A 前提**：`native-host.cjs` 在 `ELECTRON_RUN_AS_NODE=1` 下，改用 `stdin.on('data')`
   能正常收到 Edge 的帧（现用 `fs.readSync`），且**不发消息时进程不退出**。
2. **双源并存**：同一个进程里「stdin 事件 + 命名管道 socket 事件」能同时工作，空闲时**不忙等**
   （CPU 不飙）。
3. **帧协议共存**：新主进程能对「裸 JSON + 立刻关闭」的旧 host 连接做兜底解析
   （要写自检，不能只靠读文档）。

验法：写**一次性探针**（放 `tmp/`，跑完即删，不进版本库），像 Phase 1a/2 那样本地喂帧 + dump 字节。

### 9.1 ★ 探针结果（2026-10-15 已跑，**9/9 通过**）

探针形态：**真 `Harbor.exe` + `ELECTRON_RUN_AS_NODE=1`** 跑事件驱动原型（`tmp/_p3a_host_proto.cjs`，
用**真 codec**——直接 require `electron/native-host.cjs` 的 `encodeFrame`/`decodeFrames`），
对面是一个**假主进程**（`net.createServer`，收请求按 kind 回/不回）。

| # | 判据 | 实测 |
|---|---|---|
| ① | `stdin.on('data')` 能收到帧 → 经管道往返 → 回帧成功 | ✅ **61ms** 往返，拿到 2 条会话 |
| ①b | stdout 是纯帧（无 CRLF 污染） | ✅ 首 16 字节 `dd0000007b2274797065…`（长度前缀，非 `0d0a`）· 解出 1 帧 · 错误 0 |
| ③a | **正对照**：CPU 计数是活的 | ✅ 故意烧 200ms → 读到 **203.0ms** |
| ② | 空闲 30s 后仍存活 | ✅ `exitCode=null`，pid 不变 |
| ② | 空闲后**仍响应**（不是僵着） | ✅ 往返 **63ms** |
| ③b | 空闲期不忙等 | ✅ **30006ms 内 CPU 0.0ms（0.00%）**（即 < 0.05ms，读数下限） |
| ④ | 附赠：主进程不回 → host 侧超时 | ✅ **1556ms** 返回 `code=TIMEOUT`（探针把超时压到 1500ms） |
| ⑤ | 附赠：stdin EOF → 干净退出 | ✅ `exitCode=0` |

**为什么要有 ③a 这个正对照**：第一次跑时 ③ 读到 `0.0ms`，看着像「完美」，但**万一是计数器根本没动**，
那 0% 就什么也没证明。加上「故意烧 200ms → 读到 203ms」之后，`0.0ms` 才是**可信的真 0**。
（这条沿用 Phase 1a 的做法：用 `node.exe` 当正对照才锁定 `\r\n` 真因。）

**结论：路线 A 的前提成立，按 A 实施。**
`run()`（同步阻塞）保持不动 → `main.cjs` 0 行改动（裁决 A3）；新逻辑进 `runInteractive()`。

> 探针脚本本身**不进版本库**（跑完即删）——它验的是「能不能」，答案已固化在本节。

---

## 10. 验收标准（实施阶段用）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 真实 Edge 侧边栏**列出 Harbor 会话**（标题 + 时间） | 真机：起 Harbor + 起 Edge → 打开面板 → 读 DOM 文本 |
| 2 | 列表与 `session.list()` **一致**（条数 + 标题） | 脚本同时读 `data/sessions/*.jsonl` 比对 |
| 3 | Harbor **没开**时给人话（`NO_HARBOR`，不是干等） | 关掉 Harbor → 点刷新 → 读面板文案 |
| 4 | Harbor **不回应**时 8s 超时（`TIMEOUT`） | 探针：假管道服务器收下请求后不回 |
| 5 | `ext:page`（Phase 2 功能）**不回归** | 跑 Phase 2 的验收脚本 |
| 6 | 旧 host 形态仍能被新主进程收下（裸 JSON 兜底） | 自检：模拟裸 JSON + 关连接 |
| 7 | `npm run verify` 全绿 | — |

真机部分仍需**用户手点**（`activeTab` 只认真人手势，Phase 2 已实测）。

---

## 11. 用户裁决记录（2026-10-15）

| # | 问题 | 裁决 | 理由（用户原话要旨） |
|---|---|---|---|
| 1 | 架构：A 事件驱动 vs B 同步轮询 vs C worker | **A** | B 没有超时、3b 流式推送要重做。A 一次做对 |
| 2 | `main.cjs` 改造粒度：A3 / A1 / A4 | **A3**（0 行） | 3a 是通链路，不做架构清理；A4（删兼容分支）作为后续独立小提交 |
| 3 | `ext-forward.cjs` 删不删 | **删**，并入 `ext-client.cjs` | 它依赖的两条前提（单向、不等回复）在 3a 后都不成立；同步更新 `SAFE_MODULES` 与自检引用 |

**实施顺序**：先跑 §9 探针 → 探针通过则按 A 实施；**探针失败则停下报告，退回路线 B**。
