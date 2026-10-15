# Phase 3c · 交付报告：侧边栏点选会话 / 未选中自动新建 / 顶栏 ＋

> 2026-10-16。用户报的两个 bug（抽屉点不动、未选中发消息不同步）。
> **用户拍板**：① 点条目**只切侧边栏**（主窗口不动）；② 未选中发消息**新建一条**；③ ＋ 要真能用。

---

## 1. 改了什么

| 文件 | 动作 | 说明 |
|---|---|---|
| `electron/core/ext-protocol.cjs` | 改 299 行 | KIND 加 `SESSION_SELECT` / `SESSION_NEW` / `SESSION_SELECTED`（推送） |
| `electron/core/ext-chat.cjs` | 改 300 行 | 加 `selectedSessionId`（**侧边栏自己**的选中）+ `handleSelect` / `handleNew` / `noteActiveSession`；`handleSend` 未选中时请渲染层新建 |
| `electron/core/ext-ops.cjs` | 改 174 行 | 分派表加两条 |
| `electron/core/ext-bridge.cjs` | 改 300 行 | **修 `deps.chat` 没赋值**（静默短路）+ `setActiveSession` 时同步侧边栏选中 |
| `electron/core/ext-host-loop.cjs` | 改 201 行 | dispatcher 认 4 个 type（原来 2 个） |
| `src/stores/useThreadStore.ts` | 改 300 行 | `sendMessage(override, resume, targetThreadId?)` —— **不传 = 老行为** |
| `src/stores/app/diskActions.ts` | 改 112 行 | 新增 `hydrateThread`（读 MEMORY 但不切当前会话） |
| `src/stores/app/types.ts` | 改 138 行 | 声明 `hydrateThread` |
| `src/hooks/useExtBridge.ts` | 改 132 行 | `ext:send` 支持指定会话（先 hydrate 再发）+ 新增 `ext:new` |
| `harbor-edge/extension/service-worker.js` | 改 300 行 | 加 `session-select` / `session-new` 两个入口；`chat-send` 带 `sessionId` |
| `harbor-edge/src/sidepanel/SessionDrawer.tsx` | 改 246 行 | 条目 `li` → **button** + `aria-current` 高亮 + `onSelect` |
| `harbor-edge/src/sidepanel/ChatPanel.tsx` | 改 296 行 | `sessionId` 改由 App 传入；发送时带上它；未选中不再禁用发送 |
| `harbor-edge/src/sidepanel/App.tsx` | 改 ~290 行 | 订阅 `session:selected`；`selectSession` / `newSession`；＋ 接真的 |
| `harbor-edge/tools/accept-phase3c.cjs` | **新增** | 20 条判据的真机验收 |
| `scripts/selftest/groups/158-ext-chat.mjs` | 改 | +20 条断言（含 3c 的选会话 / 新建 / 学到真 id） |
| `scripts/selftest/groups/156-ext-bridge.mjs` | 改 | 「3c 未做」→「3c 已做」 |
| `CHANGELOG.md` / 本报告 | 改 | 记账 |

**`electron/main.cjs` 与 `electron/ipc-channels.cjs` 零改动**（仍走 `chat:event`，不新增 IPC 通道）。

---

## 2. 为什么这么改

1. **「只切侧边栏」在旧架构下做不到**：`sendMessage` 写死读 `getActiveThread()`、而
   「切会话」的唯一实现（`openFromDisk`）里就 `set({ activeThreadId })`。所以必须给
   `sendMessage` 加一个**可选**的目标会话 —— 不传就是老行为，主窗口那条路一个字没变。
2. **发到非当前会话前必须先 `hydrateThread`**：`history` 读的是内存里的 `messages`，
   没读过 = 空数组 = **模型只看得见刚那一句**（上下文全丢）。这就是必须新增它的唯一理由。
3. **`turns.ts` 一行没改**：整条链（`addMessage` / `updateMessage` / `sendChat` /
   `sendingThreads` / `subscribeChatEvents` 按 requestId 过滤）本来就用局部 `threadId`，
   所以「后台对非当前会话跑一轮」天然成立。
4. **「未选中就新建」放在主进程判**：渲染层 `sendMessage` 遇到在跑的会话是**静默排队**，
   侧边栏用户看不到那个队列 —— 所以忙/未选中的判断都在 `ext-chat.cjs`，拒绝也回人话。

---

## 3. 怎么验证的

| 验证 | 结果 |
|---|---|
| `accept-phase3c.cjs`（新，20 条） | **20/20** |
| `accept-phase3b.cjs`（回归） | **15/15**（流式 12 片 / 忙时被拒 / 落盘 / 主窗口同一条） |
| `accept-phase3a.cjs`（回归） | **16/16** |
| 自检 | **4744 / 0**（+20 条） |
| 单测 | **1765 / 1765** |
| `npm run verify` | **全绿**（❌0 / ✗0 · 内核与基线一致 · 1187 文件全 ≤300 · 构建成功） |

**真机硬证据（本次最该看的两条）**：

| 判据 | 实测 |
|---|---|
| 只切侧边栏 | 主窗口 `sess_mv9vqovtyaenb` **不变** · 侧边栏 → `sess_mv9vpidy6quhi` |
| 未选中发消息 | `未选对话` → 发「三c 未选中直接发」→ 流式回来 → 侧边栏变成 `sess_mv9vqovtyaenb` |
| ＋ 新建 | 侧边栏 `sess_mv9vpidy6quhi` → `pending_…` · **主窗口也跟着切了** |
| 落盘 | `sessions` 34 → 36，且文件里**真有**我发的那句话 |

---

## 4. 过程中修掉的三个真问题

### ① `ext-bridge.cjs` 的 `deps.chat` 从未赋值（我自己引入的静默 bug）

`start()` 里只把 relay 传给了 `createOps`，**没赋给 `deps`** → 我写的
`deps.chat?.noteActiveSession?.()` 因 `?.` **静默短路**。症状：点 ＋ 新建了、
但侧边栏标题不变（真机 ⑩ 红），且**不报错**。

### ② 我自己的验收判据有假绿（必须先承认）

3c 最初用 `[aria-label="当前对话"]` 判「主窗口没被切走」—— 而那个锚点在 `App.tsx`
（**侧边栏自己**），主窗口里根本没有 → 读回空串 → `'' === ''` **恒真**。
同一条判据在 ⑩ 又变成假红。改成问主进程 `session:active` 才拿到真值。

### ③ `fake-upstream.mjs` 的 slow 间隔不可调（3b 遗留）

默认 5 秒/片 × 12 片 = 60s，验收会超时。脚本侧传 `FAKE_SLOW_MS=800`（**默认值不变**）。

---

## 5. 已知遗留（4 条）

1. **点 ＋ 只建本地会话、不立刻落盘**（磁盘文件在**首次发送**时才建，与主窗口行为一致）。
   验收 ⑪ 因此改成「在新会话里发一条 → 看它落盘」。
2. **`accept-phase3c.cjs` 341 行**（`harbor-edge/tools/` 验收资产，`line-limit.mjs` 不覆盖 —— 同 3b）。
3. **`run()` + `main.cjs` 兼容分支仍在**（A4 待办，用户裁决留作独立小提交）。
4. **`pipeName()` 未归一化路径**（3a 记的，仍未做）。

## 6. 是否违反约束

- 单文件 ≤300 ✓（产品源码；`useThreadStore.ts` 恰好 300）
- 零新依赖 ✓ · `main.cjs` / `ipc-channels.cjs` 0 行 ✓
- **渲染层发送链被改 = 命中硬禁区，用户已单独批准**（选项里写明代价后选的 B）
- 不碰 Runtime / 严格模式 / 防闪烁 / hardenWebview / 工具系统 / 权限模型 ✓
- 改了代码 → CHANGELOG ✓
