# Phase 5 设计说明：一轮对话的「收尾」在事件生命周期上只有一条路

> 2026-10-12。针对「后端任务已成功（commit + tag 都成了），对话 UI 却卡在运行中/中断、无法自动回 idle」。
> 本文**只做定位与设计**，不含任何代码改动。改哪里、改到哪一层，等拍板。

## 0. 一句话结论

**渲染层的「运行中」是由 `thread.phase` 推出来的，而 `phase` 是一条「只进不退」的闩锁。**
只要终止类事件（`agent.completed/failed/cancelled`）没到达渲染层，`phase` 就永远停在
`executing`，UI 永久显示「运行中」，**代码里没有任何一条自动复位路径**。

而终止事件为什么会到不了：**主进程允许一条 `run_shell` 命令静默跑 600 秒，渲染层却把
「静默 300 秒」判成卡死并退订 —— 两个模块对「多久没消息算死」各有一套数，且长命令不发心跳。**

## 1. 真机证据（`E:\Harbor-Dev\dist-portable\Harbor\data\logs\2026-10-12.log`）

| # | 证据 | 位置 |
|---|---|---|
| 1 | 那一轮最终**正常完成**：`对话完成：47 轮，56 次工具调用，用时 977.3 秒` | 第 643 行（04:12:55.503） |
| 2 | 完成之前有一段**完全静默 305.3 秒**（04:02:01.473 → 04:07:06.737，其间无任何日志） | 第 615→616 行 |
| 3 | 全日志里 `对话中止` **命中 0 次** —— 主进程**从没发过 aborted** | 全文扫描 |
| 4 | 下一轮（新消息）在 04:13:31 就开始跑、04:14:08 完成 —— 说明当时**用户是在同一会话里又发了一条** | 第 644–649 行 |
| 5 | 任务台账**没有**卡住：`task_mv49ggy8_9p2z`（「我现在可以在本地更新了吧？」）= `completed` | `data/tasks/*.json` |

⇒ 结论：**`done` 发出去了**（证据 1），**不是卡的**；卡住的是渲染层那份 `phase`。

## 2. 现状链路（事件生命周期）

```
主进程 chat:send ──► loop.run ──► life.mark(preparing/thinking/executing/…)
                                     │ 每次转移
                                     ▼
                     emit(phase 事件) ──► send('chat:event') ──► 渲染层
                                                                    │
                            streamEvents.ts:90 setThreadPhase(id, phase)
                                                                    │
                                              useAgentActive = sendingThreads || isActivePhase(phase)
                                                                    │
                                                                    ▼
                                                          界面显示「运行中 / 停止按钮」
```

**关键**：`setThreadPhase` 全仓**只有 `streamEvents.ts:90` 一处调用**（我 grep 过，其余命中全是测试）。
也就是说 —— **phase 的推进完全依赖事件到达**。没有任何代码在事件缺失时把它收口。

## 3. 根因（四条，逐条可指认）

### RC-1（直接原因）「运行中」看 phase，而 phase 没有复位路径

- `src/hooks/useAgentActive.ts:27` → `return localPending || isActivePhase(phase)`
- `src/lib/agentPhase.ts:39` → `isActivePhase('executing') === true`（不在 idle/paused/终态里就算在跑）
- 所有**兜底恢复**路径都只动别的字段，**都不写 phase**：
  | 路径 | 位置 | 做了什么 | 写了 phase 吗 |
  |---|---|---|---|
  | 看门狗超时 | `turns.ts:213-221` | `finish()` + `status='sent'` + `setThreadStatus('error')` | ✗ |
  | 用户点停止 | `useThreadStore.ts:251-263` | 清 `sendingThreads` + abort | ✗ |
  | 发送失败 | `turns.ts:290-296` | `status='error'` | ✗ |
  | 图片校验失败 | `turns.ts:150-160` | `status='error'` | ✗ |
- ⇒ **一条丢失的终止事件 = UI 永久假死**，且**没有超时兜底**（看门狗清的是 `sendingThreads`，
  而 `phase` 仍然让 `useAgentActive` 返回 true）。

### RC-2（为什么终止事件会丢）两个模块的「卡死口径」不一致

| 模块 | 口径 | 出处 |
|---|---|---|
| 主进程 `run_shell` | 单条命令最长 **600 秒**（默认 60s，`Math.min(600, …)`），**期间不发任何 `chat:event`** | `electron/core/tools/run_shell.cjs:142` |
| 渲染层看门狗 | 连续 **300 秒**没收到 `chat:event` = 卡死 → 放弃这一轮 | `src/stores/thread/turns.ts:51` |

- `ctx.progress`（心跳）**机制早就铺好了**（`electron/core/tool-run-ctx.cjs:32` 定义 `agent.tool.progress`），
  但 **`run_shell` 从未调用它** —— 长命令在整个执行期间零事件。
- ⇒ 一条**正常**的长命令（`git commit` 触发 pre-commit 钩子跑完整自检 / `npm run verify`）会被**必然误判**。
  真机证据 2 的 305.3 秒静默正是这一条。

### RC-3（放弃之后不叫停）看门狗只退订、不 abort

```js
// turns.ts —— onTurnTimeout
const onTurnTimeout = () => {
  finish()                    // ← off()：退订事件流；清 sendingThreads；endTurnRequest
  patch({ status: 'sent', … })
  useAppStore.getState().setThreadStatus(threadId, 'error')
}
```

- **没有** `stopActiveRequest` / `abortChat`。主进程继续跑；它稍后发出的 `done`
  落进一个**已经退订**的订阅里 → **静默丢弃**（真机证据 3：从没 aborted；证据 1：done 照发）。
- 这正是 `turnWatchdog.ts` 文件头自述的 2026-10-04 症状（「界面死了、后台还在写」
  「它自己中断了，可任务最后又完成了」）。**那次只改了判定口径（总时长→静默），没改终态动作** ——
  所以症状原样复现。**这是它「修了好几次仍复现」的原因。**

### RC-4（同族）点「停止」不清看门狗

- `stopGeneration`（`useThreadStore.ts:251`）清了 `sendingThreads`，但看门狗是
  `runElectronTurn` 闭包里的局部量，**只有 `finish()` 能 dispose**。
- ⇒ 用户点停止后 300 秒，看门狗照旧醒来，把**用户已经停掉的**那一轮
  `setThreadStatus(id, 'error')`，并往消息里写「长时间没有新内容」——
  用户看到「我明明停了，它过几分钟自己变错误」。

### 关于 M1（`observer.flush()`）—— 排除

`chat.cjs:219` 的 `emit({type:'done'})` 在 `chat.cjs:253` 的 flush **之前**，同一个同步块里。
flush 既不能延迟 `done`，也不能吞掉它（而且它还包了独立 try-catch）。
**M1 与本次现象无关**，无需加计时器验证。

## 4. 为什么「在 UI 层打补丁」治不了

- 强制把 `sendingThreads` 清空（现有的乐观 UI、已经这么做）**不解决**：`useAgentActive` 是 **OR**，
  `phase` 那一半仍然是 true。
- 强制把 `phase` 重置成 `idle`：**能骗过界面，但主进程那一轮还在跑**（RC-3），
  稍后 `done` 到达时又是一次状态错位 —— 而且这正是「UI 层补丁」的定义。
- 真正的根因在**收尾这件事在生命周期上不完整**：一轮有「开始」的权威事件，却没有**必然到达**的「结束」事件。

## 5. 修复方案（分三层，逐层标越界）

### A 层 · 渲染层（不在禁区清单；会动 3–4 个文件 → 触发 §3.1「≥3 文件先问」）

- **A1 收尾必须收口 phase**：`finish(reason)` 里按 reason 同步写终态
  （正常 done 已由事件给 `completed`；超时 → `failed`；用户停止 → `cancelled`）。
  → 直接消灭 RC-1；不是「强制重置」，是补上缺失的那次终态转移。
- **A2 超时时真的叫停主进程**：`onTurnTimeout` 调 `stopActiveRequest(threadId)`
  （**复用现有 `chat:abort`，不新增 IPC 通道**），并**保留订阅**直到收到 `aborted`/`done`（或再加一个硬宽限）。
  → 消灭 RC-3。
  > ⚠️ **A2 单独做是有害的**：现在的超时只是「放弃」，主进程还活着，长命令能跑完；
  > 一旦改成「真叫停」，而 `run_shell` 又允许跑到 600s —— **一条正常的长命令会在 300s 被误杀**。
  > ⇒ **A2 必须与 B1（心跳）同时上**；或者把叫停的硬宽限提到 `run_shell` 上限之上（>600s）。
  > 这是本轮设计里唯一一处「改一半会更糟」的地方，写在这里备查。
- **A3 停止时 dispose 看门狗**：`stopGeneration` → `watchdog.dispose()`。→ 消灭 RC-4。

### B 层 · 主进程（**触及「事件发出逻辑」，需你破例**）

- **B1 长命令发心跳**：`run_shell` 跑着时每 N 秒 `ctx.progress({percent:null, note:'命令还在跑'})`。
  → 从根上消灭 RC-2 的误判（心跳机制已存在，只是没人用）。
- **B2（可选）**「一轮还在不在跑」的权威判定收回主进程：渲染层不该靠静默猜。
  这条改动面更大，**建议本轮不做**，仅登记为方向。

### C 层 · 口径统一（AGENT.md 硬约束 #9 要求「一处真相源」）

- 「多久算卡死」现在有 **两个数**（600s / 300s）。跨进程（`.cjs` ↔ `.ts`）**没法共享常量**，
  ⇒ 正确解不是「把两个数对齐」，而是**让长命令发心跳**（B1），使「静默」这个判据不再被正常长命令触发。
- 加自检钉子：① 渲染层任何 `finish` 路径都必须写 `phase`；② `run_shell` 必须有周期性心跳。

**明确不会碰**：IPC 通道清单、权限/安全模型、数据结构与迁移、任务台账、`loop.cjs`/`task.cjs`/`session*.cjs`/`changeset.cjs`。

## 6. 回归测试设计（你要求的两条）

- **长耗时命令**：把看门狗的 `silenceMs` 注入成小值（它本来就支持注入 clock），
  让一轮里塞一段「超过阈值不出事件」的模拟，断言：**UI 不进假死、最终必到非活跃态**。
  加一条源码钉子：`finish` 的每条路径都写了 phase。
- **强制中断并发**：跑一轮 → 中途 `stopGeneration` → 断言 ① `phase` 进终态 ② `sendingThreads` 清空
  ③ 主进程收到 abort ④ **停止后再发一条能正常发出**（队列不死锁）。
  现有 `src/stores/__tests__/turns.test.ts` 已能注入假的 `set`，扩进去即可。

## 7. 建议的最小可行组合

**A1 + A2 + A3 + B1**（四个点、约 4 个文件）：能同时消灭 RC-1/2/3/4，且
不碰任何禁区文件、不加 IPC 通道、不改数据结构。**B2 只登记不实施。**
