# 收尾 + 拆 maxTokens

> 本文件是这五步任务的进度台账。每完成一步就更新这里。
> 报告格式见文末（一句话总结 / 逐步 / 最终验证 / 我替你做的决定 / 没做完的 / 明天建议先看什么）。

## 任务

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 第一步 | #8 browse 提示（B 方案：toast 去重 + 标签角标 + 系统通知） | ✅ 完成（含真机两轮） |
| 第二步 | #7 的 error 分支缺口（`status === 'error'` 时整条时间线不渲染） | ✅ 完成 |
| 第三步 | 拆 maxTokens（一物二用 → 先出方案） | ✅ 完成（方案见下，未触发停止条件） |
| 第四步 | B3 附件路径（**只调研**，等拍板） | ✅ 调研完成（结论：不修，两条修法都踩停止条件） |
| 第五步 | 最终验证（全链 + 清理测试痕迹） | 未开始 |

---

## 第一步：#8 browse 提示

### 问题

Agent 用浏览器做三件事（读元素 / 点 / 打字）时，界面上**唯一的线索**是右侧面板
悄悄切到「浏览器」标签。用户在看对话、或者右栏是折叠状态时，等于**一点声响都没有**：

- 前台：没有 toast（`useBrowseBridge` 只给 `navigate` 写了 toast，另外三个动作没写）
- 后台：没有系统通知（只有「任务结束」和「需要你确认」会发）
- 界面：右栏标签上没有任何标记

而窗口不在前台时这个问题最严重 —— 用户切去别的应用干活，回来才发现 Agent 已经
在网页上点了十几次。

### 方案（B 方案：四处补，各有各的粒度）

| 落点 | 文件 | 粒度 |
| --- | --- | --- |
| 应用内 toast | `src/lib/browseNotice.ts` + `useBrowseBridge.ts` | **同一种动作只提示一次**，换动作才再说一句 |
| 右栏标签角标 | `useBrowserStore.agentAt` + `RightTabs.tsx` | 静态的点（**不闪**），用户点开看过就减掉 |
| 系统通知 | `electron/handlers/browse-notify.cjs` + `notify.cjs` | 不在前台才发，**一条对话最多一条** |
| 点通知回哪里 | `useTaskNotifications.ts` | 切回那条对话 + 右栏落到浏览器标签 |

### 为什么去重是功能本身、不是优化

一个任务里 Agent 常常 `snapshot → click → type → snapshot…` 连做十几步。
每步一条 toast，几秒钟就能糊满屏幕 —— 用户会把提示整个关掉，于是**全都没用了**。
所以「连着点 10 次只提示 1 次」是验收条件，写成了测试。

系统通知那边去重粒度**故意不同**：toast 按「动作」去重（换个动作是有意义的进展），
系统通知按「会话」去重（一条对话只提醒一次）。理由：toast 是即时的、可忽略的；
系统通知会占据屏幕右下角、还会进 Windows 通知中心，一个任务弹十几条就是骚扰。

### 为什么注入点放在 `handlers/browser.cjs` 的 `request()`

`navigate / snapshot / click / type` 四路请求**都走这一个函数**。
挂在四个 `core/tools/browse*.cjs` 里写四遍，迟早漏一个 ——
而漏掉的那个动作会静默地什么都不提示。

（工具的 `ctx.sessionId` 因此要跟着 payload 传下去：主进程要用它做去重键和点击跳转。）

### 拆了一个文件（硬约束 #2）

加上角标之后 `src/components/layout/RightPanel.tsx` 到了 **321 行**，破线。
按「天然的缝」拆的：标签栏（含各标签角标）搬去 `src/components/layout/RightTabs.tsx` ——
它只关心「有几个标签、当前是哪个、各自显示什么角标」，不关心下面是文件树还是 diff。

- 没有留空占位（踩坑记录 #2），原处是**删掉**的。
- 两个守接线的测试跟着改（`errorsPanel.test.ts`、`taskCenter.test.ts`）：
  断言「标签表里有这一项」改看 `RightTabs.tsx`，同时**新增**断言
  `RightPanel.tsx` 里 `RightTabs` 真的被用上 —— 换文件不等于放宽。

### 验证

- `npm run typecheck` / `lint` / `check:format` / `check:lines` / `lint:kernel` / `test:unit` 全绿
  （单测 141 文件 1207 项；内核自检 3675 项 0 失败）
- 新增测试：`src/lib/__tests__/browseNotice.test.ts`（9 项）、
  `useBrowserStore.test.ts` 加 4 项角标测试
- 新增内核自检组：`scripts/selftest/groups/112-browse-notify.mjs`（26 项）——
  去重规则、「不在前台才发」、最小化也算不在前台、点通知带 `kind=browse`、
  四个工具都传了 `sessionId`、装配线真接了通知器

### 真机（两轮，`npm run shot:electron` 同款探针）

**为什么必须真机**：这一条的价值全在**接线**上 —— 单测能证「去重函数算得对」，
证不了「浏览请求真的会走到它」。而原问题正是「一点声响都没有」，属于典型的
「测试照不到的那一层」。

第一轮（`tmp/probe-b8-browse.js`），让它 `browse → 读元素 → 点链接 → 再读元素`：

| 观察点 | 结果 |
| --- | --- |
| toast | 4 条，依次是「正在用浏览器读取网页 / Agent 正在读网页元素 / Agent 正在网页上点击 / Agent 正在读网页元素」 |
| 相邻两条标题 | **没有重复**（去重规则在真机上成立） |
| 右栏标签轨迹 | 任务 → 浏览器（Agent 自己把面板切过去了） |
| 角标 | 跑的时候看不到（浏览器标签就是当前标签）；**手动切到「审查」→ 出现，切回「浏览器」→ 消失** |
| 内核日志 | 4 条 `浏览通知：窗口在前台，不发系统通知` —— 请求真的走到了通知器，且**前台正确地没打扰** |

第二轮（`tmp/probe-b8-repeat.js`），专门逼出**同一个动作连着做**：
`browse → 读元素 ×3`（工具序列从任务台账里核对过）：

| 观察点 | 结果 |
| --- | --- |
| 内核收到的浏览请求 | 4 次（日志 4 条「浏览通知」） |
| 界面弹的 toast | **2 条**（navigate 一条、读元素一条）—— 后两次读元素被压掉 |
| 结论 | ★ 「连着做同一个动作只提示一次」在真机上成立 |

跑完按既有基线机制还原 `E:\Harbor\data`（先备份 → 逐字节核对 → 还原，
**不按扩展名判断**）：还原后 dry-run 显示「新增 0 / 追加 0 / 重写 0」。

---

## 第二步：#7 的 error 分支缺口

### 定位（为什么 error 时整条时间线不见了）

`MessageItem` 原文是**二选一**的结构：

```tsx
{isError ? <div role="alert">错误话</div> : <div>…整条时间线（只读卡 / 工具 / 正文）…</div>}
```

也就是「出错」把「时间线」整个替换掉了。而出错是**常见路径**（模型超时、供应商 401、
上下文超限都会走到 `status: 'error'`），于是那些「真发生过」的东西全部不可见：
调过的工具、改过的文件、**开工前答过的澄清卡**（小尾巴 #7 的另一半）。
用户只能看到一句报错，根本判断不了「刚才那几步做没做」——只能重来，而重来可能又踩同一个坑。

### 修法

1. 结构改成「错误块 + 时间线**都画**」：红底块的 `role="alert"`、颜色、边距**一个字没动**，
   只是把 `null` 换成「继续排时间线」。
2. 顺带拆出一个 `roundsOfError`（`components/chat/message/roundsOf.ts`）：
   出错时 store 把**同一句话**同时写进了 `errorText` 和 `content`，时间线照常渲染后那句错
   会**再说一遍**。所以：有真 `rounds` 的记录照旧；只有合成轮的老记录把**正文**抹掉、
   **工具记录留着**（工具正是「看不见就会以为白干」的那部分）。

### 验证

新增 `src/components/chat/__tests__/errorKeepsTimeline.test.tsx`（7 项）：

- 红底错误块还在（`[role="alert"]` 不是 null）；
- **中间调过的工具看得见**（以前整条被吞）；
- **开工前答过的澄清卡看得见**（含「屏幕像素（已选）」）；
- **那句错误话只说一遍**（专门钉住 `errorText` / `content` 重复那条）；
- 老记录（无 `rounds`）出错时工具仍在、正文不重复。

同时把 `clarifyRecordVisible.test.tsx` 里那条**钉住旧行为**的断言改成正的：
以前它断言「`status: 'error'` 时不显示只读卡」，现在断言**显示**（这是本次要改的行为，
不是放宽断言）。

---

## 第三步：拆 maxTokens（一物二用）

### 一物二用是什么

`assistant.maxTokens` 名义上是「**模型输出上限**」（设置 → 模型 → 输出上限），
但内核 `loop-prompt.cjs` 把**同一个数**塞给了 `contextBuilder.assemble()` 当
「**上下文预算基准**」（字符预算 = 它 × 3，再按 `context.budget` 的百分比分给
系统提示 / 项目文件 / 记忆 / 对话…）。于是这两件事互相掐：

- 想让回复能写长一点 → 输出上限 0 → 20000 → 上下文预算**跟着翻倍**（没人预料得到）；
- 想省上下文 → 压小输出上限 → 回复也变短，还容易被截断。

### 方案（已实现）

| 项 | 结果 |
| --- | --- |
| 新字段名 | `context.baseTokens`（**不叫** `maxOutputTokens` —— 见下） |
| 默认值 | `16384`（= 现测出来的那个基准，行为与「原来填 0」完全一致） |
| 夹取范围 | `2000–128000`（下限与 `context-builder.cjs` 的 `Math.max(2000, …)` 对齐） |
| `0` / 不填 | 当「没设置」→ 用默认 16384（`0` 在本项目配置里一贯是「不限/没填」，不是「零预算」） |
| 只填输出上限 | 上下文基准**还是 16384**（这就是「拆」） |
| 只填 `baseTokens` | 输出上限照旧走它自己的规则（`0` = 不限，按模型声明的最大输出） |
| 老配置迁移 | **不做**（理由见下） |
| 设置界面 | **不改**（那个输入框本来就是「输出上限」，语义一直是对的） |

### 为什么不新增 `maxOutputTokens`

`assistant.maxTokens` 的语义本来就是输出上限 —— 它没写错，只是**被多读了一处**。
重命名/新增一个输出字段，只会多出「两个地方都能填，谁赢」的问题，
而输出侧那个读者里有**硬禁区** `loop.cjs`（不许动）。所以最小改动是：
**把上下文那一侧的读取点改掉，输出侧一个字不碰**。

### 为什么不做迁移

`config-normalize.cjs` 把 `version: 2` **写死**（规范化层自己不动磁盘），
没有可信的「这是老配置」标记 —— 想靠版本号做一次性迁移做不成。
所以只靠默认值：缺 `baseTokens` → 16384。

**唯一的行为变化**：老配置里 `assistant.maxTokens` 非零的人，上下文基准从「那个值」
变成 16384（本机 `config.json` 是 `maxTokens: 0` → **零影响**）。
方向是安全的：基准变小只会让裁剪更早发生（不会崩、不丢数据），
而且「输出上限」从此不再是上下文的隐藏旋钮。

### 全部读取点（改完后）

| 用途 | 读谁 | 文件 |
| --- | --- | --- |
| 上下文预算基准 | `context.baseTokens` | `electron/core/loop-prompt.cjs`（唯一注入点） |
| 压缩提示线 / 自动线 | `context.baseTokens` + `context.compactAt/autoCompactAt` | `src/stores/useThreadStore.ts` → `thread/compact.ts` |
| 形状声明 | — | `electron/core/config-defaults.cjs`、`config-normalize.cjs`、`src/types/safety.ts`、`src/components/onboarding/previewConfig.ts` |
| **输出上限**（未改动） | `assistant.maxTokens` | `loop.cjs`（硬禁区）、`loop-model.cjs`、`llm-body.cjs`、`diagnostics.cjs`、设置页 `ProviderPanel.tsx` |

### 验证

- 新增 `src/stores/thread/__tests__/contextBaseSplit.test.ts`（11 项）：
  解耦（输出上限填 20000 → 基准仍 16384；反向也成立）、默认值与夹取（含 `0`/垃圾值/越界）、
  以及**源码级接线断言**（`loop-prompt.cjs` 含 `config.context?.baseTokens` 且
  **不含** `config.assistant.maxTokens`；`useThreadStore.ts` 读 `context?.baseTokens`；
  `loop-model.cjs` 仍读 `config.assistant.maxTokens`；设置页仍写 `assistant.maxTokens`）。
- 全量：`typecheck` / `lint` / `lint:kernel` / `check:format` / `check:lines` 全 0；
  单测 **143 文件 1226 项**全过；内核自检 **3675 项 0 失败**。
- 硬禁区（`loop.cjs` / `task.cjs` / `session*.cjs` / `changeset*.cjs`）`git diff --stat` 为空。
- 提交：`fb3b589`（8 文件，+123/−5）。

### 风险与回滚

- 风险：老配置 `maxTokens` 非零的人，上下文变小（可能更早触发裁剪）——
  用户自己的配置是 `0`，无影响；要恢复旧行为也能一眼改回。
- 回滚 = 把 `loop-prompt.cjs` 那两行指回 `config.assistant.maxTokens`（一处），
  `baseTokens` 留着不读即可（无害）。
- 顺带压回去的行数：`config-defaults.cjs` / `config-normalize.cjs` / `safety.ts` /
  `useThreadStore.ts` / `loop-prompt.cjs` 都贴着 300 行，本轮加的注释按「一行说清 +
  详情放本文档」写，最终 904 个文件全 ≤ 300 行。

---

## 第四步：B3 附件路径（只调研）

> 问题原话：「附件在 `<工作目录>/.harbor/attachments/`，同一会话切到不同工作目录时
> 旧附件可能读不到」—— 这是不是真问题？

### 事实（逐条对代码核实过）

1. **附件是什么**：超过 `THRESHOLD = 8000` 字符的粘贴，内存在**工作目录**里落一份
   完整原文：`<工作目录>/.harbor/attachments/<会话名>-paste-<内容 sha1 前 8>.txt`
   （`core/long-paste.cjs`）。发给模型的是「开头 4000 字符 + 一行指路」，
   气泡与会话文件里**永远是完整原文**。
2. **幂等键 = 会话 + 内容哈希**，所以「同一条消息在后续每一轮都会再走一次这里」时只复用不重写。
   但落盘用的是**当前这一轮解析出来的工作目录**（`handlers/chat.cjs` 里的 `resolveWorkdir`）。
3. **落文件只作用于「本轮最后一条 user 消息」**（`lastUserAt`）。不过下一轮模型仍知道路径 ——
   因为界面把这件事写成了一行 **system 消息**（`thread/attachmentEvents.ts`）并**持久化**
   （「长消息（N 字符）已存为 <绝对路径>…」）。（这条我先疑心是缺口，查完不是。）
4. **越界读取不是静默失败**：`capability.check()` 对「工作目录之外」的路径返回
   `needGrant: true`，而默认 `tools.permission: 'ask'` → **弹窗问用户**，用户点了就能读。

### 结论：是真问题，但很小；两条修法都踩停止条件 → 不修，记录

| 场景 | 实际会发生什么 |
| --- | --- |
| 换目录后**再发**长消息 | 在**新目录**重新落一份（哈希幂等键按新目录算），指路行给的是新路径 → 正常 |
| 换目录后模型去读**旧**附件 | 旧路径在当前工作目录之外 → **弹一次授权**（用户点同意可读）；策略被设成 block 时才真读不到 |
| 会话文件/气泡 | 完整原文一直在，**不丢内容** |

修法都不划算：

1. **存绝对路径** —— 现状已经是绝对路径，不解决范围问题；
2. **存相对路径** —— 换目录后相对的是新目录，**更糟**；
3. **附件跟会话走（`data/attachments/`）** —— 必须给模型「工作目录之外」的读权限，
   = **改文件范围权限（停止条件）**，且破坏「整目录拷走即迁移」；
4. **换目录时迁移 `.harbor/attachments/`** —— 要动会话/工作目录的落点逻辑（硬禁区附近）。

### 对「整目录拷走即迁移」的影响

附件在**工作目录里**、不跟会话走：拷会话不会带上附件。但这**不破**可移植性 ——
会话里存的是完整原文，附件只是「给模型读全文用的可再生副本」，
用户再发一次同样的内容就会在新目录重写一份。**所以附件不跟会话走是可接受的。**


