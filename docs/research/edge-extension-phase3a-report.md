# Phase 3a 交付报告：双向通信 + 会话列表读取

> 设计说明：`docs/research/edge-extension-phase3a-design.md`（含三项裁决 §11、探针结果 §9.1）
> 自检 **4674 / 0** · 真机验收 **15/15** · `npm run verify` 全绿

---

## 一、改了什么

### 新增（5 个）

| 文件 | 行数 | 是什么 |
|---|---|---|
| `electron/core/ext-protocol.cjs` | 294 | **协议的唯一真相源**：帧编解码（从 native-host 搬来，**同一份实现**）+ 报文构造 + 错误码 + 管道名/token |
| `electron/core/ext-client.cjs` | 261 | host 侧通道客户端：双向（懒连 / 保持 / 按 id 匹配 / 8s 超时 / 重连）+ **兼容形态**的同步写 |
| `electron/core/ext-host-loop.cjs` | 160 | host 事件驱动主循环 + `createDispatcher`（串行处理链 + push 转发） |
| `electron/core/ext-ops.cjs` | 156 | 主进程侧分派表（kind → 处理函数，依赖注入、不抛） |
| `harbor-edge/extension/lib/native.js` | 159 | 扩展侧通道层：**按 id 的 pending Map**（取代单槽）、懒连、状态广播 |
| `harbor-edge/src/sidepanel/SessionList.tsx` | 165 | 会话列表区块（只读：标题 / id / 相对时间 / 消息数） |
| `harbor-edge/lib/ext-stage.cjs` | 91 | 验收共用：装/卸**隔离的** native host（从 accept-phase2 抽出） |
| `harbor-edge/tools/accept-phase3a.cjs` | 287 | 真机验收（§10 七条判据） |
| `scripts/selftest/groups/157-ext-protocol.mjs` | 300 | 自检组（协议 / 分派 / host 循环 / 接线 / 裸 JSON 兜底） |

### 改动（8 个）

| 文件 | 变化 |
|---|---|
| `electron/core/ext-bridge.cjs` | 288 → **239** 行：增量帧解码、连接保持、按 id 应答、`push()`、**裸 JSON 兜底** |
| `electron/native-host.cjs` | 301 → **270** 行：codec 转出协议层、白名单换模块、`require.main` 进 `runInteractive()` |
| `harbor-edge/extension/service-worker.js` | 301 → **204** 行：通道层拆走，只留接线 + `read-page` + `session-list` |
| `harbor-edge/extension/manifest.json` | 加 `"type": "module"`（ESM import 必须）、版本 0.4.0 |
| `harbor-edge/src/sidepanel/App.tsx` | 加 SessionList 区块 |
| `harbor-edge/lib/ext-probe.cjs` | 加 Phase 3a 共用表达式 + `runHost` 用 `taskkill` |
| `scripts/selftest/groups/156-ext-bridge.mjs` | 换掉已删的 ext-forward 依赖 + 新增两组断言 |
| `scripts/selftest/groups.mjs` | 注册 157 |

### 删除

- `electron/core/ext-forward.cjs`（93 行）—— 两条前提「单向」「不等回复」在 3a 后都不成立，逻辑并进 `ext-client.cjs`。**同步更新**了 `SAFE_MODULES` 与自检引用。

### `main.cjs`

**diff = 0 行**（裁决 A3）。验证方式：

```
npm run typecheck:kernel → ✓ 内核 75 个 .cjs 的类型错误与基线一致
git diff --stat electron/main.cjs → (空)
```

---

## 二、为什么这么改（设计决策，不是复述 diff）

1. **难点不在协议，在「谁等谁」。** 双向要求 host 同时等 stdin 与管道回复，而单线程同步循环（老的 `run()`）只能等一个。`run()` 那句「永不返回」还是 `main.cjs` 的**承重墙**（`if (isHostArgv()) run()` 没有 else，`run()` 一返回就会去建窗口）。
   → 所以**新增** `runInteractive()` 而不是改 `run()`：零回归、零风险，代价是两套 I/O 驱动（已裁决）。

2. **协议必须只有一处定义。** 状态码、报文形状、管道名，两侧都要用。各写一份的后果不是「不一致」而是「**链路直接不通**」，且两侧各自的单测都自洽 —— 只在真机现形。→ `ext-protocol.cjs`，自检钉「`H.encodeFrame === P.encodeFrame`」。

3. **「应答 vs 推送」靠有没有 `id`。** 3b 要主进程主动推流式分片。现在就定死这条，否则 3b 会想再改一次协议。

4. **判据要按「实际会收到的字节」写，不按想象。** 裸 JSON 兜底那条判据（`fatal` + 首字节 `{`）是**实测**出来的：旧 host 的裸 JSON 被当帧头解出来是 1,869,881,979（荒谬长度）→ fatal。纯函数测不出来，必须真 socket 喂。

5. **兜底路径不能 drop 连接。** 第一版把裸 JSON 也当「协议失步」→ 直接断连 → 兜底逻辑根本没机会跑（探针逮到）。改成「识别出来后**攒着等 `end`**」—— 那条连接是**完全有效的旧客户端**。

---

## 三、怎么验证的

### 真机验收 `harbor-edge/tools/accept-phase3a.cjs` → **15/15**

真 Edge（隔离 profile）+ 真扩展（构建产物，ESM SW）+ 真 `Harbor.exe`（`ELECTRON_RUN_AS_NODE=1`）+ 真命名管道 + 真 `session` / 真 `audit`。

| # | 判据（设计说明 §10） | 实测 |
|---|---|---|
| 1 | 侧边栏列出 Harbor 会话（标题 + 时间） | ✅ **17 条**，标题对得上、带相对时间 |
| 2 | 与 `session.list()` 一致（条数 + 标题） | ✅ 面板 **17** / 磁盘 **17** |
| 3 | Harbor 没开时给人话（`NO_HARBOR`） | ✅ `code=NO_HARBOR`，err「Harbor 没有在运行（先启动 Harbor）」 |
| 4 | Harbor 不回应时超时（`TIMEOUT`） | ✅ **19.5s** 后回 `code=TIMEOUT` |
| 5 | `ext:page` 不回归 | ✅ 内容仍过 `wrapWebText` + `source=extension` |
| 6 | 裸 JSON 兜底（旧 host → 新主进程） | ✅ 自检里**真管道真 socket** 跑：落盘 + 桥仍健康 |
| 7 | `npm run verify` 全绿 | ✅ 见下 |

**这一轮不需要用户手点** —— `session:list` 不碰页面内容，所以不需要 `activeTab`（那是「读页面」的权限）。Phase 2 那条 `activeTab` 路径仍需人手，与本步无关。

### 自检 `npm test` → **4674 / 0**

- 新增 157 组 50 条：协议报文与判据（含「有 id 无 kind 也算协议帧」）· `ext-ops` 分派（含**抛异常转 INTERNAL** —— 管道服务器不倒）· host 循环 dispatch（假 client 驱动）· 接线（含「`main.cjs` 仍未被改」）· 裸 JSON 兜底（真管道）。
- 改 156：去掉对已删 `ext-forward` 的依赖 + 新增「兼容形态 / Phase 3a 通道层」两组。

### 早于自检的临时探针（跑完即删，结论已固化）

设计说明 §9.1：**9/9**（`stdin.on('data')` 能收帧 · 空闲 30s 存活且仍响应 · **CPU 0.0ms 且带正对照 200ms→203ms**）。
实施中另跑了一个 bridge 探针 **15/15**（新协议往返 106ms · 裸 JSON 兜底 1→2 · `NO_HARBOR` 89ms）。

### `npm run verify`

```
✓ 内核 287 个 .cjs：没有未定义的标识符（允许清单为空）
✓ 内核 75 个 .cjs 的类型错误与基线一致（基线 181 条，只许下调）
✓ 行数 ≤ 300　1185 个文件全 ≤ 300 行
✓ 依赖两侧一致　36 个依赖
✓ 未写 CHANGELOG → 已补（见 CHANGELOG.md 顶部）
```

---

## 四、过程中修掉的 4 个缺陷（3 个是我自己的，1 个是产品）

| # | 是什么 | 谁的问题 | 怎么发现的 |
|---|---|---|---|
| 1 | **`SessionList` 请求失败后不自动重试** —— 顶部「已连接」、列表却报「没连上 Harbor」，自相矛盾，不点刷新永远是错的 | ★ **产品** | 真机验收 ⑦ 报 FAIL |
| 2 | 裸 JSON 被当协议失步 → 直接断连，兜底逻辑没机会跑 | 我的实现 | bridge 临时探针 ⑥ FAIL |
| 3 | `runHost` 用 `child.kill()` —— **Windows 上杀不掉 Electron**，host 还连着管道 → `server.close(cb)` 回调永不触发 → 脚本挂死 240s | 我的验收脚本 | 脚本超时 |
| 4 | 断言假设「旧 host 能读到主进程的回复」 | 我的断言 | 自检 FAIL（旧 host 写完就关连接，**读不到** —— Phase 2 就记录过） |

另外两处**验收脚本的脆弱点**（不是产品问题，但值得记）：管道名复用导致 `EADDRINUSE`（改成三段各用独立管道名）· 固定等待判不准管道释放（改成真探测）。

---

## 五、已知遗留

1. **`run()`（同步阻塞）仍在** —— 兼容形态的遗留驱动，`main.cjs` 那条分支的承重墙。裁决 A3 明确「新功能一律进 `runInteractive()`」；`run()` 里只服务 `ext:page` 那一条（同步写）。
2. **A4（删兼容分支）未做** —— 属**行为变更**（Edge 若直接拉 `Harbor.exe` 会变成「开一个窗口」），按裁决留作**后续独立小提交**。
3. **3b / 3c 未做**（按边界）：发消息 / 流式回复 · 会话选择器 UI / 点击切换。
4. **`push()` 已就位但 3a 不调** —— 3b 的流式分片直接用它（形状已定死，见协议层 `push()`）。
5. **扩展侧仍无类型检查**（`@types/chrome` 是红线，已记技术债）。
6. **会话列表不显示「当前打开的是哪条」** —— 属 3c 的范畴。

---

## 六、是否违反约束

| 约束 | 结果 |
|---|---|
| 零新依赖 | ✓（`node:net` / `node:fs` 都是内建） |
| `main.cjs` 0 行改动（A3） | ✓ 实测（内核类型基线一致 + diff 为空） |
| 不碰 Runtime / 严格模式 / 防闪烁 / `hardenWebview` / 工具系统 / 权限模型 | ✓（改动全在 `electron/core/ext-*` / `native-host.cjs` / `harbor-edge/**`） |
| 加逻辑前先拆 `ext-ops.cjs`（bridge 已 288 行） | ✓（bridge 反而降到 239） |
| 删 `ext-forward.cjs` 时同步 `SAFE_MODULES` + 自检 | ✓ |
| 不做发消息 / 流式回复（3b） | ✓ |
| 不做会话选择器 UI（3c） | ✓ |
| 不做 Agent 操作网页（Phase 4） | ✓ |
| 单文件 ≤ 300 行 | ✓（1185 个文件全 ≤ 300） |
| 写 CHANGELOG | ✓ |
| 按协议走 | ✓（三层验收：临时探针 → 自检 → 真机；每层都真跑） |

**未输出任何未验证的「已完成」**：真机验不到的部分（`activeTab` 人手路径、3b/3c 功能）在上面第四节、第五节如实列出。
