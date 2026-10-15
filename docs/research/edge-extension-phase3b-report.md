# Phase 3b 交付报告：侧边栏发消息 + 流式回复

> 日期 2026-10-16 · 设计说明见 [`edge-extension-phase3b-design.md`](edge-extension-phase3b-design.md)
> 前序：[`edge-extension-phase3a-report.md`](edge-extension-phase3a-report.md)（双向通道 + 会话列表）

---

## 一、改了什么

### 新增（6 个）

| 文件 | 行数 | 是什么 |
|---|---|---|
| `electron/core/ext-chat.cjs` | 226 | **转发 + SESSION_BUSY + 流快照**：校验 → 推给渲染层跑 → 旁听事件喂侧边栏 |
| `harbor-edge/src/sidepanel/ChatPanel.tsx` | 229 | 侧边栏**对话区**：发消息 + 流式显示（按 `seq` 丢重排旧片） |
| `harbor-edge/tools/accept-phase3b.cjs` | 308 | 真机验收（源码树实例 + 真 Edge + 真 host + 假上游） |
| `scripts/selftest/groups/158-ext-chat.mjs` | 153 | 自检 158 组（+46 条） |
| `docs/research/edge-extension-phase3b-report.md` | 本文件 | — |

### 改动（8 个）

| 文件 | 改了什么 |
|---|---|
| `electron/core/ext-protocol.cjs` | `KIND` 加 `CHAT_SEND`/`CHAT_RESUME`/`SESSION_ACTIVE`/`CHAT_EVENT`；`ERR` 加 `SESSION_BUSY`/`NO_SESSION`/`NO_WINDOW`；`push` 的 payload 字段钉死（钉在注释里，两侧共用） |
| `electron/core/ext-ops.cjs` | 分派表加 `chat:send`/`chat:resume`/`session:active`；**业务分支的 `{ok:false}` 原样透传**（不再套一层，否则 bridge 拿不到 code） |
| `electron/core/ext-bridge.cjs` | 注入 `chat`（relay） |
| `electron/core/ext-host-loop.cjs` | dispatcher 认三个新 type（只转发，业务判断全在主进程） |
| `electron/handlers/chat.cjs` | ★ **只加一个字段**：`streams.set(requestId, {controller, pause, sessionId})`（SESSION_BUSY 的判据） |
| `electron/register-handlers.cjs` | 建 relay + **给 `chat.cjs` 的 `send` 包一层**（旁听 `chat:event`）+ 绑桥 + 注进分派表 |
| `src/hooks/useExtBridge.ts` | 订 `ext:send` → 切到那条会话 → `sendMessage`（与用户手打**同一条路**） |
| `harbor-edge/extension/lib/native.js` | 认推送帧（无 `id`）→ 广播 `{type:'harbor-push'}` |
| `harbor-edge/extension/service-worker.js` | 转发 `chat-send` / `chat-resume` / `session-active` |
| `harbor-edge/src/sidepanel/App.tsx` | 占位输入框 → `<ChatPanel/>` |
| `tools/fake-upstream.mjs` | `SLOW_MS` 可调（验收用）+ **修 `slow` 模式的 `req.on('close')` bug** |
| `scripts/selftest/groups/156/157/groups.mjs` | 3a 的快照断言按 3b 更新（去写死计数）+ 注册 158 组 |
| `CHANGELOG.md` / `harbor-edge/README.md` | 记账 + 状态/遗留 |

**`electron/main.cjs`：`git diff` 为空** ✅（旁听包在 `register-handlers.cjs`，`chat.cjs` 只加 1 个字段）

---

## 二、为什么这么改（设计决策）

1. **主进程不自己跑那一轮**（C-α）。assistant 的落盘**只在渲染层**（`replyPersistence.ts`）；
   主进程自己调 `loop.run()` 就没有它 → 回复不落盘，且要再造一份落盘形状（违硬约束 #9）。
   所以这条路定为「**校验 + 转发 + 旁听**」，执行者始终是渲染层。
2. **旁听挂在 `send` 出口上**（包一层），不改 `chat.cjs` 的流逻辑、不新增状态，也**不改流向**。
   拿到的正是渲染层收到的那一批（content/reasoning **已过 50ms 合批**）→
   **两边打字节奏天生一致**，不需要在扩展侧再合一层。
3. **SESSION_BUSY 拒绝而不是排队**。渲染层遇到「这条会话在跑」是**静默排队**
   （`useThreadStore.ts:136`），侧边栏看不到那个队列 —— 用户会以为消息丢了。
4. **判据补在 `streams` 上，不新增状态**。`lifecycle` 的 `UNFINISHED` 看着像现成的，
   但它的 key 是 `taskId || requestId`（**不是会话 id**），没有「按会话查」的入口。
5. **续流按 `sessionId` 问**。真实那轮的 `requestId` 由渲染层生成，扩展侧从没听过；
   它只知道「我在看哪条会话」。`done` 那片**带全文** → 丢片也能最终一致。

---

## 三、怎么验证的

### 真机验收（15/15）

```
node harbor-edge/tools/accept-phase3b.cjs
```

真 Edge + 真扩展 + 真 native host（纯 Node 模式）+ **真源码树 Electron**（3b 改渲染层，
打包版是旧的）+ 假上游 `slow` 模式（800ms 一片）：

| # | 判据 | 实测 |
|---|---|---|
| ① | 源码树主窗口就绪 | textarea 出现 |
| ③ | 真扩展被加载 | `aaecjplphabhnagpmbbgipgnheaapjhc` |
| ⑥b | **连上的是我装的那台 host** | stderr 落盘为证（见「已知遗留」第 3 条） |
| ⑨ | ★ **逐片流式**（不是一次刷完） | `"慢1 慢2 ▍"` → `"…慢12"` |
| ⑩ | ★ **忙时被拒 + 人话** | 「这条对话正在别处运行（等它跑完，或先停止）」 |
| ⑫ | ★ **assistant 真落了盘** | 会话文件里有提问 + 回复 |
| ⑬ | 顺序对 | `user,assistant` |
| ⑭ | ★ **主窗口同一条会话里也看得到** | `{hasAsk:true, hasReply:true}` |

### 静态检查

| 项 | 结果 |
|---|---|
| `npm run verify` | **全绿**（❌0 / ✗0 / npm error 0） |
| 单测 | 194 文件 / **1765 通过** |
| 自检 | **4717 / 0**（新增 158 组 46 条） |
| 内核 `lint:kernel` | 288 个 `.cjs` 无未定义标识符 |
| 内核 `typecheck:kernel` | 与基线一致（181 条，未涨） |
| `typecheck`（src） | 0 错误 |
| 行数 | 1187 个文件全 ≤ 300 |
| 扩展侧 tsc（临时 tsconfig） | **ChatPanel 零错误**；2 条是 3a 既有的隐式 any（见遗留 2） |

---

## 四、已知遗留

1. **`run()` + `main.cjs` 那条兼容分支仍在**（A4 待办，USER 已裁决留作独立小提交）。
2. **扩展侧仍无类型检查**（`@types/chrome` 是红线）。既有 2 处隐式 any
   （`App.tsx:76` / `SessionList.tsx:91`）**未动** —— 不跨范围顺手改。
3. **验收脚本踩到一个真问题**：Edge 的 SW 在 Edge 启动时就已连上**旧注册指向的 host**；
   `stageHost` 换注册表**不会**让 SW 重连 → 我装的新 host 永不拉起（3a 侥幸没踩到）。
   现修法：先按 PID 杀「命令行指向 **repo** `native-host.cjs`」的 host（**绝不按映像名**）
   → SW 3 秒后自动重连 → 拉起我的。并加了 `⑥b` 判据把「连上的确实是我的」钉住。
4. **`pipeName()` 仍未做路径归一化**（3a 记的，未做）。
5. **主窗口销毁后就发不了**（C-α 的有意取舍，默认配置下不出现 —— 见 README）。

---

## 五、是否违反约束

| 约束 | 结果 |
|---|---|
| 零新依赖 | ✓ |
| 不碰 Runtime / 严格模式 / 防闪烁 / `hardenWebview` / 工具系统 / 权限模型 | ✓（旁听只读，不改流向） |
| `main.cjs` 改动最小 | ✓ **0 行** |
| 加逻辑前先拆 `ext-ops` | ✓（`ext-chat.cjs` 独立成文） |
| 单文件 ≤ 300 | ✓ 1187 个文件全过 |
| 不引新 IPC 通道 | ✓（复用 `chat:event`；`ext:send` 是它的一种 type） |
| 未做 3c（会话选择器）/ Phase 4 | ✓ |
| 改了代码必须写 CHANGELOG | ✓ |
