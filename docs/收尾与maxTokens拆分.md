# 收尾 + 拆 maxTokens

> 本文件是这五步任务的进度台账。每完成一步就更新这里。
> 报告格式见文末（一句话总结 / 逐步 / 最终验证 / 我替你做的决定 / 没做完的 / 明天建议先看什么）。

## 任务

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 第一步 | #8 browse 提示（B 方案：toast 去重 + 标签角标 + 系统通知） | 代码完成，待真机验收 |
| 第二步 | #7 的 error 分支缺口（`status === 'error'` 时整条时间线不渲染） | 未开始 |
| 第三步 | 拆 maxTokens（一物二用 → 先出方案） | 未开始 |
| 第四步 | B3 附件路径（**只调研**，等拍板） | 未开始 |
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
  （单测 141 文件 1207 项；内核 220 个 `.cjs` 无未定义标识符）
- 新增测试：`src/lib/__tests__/browseNotice.test.ts`（9 项）、
  `useBrowserStore.test.ts` 加 4 项角标测试
- 真机验收（三条）：见下方「真机」一节
