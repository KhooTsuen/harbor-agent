# Runtime 事件到 UI 的展示链路（ui-event-trace）

> 只读调研。行号均来自 HEAD `847cfc3`（`electron/**` 为 `.cjs`，不参与 tsc）。

## 1. 统一事件契约

事件形状**只定义一处**：`src/types/chat-events.ts` 的 `ChatEvent` 联合类型（:16-178）。
内核侧同名的类型由 `electron/core/events.cjs` 的总线统一结构 + `agent.*` 落盘保证。

| 层 | 位置 | 作用 |
|---|---|---|
| 内核事件类型 | `src/types/chat-events.ts:16-178` | 渲染层认的事件形状（唯一真相源） |
| 内核总线 | `electron/core/events.cjs`（`bus.emit`，见 `chat-emit.cjs:16,30`） | 环形缓冲 300 + `agent.*` 落盘 `data/events/` |
| 推送到渲染层 | `electron/core/chat-emit.cjs:23-47` | `send('chat:event', {...})` |
| IPC 通道 | `electron/preload.cjs:6`（`EVENTS=['chat:event']`）+ `:243`（`onEvent`） | 只转发这一个对话通道 |
| 渲染层订阅 | `src/lib/subscriptions.ts:12-15` | `bridge.onEvent` |
| 消费入口 | `src/stores/thread/turns.ts:246-259` | 按 `requestId` 过滤后调用 `handleStreamEvent` |
| 状态归约 | `src/stores/thread/streamEvents.ts:79-...` | 每种事件 → 消息字段 |
| 语义色 | `src/lib/statusLanguage.ts:61-128` | 唯一一份状态色彩/文案 |

> 总线把**一次对话的所有事件**放进一个通道（`chat:event`），与终端输出（`onShellData`）、下载（`downloads:event`）、生图（`image:*`）分开——见 `preload.cjs:5`、`subscriptions.ts:76-90`。

## 2. 完整链路 A：正文增量 content

```
loop 产生增量
 └ emit({type:'content', text})                     chat.cjs:83 → chat-emit.cjs:28
    ├ bus.emit('content', ...)                       chat-emit.cjs:30（总线+落盘）
    ├ metrics.observe(...)                           chat-emit.cjs:31（TTFT 等）
    └ batcher.put('content', text)                   chat-emit.cjs:33-35（20 条/秒合批）
       └ send('chat:event', {requestId,type,text})   chat-emit.cjs:25
          └ preload onEvent                          preload.cjs:243
             └ subscribeChatEvents                   subscriptions.ts:12-15
                └ turns.ts:246-258（requestId 不等即 return）  turns.ts:247
                   └ handleStreamEvent               streamEvents.ts:79
                      case 'content'                 streamEvents.ts:97-104
                         state.content += text
                         currentRound(state).content += text
                         state.patch({content, rounds})   ← 写进 store 的这条消息
                            └ MessageItem            MessageItem.tsx:132-138
                               └ MessageRounds       MessageRounds.tsx:58-96
                                  └ StreamingMarkdown（仅最后一轮）  MessageRounds.tsx:87-88
```

首字上屏打点：`streamEvents.ts:99`（`markFirstContent`）。

## 3. 完整链路 B：工具事件

```
emit({type:'agent.tool.started'|'agent.tool.completed'|'agent.tool.failed'})
 └ handleStreamEvent                                  streamEvents.ts:115-184
    ├ started  → push ToolRunRecord + round.tools 下标   :115-131
    ├ completed/failed → 就地更新那条记录                 :147-184
    │   ├ void useTaskStore.refresh()                  :170（任务台账刷新）
    │   ├ useAuditStore.bump()                         :172（底部日志）
    │   └ citationsOf(...) 捞引用                       :174-179
    └ patch({toolRuns, rounds})
       └ ToolLine（一行摘要，可展开）                    message/ToolLine.tsx:59-141
```

子代理内部步骤：`subagent.step` → `applySubagentEvent`（`streamEvents.ts:142-145`）→ `SubagentCard`（`ToolLine.tsx:119-121`）。
工具进度：`agent.tool.progress` → `applyToolProgress`（`streamEvents.ts:134-139`）。

## 4. 任务「进度」的真实数据来源

| UI 数字 | 来源 | 是否等于进度 |
|---|---|---|
| 任务「步骤」 | 模型输出的 plan 块解析而来：`task-core setPlan`（`task.cjs:153`）、`task-context.cjs:247`；`task.steps`（`task-context.cjs:187`） | ❌ **是模型的计划，不是真实执行步骤**（规范第 7 节） |
| 「N 步」工具数 | `runs.length`（`ToolLine.tsx:100-102`） | 计数，非进度 |
| 耗时 | `sum(run.ms)`（`ToolLine.tsx:70`） | 有依据 |
| 任务运行秒表 | `TaskCenter` 的 `now` 每秒跳（`TaskCenter.tsx:69-76`） | 有依据（真实时钟） |
| 会话 token | 累加 `message.usage`（`StatusBar.tsx:22-31`） | 有依据 |
| 相位文案「正在执行」 | 主进程状态机 `lifecycle.mark` → phase 事件 | 有依据（状态机），但**不表示百分比** |

> 结论：右栏/对话里的「进度」目前**没有可计算的百分比依据**；展示的是**阶段（phase）+ 计数**。`TaskRow` 的进度条若存在，需核对是否有依据 —— 见 `ui-noise-audit.md`。

## 5. 状态跨层传递（授权 / 失败 / 暂停 / 取消 / 恢复）

| 语义 | 内核 | 事件 | 渲染层落点 |
|---|---|---|---|
| 授权请求 | `chatConfirm.askUser`（`chat.cjs:150`） | `confirm_request`（`chat-events.ts:88-100`；`confirm_request` 携带审批 id，`chat-emit.cjs:38-46` 注释） | `askPermissionFor`（`confirmEvents.ts`）→ `PermissionBar`（kind='run-command'）/ `PermissionDialog`（应用级） |
| 授权超时 | — | `confirm.timeout` | `onCardTimeout`（`streamEvents.ts:193-196`） |
| 工具失败 | — | `agent.tool.failed`（名字自带成败，`chat-events.ts:41-42`） | `ToolRunRecord.ok=false`（`streamEvents.ts:147-163`） |
| 循环暂停 | `loop.run` 返回 paused | `phase`/`agent.paused` | `pausedResult`（`loop-result.cjs:21-32`）→ 任务台账 `paused` |
| 轮数用尽 | — | `done`（`exhausted:true`） | `exhaustedResult`（`loop-result.cjs:35-65`） |
| 取消 | `signal` → `agent.cancelled` | `aborted`（`chat.cjs:244`） | `streamEvents.ts:237-...`（标 interrupted） |
| 阶段 | `lifecycle.forTask().to()` | `agent.*`/`phase`（`chat.cjs:162`；`PHASE_TO_EVENT`） | `setThreadPhase`（`streamEvents.ts:86-93`） |

## 6. 完成状态的区分度（规范第 3 节第 7 问）

内核给了**三种「停下来」的形状**：正常 `done`、暂停 `paused:true`（`loop-result.cjs:21`）、轮数用尽 `exhausted:true`（:35）。任务台账状态取值（`statusLanguage.ts:143-160`）：`running / paused / waiting_user / completed / failed / cancelled`。

- ✅ **区分**「执行停止（paused）」「已完成（completed）」「失败（failed）」「取消（cancelled）」「等确认（waiting_user）」。
- ❌ **未区分**「验证通过」与「交付可用」：内核有 `agent.verification.started` 相位（`agentPhase`/`lifecycle`），但任务终态仍只是 `completed`——**没有独立的 verification 通过态，也没有「交付完成」态**。
  - 证据：`task.cjs` 字段里没有 `verification` / `delivered`；`loop.cjs:216` 只 `life.mark('verifying')`。

## 7. 自由文本猜状态 / 硬编码文案

| 类型 | 位置 | 说明 |
|---|---|---|
| 从自由文本猜**意图** | `task-context.cjs` `isContinueIntent(goal)`（`loop-run.cjs:43` 调用） | 用关键词判断用户是否想「继续」——属于「从自由文本猜」 |
| 从自由文本猜**能力边界** | `core/capability-bounds.cjs`（`chat.cjs:183` 发 `boundary`） | 命中原文随事件带上（`chat-events.ts:134` `matched`），供误报时判断 |
| 状态文案（唯一一份） | `lib/statusLanguage.ts:61-76` | 组件禁止自写语义色（:26-30，有测试盯） |
| 相位描述文案 | `lib/agentPhase.ts:55-...` | 「正在准备任务」等 |

## 8. 事件丢失 / 乱序 / 重放 / 恢复一致性

| 风险 | 现状 | 证据 |
|---|---|---|
| 乱序（先结果后过程） | 有防护：非增量事件发送前先 `batcher.flush()` | `chat-emit.cjs:37` |
| 过滤错位 | 渲染层按 `requestId` 过滤 | `turns.ts:247` |
| 确认被顶掉 requestId | 有防护：`requestId` 放最后展开 | `chat-emit.cjs:38-46` |
| 生图重放 | 按内容去重 | `useBackendSubscriptions.ts:96-113` |
| 应用重启后一致性 | 任务列表靠 task-index 重建；未完成任务由启动提示指向右栏 | `useBackendSubscriptions.ts:41-50`；`TaskCenter.tsx` 文件头 |
| 半截回复（进程中断） | 读回标 `interrupted`（`session-read.cjs:84-91`）；界面提示「这条回复没写完」 | `MessageItem.tsx:155-159` |

## 9. 绕过契约的页面

- **浏览器预览**（`useRealBackend=false`）走 mock 数据（`lib/mock`），不接真实事件——只有在桌面版才是真实链路。
- `useBackendSubscriptions` 里生图/插件/下载各有独立通道，**未混入** `chat:event`（`subscriptions.ts:76-90`）——这是有意的分离，不是绕过。
- 未见「某页面自己另开一份对话事件源」的情况；所有对话事件都汇到 `streamEvents.ts`。
