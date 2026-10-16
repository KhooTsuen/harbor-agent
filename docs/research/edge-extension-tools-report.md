# 报告：Edge 能力接成 Harbor 工具 + M04/M05 补齐（2026-10-16）

> 这一批解决的是**最要紧的一件事**：前几批做的能力**用户在对话里调不到**。

## 1. 改了什么

### 新增：`edge_*` 工具族（9 个，`electron/core/tools/`）

| 文件 | 工具 | 干什么 |
|---|---|---|
| `edge-page.cjs` | `edge_page` | 在用户的 Edge 打开地址（不传就只读当前页）+ 读回元素引用 |
| `edge-click.cjs` | `edge_click` | 点元素（**提交/删除类先弹确认卡**） |
| `edge-type.cjs` | `edge_type` | 填文本；**不填 text = 清空**；密码/信用卡字段**拒绝** |
| `edge-select.cjs` | `edge_select` | 下拉框选值；找不到列全部可选值 |
| `edge-scroll.cjs` | `edge_scroll` | 滚到顶/底、按像素、或滚到某元素 |
| `edge-wait.cjs` | `edge_wait` | 等条件（`timeoutMs:0` = 立刻验一次，**故不另做 verify 工具**） |
| `edge-key.cjs` | `edge_key` | 真实按键（Enter / Tab / Escape） |
| `edge-focus.cjs` | `edge_focus` | 聚焦元素（输入法 / 失焦校验场景） |
| `edge-tabs.cjs` | `edge_tabs` | 标签页 list / search / activate / **create** / **close** |
| `edge-shared.cjs` | —— | 共用：取单例、结果 → 文本（**复用落盘链的 markdown**） |

### 改动

| 文件 | 改了什么 |
|---|---|
| `handlers/ext.cjs` | 从「只有 IPC」扩成**也持有 `extCommand`**（`setCommand` / `getCommand` 单例） |
| `register-handlers.cjs` | 装配时调 `extHandler.setCommand(extCommand)` |
| `tools/registry.cjs` | 注册 9 个工具；写类进 `MUTATING_TOOLS`、**不进** `WRITE_TOOLS` |
| `tools/index.cjs` | 只读档判据改 `isWrite \|\| MUTATING_TOOLS.has(name)`；联网门覆盖 `edge_*` |
| `tool-map.cjs` | 新族分组 + 9 条 hint；`MAX_DETAILED` 24 → **32** |
| `ext-command.cjs` | 转发 clear/focus/key + tabsCreate/tabsClose；**`landAction` 透传 `markdown`** |
| `ext-actions.cjs` | 加 clear/focus/key；渲染拆到 `ext-act-render.cjs` 并**再导出** |
| `ext-act-render.cjs` | **新**：页面动作结果 → markdown（纯渲染，唯一一处） |
| `ext-tabs.cjs` | 加 `create` / `close` + 对应渲染 |
| `ext-observe.cjs` | 渲染按 kind 转发新动作；**`navigating` 与 `no-result` 归为同族** |
| `ext-ops.cjs` | `ingestAction` 多返回 `markdown` |
| `extension/lib/act-edit.js` | **新**：`focusElement` / `pressKey`（自包含） |
| `extension/lib/act-run.js` | 分发 clear / focus / key |
| `extension/lib/tabs-run.js` | 加 `createTab` / `closeTab`（两道闸 + 回读确认） |
| `extension/lib/command-run.js` | 分发 tabs-create/close；导航型点击补 `urlAfter` 硬证据 |

## 2. 为什么这么改（设计决策）

1. **单例而不是自己 new**：工具不在装配链上，若各自 `createCommand()`，回执按 id 配对就配不上
   （回执只回真桥那条链）。照 `browse.cjs` 拿内嵌浏览器的现成做法。
2. **写类进 `MUTATING_TOOLS` 但不进 `WRITE_TOOLS`**：这是「只在敏感动作确认」的**精确落地** ——
   风险档不弹框（用户拍板），但「只分析，不修改」那一轮必须拦住。
3. **文本只有一处来源**：工具返回的就是落盘链渲染好的 markdown。工具自己再格式化一遍 =
   两份必然漂（硬约束 #9）。因此 `ingestAction` → `landAction` → 工具是一条直线。
4. **不新增语义重复的工具**：`edge_wait{timeoutMs:0}` 就是 verify；`edge_type` 不填 text 就是 clear。
   工具一多，模型「挑哪个」的成本就上来了。
5. **`navigating` 必须与 `no-result` 同族**：它们都是「点了但证据没回来」。漏了会渲染成
   「执行失败」→ 模型重试 → **点两次**（破坏性）。

## 3. 怎么验证的

| 层 | 结果 |
|---|---|
| 自检 | **4998/0**（新组 163 · 43 条：工具存在 / 风险档 / 接线单例 / 补齐动作 / tabs 两道闸 / 门覆盖） |
| 单测 | 1765 通过 |
| **真机（关键）** | **`accept-m04f` 32/32** —— 全部**从 `tools.execute(name, args, ctx)` 进去**，这是「能被调用」的唯一算数判据 |
| 回归 | 十条**逐条单独跑**全绿：phase2 19/19 · 3a 17/17 · 3b 15/15 · 3c 20/20 · m03 32/32 · m04a 16/16 · m04b 34/34 · m04c 8/8 · m04d 34/34 · m04f 32/32 |
| `verify` | 全绿 |

**m04f 实测到的关键数字/证据**（不是「我觉得」）：

- `edge_page` 从 `tools.execute` 调通 → 页面版本 `34c5f457`，抠到 6 个元素引用
- `edge_type`：`""` → `"张三"`（页面里真变了）
- **密码框**：工具返回「**拒绝执行**（密码字段）」，页面值 `"secret123"` → `"secret123"`（**一个字没变**）
- **信用卡字段**：同样拒绝，卡号 `""`（没进页面）
- **提交按钮**：问了 1 次卡 → 拒绝 → url 没变（`http://127.0.0.1:8861/`）；**允许 → 真提交到 `/submitted`**
- 只读按钮（`type=button`）：`asked=0`、直接点到（`#out` 变「已看详情」）
- `edge_tabs` create → 新 id `540133954` → 出现在 list → close → 回读不在列表里；编造 id `999999999` → 拒绝
- **风险框次数 = 0**（用户拍板「只在敏感动作确认」）；**只分析轮** `edge_click` 被拦、`edge_page` 在读档被拦、`edge_wait` 仍能用

## 4. 已知遗留

1. **M02 侧边栏 UI 面**：任务卡 / 当前网页卡 / 设置区 / 上下文开关 / 停止生成 / Markdown 渲染 / 右键菜单与快捷键
2. **M03**：阅读模式正文提取（标题层级 / 表格 / 图片 alt）· 指定元素周边上下文 · SPA 稳定判断
3. **M04**：用户接管 / 暂停 / 安全重试（now 只有超时 + 确认卡）
4. **M05**：对指定标签页导航 · 多窗口 · 标签分组 · 批量
5. **M06**：幂等 / 去重（「重复命令不会无意重复提交表单」）
6. **M07**：站点级读取/交互权限、临时授权与撤销
7. **M08–M12**：五个模块整体未开工
8. 验收仍靠副本临时加 `host_permissions`（产品 manifest 刻意不加，M07）

## 5. 是否违反约束

| 约束 | 结论 |
|---|---|
| 类型零容忍 | ✓ 内核 75 个 .cjs 与基线一致；`typecheck` 通过 |
| 单文件 ≤300 | ✓ 1210 个文件全过（拆了 `ext-act-render.cjs`，压了 5 个文件的注释） |
| 数据只落 data/ | ✓ 验收写 `data/unit-test-data/` |
| 密钥不落 config | ✓ 未碰 |
| 改数据结构要迁移 | ✓ 未改数据结构（新增字段是**内部形状**，不进用户数据） |
| 不引入新原生依赖 | ✓ 零新依赖 |
| 不输出未验证的已完成 | ✓ 每条都指得住命令或真机观察 |
| 不写死会涨的数字 | ✓ 报告里的数字都标了「本轮实跑」 |
| 跨模块约定一处真相源 | ✓ 渲染只有一份（`ext-act-render` + `ext-tabs`）；文本只有一处来源 |
| 改了代码写 CHANGELOG | ✓ |
