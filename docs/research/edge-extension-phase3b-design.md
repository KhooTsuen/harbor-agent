# Phase 3b 设计说明：侧边栏发消息 + 流式回复

> **状态**：设计待拍板 —— **第一节「谁落盘」必须先拍**，后面五节都建在它上面。
> **范围**：只含 3b。不含会话选择器 UI（3c）、不含 Agent 操作网页（Phase 4）。
> **前置**：`docs/research/edge-extension-phase3a-design.md`（双向协议）、
> `docs/research/edge-extension-phase3a-report.md`（3a 实测数字）。
> **红线（用户定，全篇遵守）**：零新依赖 · 不碰 Runtime / 严格模式 / 防闪烁 /
> `hardenWebview` / 工具系统 / 权限模型 · 单文件 ≤ 300 行。

---

## 0. 先说清一件事：真正的分歧不是「谁落盘」

「谁落盘」看起来是三个方案的选择，但它其实由**另一个更靠前的问题**决定：

> **这一轮对话，由谁来「跑」？**

因为**落盘不是独立动作，而是执行链条的最后一节**。现在的链条是：

```
渲染层 runElectronTurn()          ← 执行者
  → sendChat() IPC
  → 主进程 loop.run()             ← 产出 done 事件（content / reasoning / usage / toolRuns）
  → chat:event 推回渲染层
  → turns.ts:249 flushPartial()   ← 落盘（只在渲染层）
  → turns.ts:190 persistReply()   ← 落盘（收尾那条）
  → persistMessage() → IPC session:append → session.append() → 落进 jsonl
```

**主进程自己一个字节都不落**（`handlers/chat.cjs` 只 emit；`loop.cjs` 不落）。这是 3a 那轮挖到的关键事实。

所以「执行者是谁」有两种答案，三个方案分别落在不同答案上：

| 执行者 | 落盘形态 | 对应方案 |
|---|---|---|
| **渲染层**（复用现有 turn） | 不变（`replyPersistence` 照旧） | 方案 C 的主路径 |
| **主进程**（自己在 main 里跑 `loop.run()`） | **必须新造一份** | 方案 A |

**而「侧边栏渲染层落」（方案 B）在执行者这一层就直接不成立**（下面 §1.3 给死因）。

---

## 1. 第一节：谁落盘（★ 待拍板）

### 1.0 先摆事实（全部来自源码，不是推测）

| # | 事实 | 出处 |
|---|---|---|
| 1 | assistant 落盘**只有一个实现**，在渲染层 | `src/stores/thread/replyPersistence.ts`（`flushPartial` / `persistReply`） |
| 2 | 它由 turn 创建并驱动：每个事件调 `flushPartial`、收尾调 `persistReply` | `src/stores/thread/turns.ts:163 / :249 / :190` |
| 3 | 落盘出口是 IPC：`persistMessage` → `appendMessage` → `session.append` | `useAppStore.ts:224` · `src/lib/backend.ts:153` |
| 4 | **主进程完全不落 assistant 消息** | `handlers/chat.cjs`（只 emit）· `loop.cjs`（不写盘） |
| 5 | `done` 事件带的字段：`content / reasoning / usage / turns / toolRuns / exhausted` | `chat.cjs:222-229` |
| 6 | **`done` 不带** `rounds`（时间线）/ `citations` / `answersKey` / `clarify` | 同上 —— **这些只有渲染层有** |
| 7 | 关窗口**默认不销毁**渲染层（藏到托盘） | `main.cjs:135-141`（`minimizeToTray !== false`） |
| 8 | 状态机 key = `payload.taskId \|\| requestId`，**不是 sessionId** | `chat.cjs:54` |
| 9 | 「在跑的请求」真相源 = `streams: Map<requestId, {controller, pause}>` | `chat.cjs:140` / `:268` |
| 10 | 同 `key` 多次 append **会被读的一侧收敛成一条**；**多条完整记录时「最后写入的赢」** | `session-read.cjs:32-104` `collapseByKey` |

> ★ 第 10 条是**双刃**：它既是「重复落盘天然收敛」的依据，也是**「后写的会把先写的覆盖掉」**的风险。
> 规则原文：有非 `partial` 的 → 用它；多条非 `partial` → `out[at] = message`（**后者覆盖前者**）；
> 全是 `partial` → 最后一条 + `interrupted: true`。

### 1.1 方案 A：主进程自己落盘

**做法**：主进程在 `loop.run()` 收尾 / 分片时直接 `session.append`，assistant 消息由它负责。

**改动文件清单**

| 文件 | 改什么 |
|---|---|
| `electron/handlers/chat.cjs` | 新增落盘调用（收尾 + 分段） |
| `electron/core/ext-ops.cjs` | 新增 `chat:send` 分派（侧边栏发消息入口） |
| **新建** `electron/core/reply-write.cjs` | 主进程侧的「构造一条 assistant 记录」——**等于把 `replyPersistence.ts` 的逻辑翻译成 CJS** |
| `electron/core/session-write.cjs` | 大概率要加「**按 key 覆盖**」的写入口（现在是纯追加） |
| `scripts/selftest/groups/156/157` | 加断言（双写防护 / 形状对齐） |

**是否命中硬禁区**

| 禁区 | 命中 | 说明 |
|---|---|---|
| #9 跨模块约定只有一处真相源 | ★ **命中** | 「一条 assistant 记录长什么样」会变成**两份**（TS 一份、CJS 一份）→ 正是本项目一天栽四次的那类问题 |
| #11 加字段加状态 | ★ **命中** | `rounds` / `citations` / `answersKey` / `clarify` 这些字段主进程侧要么重造、要么缺 |
| IPC | 不命中 | 走管道 kind，不是新 IPC 通道 |
| Runtime | 不命中 | 但**如果**主进程要自己累积 rounds，就得复制 `streamEvents` 的分段逻辑 → 实质触碰 |

**重复落盘风险怎么防**

两条路必须**二选一，不能并存**：
- 若**同时**保留渲染层落盘 → 同 key 双写 → `collapseByKey` 取**最后写入**那条。
  **危险**：主进程那条晚写就会**覆盖**渲染层那条带 `rounds` 的完整记录 → 重开会话**时间线塌回三段堆叠**。
- 若**换掉**执行者（渲染层不再落）→ 无重复，但**渲染层那条路也要改**（否则主窗口自己发消息时没人落）。

→ 也就是说方案 A **不是「多写一份」而是「换一条路径」**，改动面比看起来大。

**主窗口关闭场景下的行为**

| 场景 | 行为 |
|---|---|
| 关窗口（默认 `minimizeToTray=true`） | ✅ 正常落盘（与窗口无关，这正是方案 A 的卖点） |
| `minimizeToTray=false` + 点 × | ✅ 正常落盘（渲染层已销毁也不影响） |
| Harbor 整体退出 | ✅ 无影响（进程没了，本来也不该跑） |

**回滚成本**：**中**。删掉主进程那段调用 + 恢复渲染层落盘即可，但**期间落下的记录形状已经不同**（缺 `rounds`），
老会话读回来会塌 —— 数据层面的痕迹不可回滚。

### 1.2 方案 C：两边协调（渲染层主路径 + 主进程兜底）

**做法**：默认仍由渲染层落（形状不变）；主进程**只在确认「没有任何渲染层在听」时**才兜底落一条基础形状。

**改动文件清单**

| 文件 | 改什么 |
|---|---|
| `electron/core/ext-ops.cjs` | 新增 `chat:send` 分派（侧边栏发消息入口）+ 转发给渲染层 |
| `electron/register-handlers.cjs` | 把 `extBridge` 实例注入 chat handler（现在只注入 `send`） |
| `electron/handlers/chat.cjs` | ① 加「无人听 → 兜底落盘」分支；② `streams` 记录里补 `sessionId`（第 9 条的 Map 要能按会话查） |
| **新建** `electron/core/ext-chat-bridge.cjs` | 侧边栏请求 ↔ 渲染层 turn 的桥（转发 + SESSION_BUSY 判据） |
| `electron/core/session-read.cjs` | ★ **小改** `collapseByKey`：让带 `degraded` 标记的记录**不能覆盖**非 degraded 的（见下） |
| `src/stores/thread/turns.ts` | 接住「来自侧边栏的发送请求」（复用同一套 turn） |
| `harbor-edge/extension/lib/native.js` | 加 `chatSend` / `chatResume` / `sessionLoad` 三个请求函数 |
| `harbor-edge/src/sidepanel/*` | 输入框 + 消息流（3b 的 UI 部分） |

**是否命中硬禁区**

| 禁区 | 命中 | 说明 |
|---|---|---|
| #9 | ⚠️ **边界** | 兜底那条形状**故意低一档**（缺 `rounds`），但**带显式标记 `degraded`** —— 不是「两处各写一套」，而是「一处完整 + 一处降级且标明」。仍需在设计里钉死标记名 |
| #11 | ⚠️ **小命中** | `collapseByKey` 要加一条「degraded 不覆盖完整」的判据 —— 这是**行为变更**，要单独说清 |
| IPC | 不命中 | 侧边栏走管道；转发给渲染层用**既有** `chat:event` 通道 |
| Runtime | 不命中 | turn 循环、loop、状态机全不动 |

**重复落盘风险怎么防**（三层）

1. **主路径优先**：只要渲染层在听，主进程**完全不写**（`getMainWindow() && !isDestroyed()` 判据）。
2. **同 key 收敛**：万一两边都写了，`collapseByKey` 收敛成一条（既有机制）。
3. **★ 降级不能覆盖完整**（需要新加）：给兜底那条打 `degraded: true`，并在 `collapseByKey` 里加判据 ——
   `degraded` 记录**永远打不赢**非 degraded 的。**理由**：现在的规则是「最后写的赢」，
   而兜底往往**晚于**渲染层写入（渲染层在收尾时才落）→ 不加这条就会**用降级覆盖完整**。

**主窗口关闭场景下的行为**

| 场景 | 行为 |
|---|---|
| 关窗口（默认 `hideToTray`） | ✅ 渲染层还在 → 主路径落盘（形状完整），兜底不触发 |
| `minimizeToTray=false` + 点 × | ⚠️ 渲染层销毁 → **兜底落盘**（基础形状 + `degraded` 标记） |
| 「执行者恒为渲染层」下的同一场景 | ❌ **拒绝发送**，人话「请先打开 Harbor 主窗口」（见 1.4 的 α/β 分歧） |

**回滚成本**：**低**。主路径没变；出问题就把「兜底分支」和 `collapseByKey` 那条判据删掉，
渲染层照旧工作。**没有数据形状的大面积变更**。

### 1.3 方案 B：侧边栏渲染层落盘（**结论：不成立**）

侧边栏是**扩展页面**，跑在 Edge 里：

- **没有 preload、没有 `window.workbench`** → 发不了 IPC；
- 而且就算能发，`register-handlers.cjs` 的 `trustedSender`（SEC-007）**只信应用主窗口的 webContents**
  → 侧边栏的 IPC 会被**直接拒绝**（这是刻意的安全边界，不是为了绕的）。

要让它落盘，只能新造一条「侧边栏 → 管道 → 主进程」的 append 路径：
- 等于把 `session:append` 的**形状契约**搬到扩展侧（`key` / `partial` / `rounds` / `answersKey`…）
  → 跨三个进程的字段约定 → **#9 的重灾区**；
- 而且**侧边栏跑不了 `loop.run()`**（执行者在主进程），所以它**拿不到 `done`、也拿不到 `toolRuns`**
  —— 它只能落「它收到的那些分片」，落不出完整记录。

**死因一句话**：**执行者不在侧边栏**，所以它无从知道「这一轮结束了没有、最终形状是什么」。

**（保留它的唯一形态）**：把「谁执行」也搬到扩展侧 —— 那等于在扩展里重写一遍 agent 循环，
不现实，也不在设计范围内。

### 1.4 三方案对比表（用户要求的五个维度）

| 维度 | A 主进程自己落 | B 侧边栏渲染层落 | C 两边协调 |
|---|---|---|---|
| **改动文件数** | 6 个（含 1 新建，且要**翻译** `replyPersistence`） | — **不成立** | 8 个（含 2 新建） |
| **命中硬禁区** | ★ #9 + #11 **明确命中** | — | ⚠️ #9 边界（降级+标记）、#11 小命中（`collapseByKey` 加判据） |
| **重复落盘怎么防** | 必须**换掉**执行者，不能并存 | — | 主路径优先 + 同 key 收敛 + **degraded 不覆盖完整** |
| **主窗口关闭** | ✅ 无影响 | ❌ 执行者不在那儿 | ✅ 默认配置无影响；极端配置走兜底 |
| **回滚成本** | **中**（数据形状痕迹不可回滚） | — | **低**（主路径未变） |
| **形状完整性** | ❌ 缺 `rounds`/`citations`/`answersKey`/`clarify` | — | ✅ 主路径完整；兜底显式降级 |

### 1.5 ★ 我的建议：走方案 C 的 α 形态

「谁落盘」定了之后，还要定**「执行者是谁」**—— 我建议 **执行者恒为渲染层**（记为路线 α）：

**路线 α（推荐）：侧边栏的发送请求，转交给主窗口渲染层去跑**

```
侧边栏「发送」→ host → 管道 chat:send → 主进程
  → 主进程推一条（既有 chat:event 通道同族的）「请跑这一轮」给渲染层
  → 渲染层走**一模一样**的 runElectronTurn()
  → 落盘、rounds、answersKey、clarify 全部零改动、零漂移
```

**优点**：
1. **落盘这个问题自动消失** —— 执行者是渲染层，落盘天然跟随，形状**逐字一致**（#9 最干净）。
2. **改动最小**：3b 只需加「侧边栏 → 渲染层」这一段转发，不碰任何落盘逻辑。
3. **主窗口关闭几乎不是问题**：默认关窗口 = `hideToTray`，渲染层还在。
4. **回滚最容易**。

**代价（诚实说清）**：`minimizeToTray=false` 且窗口已销毁时，侧边栏发消息会被**拒绝**（人话
「请先打开 Harbor 主窗口」）。这是**有意的取舍**，不是缺陷 —— 与「宁可少做一个功能，也不要
两份形状各写一遍」这条项目原则一致。

**如果你更看重「主窗口不在也能用侧边栏」，那就得选路线 β（主进程跑）** —— 但那时方案 A 的
#9/#11 代价必须一起接受（或者接受降级形状 + `degraded` 标记）。

---

## 2. 第二节：流式分片粒度

**结论：直接复用 `electron/core/stream-batch.cjs` 的 50ms 合批 —— 不要自己再定一套。**

依据：

| 事实 | 出处 |
|---|---|
| 已有批处理器，`DEFAULT_FLUSH_MS = 50`（约 20 条/秒） | `stream-batch.cjs:48` |
| 它存在的理由是实测：每 token 一条跨进程投递会把主进程事件循环卡 **5~14 秒** | `stream-batch.cjs:6-14` |
| `chat-emit.cjs` 已经把 content / reasoning 的增量走这个 batcher，结构性事件立刻发 | `chat-emit.cjs:33-37` |
| 触发方式已修过坑：**按时间判断**，不靠 `setTimeout`（定时器被忙时推迟 → 变成 1.1 秒一条、一次憋 588 字） | `stream-batch.cjs:28-47` |

**为什么不要另定粒度（这是关键）**：
如果 3b 自己合一层（比如逐句、或另一个时间片），**侧边栏与主窗口的打字节奏会不一致** ——
同一条会话两处同时看时，一边快一边慢，用户立刻能看出来。**复用它 = 两边天生同步**。

**补充两条（3b 要做的，与 batcher 无关）**：

1. **首片立即发**（不等 50ms 窗口）—— 对主观「快慢」最值钱：用户要的是「马上有反应」。
2. **单帧上限 32 KB**：有些 provider 一次回一大块（工具结果回填），必须兜住。
   —— 超限就**切多帧**（同一 `seq` 段内允许续帧），不是丢弃。

---

## 3. 第三节：断了怎么续

### 3.1 先把「断」分成三类

| 类 | 现象 | 恢复要点 |
|---|---|---|
| (a) 扩展侧断 | SW 被回收 / 侧边栏关了 / Edge 关了 | **执行者不受影响**（主进程还在跑）→ 重开后**补齐** |
| (b) Harbor 崩 | 主进程没了 | 流**必然中断**；渲染层的 `flushPartial` 已经落过磁盘 → 靠磁盘恢复 |
| (c) 上游断 / 用户中止 | `aborted` / `error` | 走 `persistReply`（`aborted` 也落，`error` 不落） |

### 3.2 「上次流到哪」由谁提供

**不能靠侧边栏自己记**（SW 会被杀、`chrome.storage` 也不适合当权威）。
**也不能靠 events**：`events.cjs:19-20` 明确写着**「流式增量不落盘」是刻意取舍**，
环形缓冲 `RING_SIZE=300` 且全体事件共享 —— 一部长回答就冲光了。

**方案：主进程维护一份内存快照**（这是 3b 唯一必须新增的状态）

```
streamSnapshot: Map<requestId, { sessionId, seq, text, reasoning, done, at }>
```

- **只在「有流在跑」时存在**，`done` 后延迟清（建议 60 秒，给慢的侧边栏留窗口）。
- **`text` 是累积全文**，不是分片数组 —— 侧边栏重连后**一次拿快照**，不重放几百个分片。
- 恢复流程：
  1. 侧边栏重开 → `session:load { sessionId }` 拿**磁盘全文**（权威，流可能早就结束了）
  2. 再问 `chat:resume { sessionId }`：
     - 有快照 → 回 `{ seq, text, reasoning, done:false }`，之后只接 `seq >` 的分片
     - 无快照 → 回 `{ done:true }`（流已结束，磁盘那份就是最终答案）
- **收尾顺序陷阱**（`chat.cjs:245-268`）：`finally` 里 `flush()` → `metrics.finish` → `life.forget` → `streams.delete`。
  快照**必须在这之前**标 `done:true`，否则侧边栏会问到「已结束但看起来还在跑」的窗口期。
  → 设计上定死：**先标 done，再清 streams**。

### 3.3 磁盘是永远兜得住的那一层

- 渲染层的 `flushPartial` 已经保证「流式过程中分段写盘」（≥3 秒 + 内容够长才写，`partial: true`）。
- 进程被强杀时，`collapseByKey` 会把最后一条 partial 收敛成一条并标 **`interrupted: true`**
  → 界面能说「这条没写完」，而不是让用户以为模型就写了这么多。
- ★ **这也回答了 3a 报告里那个担心**：「主窗口不在 → 半截回复压根没写进会话」——
  在**路线 α（执行者=渲染层）**下这个担心**不成立**（没有执行者就没有流；有执行者就有落盘）。

---

## 4. 第四节：侧边栏与主窗口的关系

**结论：数据共享、各自独立选会话 —— 不是「镜像主窗口」。**

- 侧边栏自己维护 `activeSessionId`（存 `chrome.storage`），与主窗口的 `activeThreadId` **解耦**。
- 「同一条会话两处同时看」是**自然结果**，不需要「镜像」这个概念：
  两处都在订阅同一条会话的事件流。
- 好处：你在主窗口干别的，侧边栏照样盯住一条会话。

但有两件事必须**在 3b 定死**：

1. **同一会话两处同时发 → 显式拒绝**（不要静默排队）—— 见第六节。
   （注意：渲染层的 `turnControl` 有 `drainQueued` 排队机制，所以**必须显式判**，
   否则会变成「悄悄排队」，用户以为消息丢了。）
2. **assistant 落盘时机** —— 在路线 α 下**不用改**（执行者还是渲染层）。
   若走路线 β，必须回来改这一节。

---

## 5. 第五节：push 协议要加什么字段

**★ 帧形状零变更** —— `ext-protocol.cjs:181` 的 `push({kind, payload})`
（`{v, push:true, kind, payload}`）**不动**。只往 `payload` 里加字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | string | 这一轮的 id（与 `chat:event` 的同一个） |
| `sessionId` | string | 落到哪条会话 |
| `seq` | number | **单调递增**，从 1 开始；侧边栏据此去重 / 判缺口 |
| `type` | string | `content` / `reasoning` / `done` / `aborted` / `error`（**复用现有事件名**，不另起一套） |
| `text` | string \| null | 本次增量（`content`/`reasoning` 时给；其余为 null） |
| `done` | boolean | 收尾片（`type=done` 时 true） |

**为什么 `seq` 是必须的**：没有它，侧边栏分不清「这条分片是不是重复的」、
也判不出「是不是漏了一段」。**这是第三节快照恢复的地基。**

**为什么不另起 `chat:delta` 这个 kind**：`ext-protocol.cjs:174-177` 已经占了 `chat:delta` 作占位，
但**名字对齐现有事件类型**（`content`/`reasoning`/`done`）能让两侧共用同一套分支判断，
少一处「翻译层」。→ **3b 起用 kind = `chat:event`**（与既有通道同名，语义一致），
`payload.type` 区分具体事件。**这条要写进协议注释**，否则 3b 会再想一次。

---

## 6. 第六节：SESSION_BUSY 冲突处理

### 6.1 ★ 先纠正一个判据（3a 报告里的建议不能直接用）

3a 报告建议「用 `lifecycle` 的 `UNFINISHED` 判会话冲突」—— **实测源码后不成立**：

- `chat.cjs:54`：`phaseKey = payload.taskId || requestId` —— **不是 sessionId**；
- `lifecycle` 的注册表是 **`taskId → machine`**（`lifecycle.cjs:181`），没有「按会话查」的入口；
- 所以 `UNFINISHED.has(machine.phase)` **判不出「这条会话在跑吗」**。

**可行的判据（改动最小的那条）**：

```
「这条会话在跑」= streams 里存在某个 entry，其 sessionId === 目标 sessionId
```

- `chat.cjs:140` 现在是 `streams.set(requestId, { controller, pause })`
  → **补一个字段** `sessionId`（`streams.set(requestId, { controller, pause, sessionId })`）。
- 判据函数放主进程（`ext-chat-bridge.cjs`），扫 `streams` 一遍即可（同一时刻在跑的请求是**个位数**）。
- `streams.delete(requestId)`（`:268`）已经把「跑完了」这件事管住了 → **不用新增状态**。

### 6.2 判据表

| 情况 | 判据 | 行为 |
|---|---|---|
| 目标会话正在跑 | `streams` 里有同 `sessionId` | ❌ 拒绝：`SESSION_BUSY` |
| 目标会话没在跑 | 上面为空 | ✅ 接受，进入发送流程 |
| 目标会话不存在 | `session.load(id)` 抛 / 无 meta | ❌ 拒绝：`NO_SESSION` |
| Harbor 没运行 | 管道 ENOENT（host 侧就挡住） | ❌ `NO_HARBOR`（3a 已有） |
| 渲染层不在（路线 α） | 主进程判 `getMainWindow()` 为空/已销毁 | ❌ 拒绝：`NO_WINDOW` |

### 6.3 错误码（加进 `ext-protocol.cjs` 的 `ERR`，唯一清单）

| code | 含义 | 侧边栏文案 |
|---|---|---|
| `SESSION_BUSY` | 这条对话正在别处运行 | 「这条对话正在别处运行 —— 等它跑完再发，或切到那条对话看」 |
| `NO_SESSION` | 会话不存在（可能已被删） | 「这条对话已经不在了（刷新列表看看）」 |
| `NO_WINDOW` | 需要主窗口（路线 α 的代价） | 「请先打开 Harbor 主窗口（点托盘图标）」 |

**为什么是「拒绝 + 人话」而不是「静默排队」**：
渲染层本来就有排队（`drainQueued`），照抄那个行为会让侧边栏用户以为消息丢了
（发出去没反应、界面上也没有「排队中」）。**拒绝至少是诚实的。**

### 6.4 一个必须一起定的细节：谁先落 user 消息

侧边栏发消息时，**user 那条谁落盘**？

- 现有链路里 user 消息由**渲染层**落（`useThreadStore.ts:203` `persistMessage(threadId, userRecord(...))`）。
- 路线 α 下：发送请求转到渲染层 → 渲染层落 user → **一致，零改动**。
- 若主进程抢先落 user（比如为了「侧边栏立刻看到自己发的那条」）→ **双写**，
  且 user 那条**没有 key 时各算一条**（`collapseByKey` 里 `!key` 直接 push）→ **会出现两条一样的提问**。

→ **结论：user 消息也一律由渲染层落**。侧边栏要「立刻看到自己发的」，靠**本地乐观渲染**
（自己先在 UI 上画一条，等 `chat:event` 回来再对齐），**不要提前写盘**。

---

## 7. 待拍板清单

| # | 要拍的 | 选项 | 我的建议 |
|---|---|---|---|
| 1 | **谁落盘** | A 主进程自己落 / B 侧边栏落（**不成立**）/ C 两边协调 | **C** |
| 2 | **执行者是谁**（这个比 1 更靠前） | α 恒为渲染层（主窗口必须在）/ β 主进程自己跑 | **α** |
| 3 | 若选 α：主窗口不在时 | 拒绝（`NO_WINDOW`）/ 兜底降级落盘 | **拒绝**（最简单、无形状风险） |
| 4 | push 的 kind 名 | `chat:delta`（3a 占位）/ `chat:event`（与通道同名） | **`chat:event`** |
| 5 | 快照保留时长 | 30s / 60s / 120s | **60s** |

**拍板后我再进入实施；在此之前不写任何产品代码。**
