# M04 剩余 + M05 设计（type / select / scroll / wait / navigate / 敏感确认 / tabs）

> 本文是**这一批的唯一形状真相源**。实施与验收都照它。
> 前置：`edge-extension-m03-design.md`（观察）、`edge-extension-m04-design.md`（getElements/click/verify）。

---

## 0. 为什么这批必须先拆文件

现状（2026-10-16 实测行数）：

| 文件 | 行数 | 这批要往里加什么 |
|---|---|---|
| `electron/core/ext-protocol.cjs` | **299** | +8 个 KIND |
| `electron/core/ext-ops.cjs` | **296** | +tabs 分派 |
| `electron/core/ext-observe.cjs` | **295** | +4 种渲染 |
| `electron/core/ext-command.cjs` | **293** | +5 个动作 |
| `electron/core/ext-bridge.cjs` | **296** | 不动 |
| `harbor-edge/extension/lib/act.js` | **294** | +5 个注入函数 |
| `harbor-edge/extension/lib/observe.js` | **299** | 不动 |
| `harbor-edge/extension/service-worker.js` | **300** | 不动（零余量） |
| `harbor-edge/extension/lib/command-run.js` | 196 | +8 个分支（有 ~100 行余量） |

**拆法（按职责，每块自成一体、可被自检单独跑）**：

| 新文件 | 装什么 | 从哪抽 |
|---|---|---|
| `electron/core/ext-kinds.cjs` | `KIND` + `ERR` 两张表 | 从 `ext-protocol.cjs` 移出（那边净减 ~30 行） |
| `electron/core/ext-actions.cjs` | `type` / `select` / `scroll` / `wait` / `navigate` 的主进程侧 | 新写（`ext-command.cjs` 只加 5 行转调） |
| `electron/core/ext-tabs.cjs` | `tabs.list` / `tabs.activate` / `tabs.search` 的主进程侧 | 新写 |
| `electron/core/ext-gate.cjs` | **敏感操作判定**（纯函数：按钮特征 → 要不要确认） | 新写（唯一判定处） |
| `harbor-edge/extension/lib/act-form.js` | 注入函数 `typeText` / `selectOption` | 新写（自包含） |
| `harbor-edge/extension/lib/act-nav.js` | 注入函数 `scrollPage` / `waitFor` / `navigateTo` | 新写（自包含） |
| `harbor-edge/extension/lib/tabs-run.js` | tabs 三件的扩展侧实现 | 新写 |
| `electron/handlers/ext-confirm.cjs` | 把确认卡接给 M04（复用 `chat-confirm` 的 askUser） | 新写（这里才有 emit） |

**渲染**：`ext-observe.cjs` 不再长大 —— 新动作的结果渲染进 `ext-actions.cjs` / `ext-tabs.cjs`（各自带着自己的渲染，就近）。

---

## 1. 五个新动作的形状

所有动作与 `click` **同一套路**：① 注入**自包含**函数 ② 结果里带**可读证据** ③ 「操作发出去了」≠「达到目的」。

### 1.1 `browser.type(ref, text, { submit?, clear? })`

注入 `typeText(ref, opts)`：

- **先查敏感**（在**页面里**查，不靠主进程猜）：`input[type=password]`、`autocomplete` 以 `cc-` 开头
  → **拒绝**，返回 `{ ok:false, reason:'sensitive-field', field:'password'|'cc-*' }`，
  **文本一个字节都不写进页面**。
- 正常：`clear` 默认 true（先清空）；用**原生 setter** 写 value + 派发 `input`/`change`
  （React 受控组件不派发事件不会更新）。
- 证据：`valueBefore` / `valueAfter`（**敏感字段永不出现**）、`focused`。
- `submit: true` 时**不自己提交** —— 返回 `{ needsSubmit: true }`，由调用方决定（提交要过确认闸）。

### 1.2 `browser.select(ref, value | label | index)`

注入 `selectOption(ref, opts)`：按 value → label → index 依次尝试；回 `{ ok, selected: {value,label,index}, options: n }`。
找不到 → `{ ok:false, reason:'option-not-found', tried }`（不回空）。

### 1.3 `browser.scroll({ ref? | target, dy? | to })`

注入 `scrollPage(opts)`：给 ref 就滚到那个元素（`scrollIntoView`），给 `to:'bottom'|'top'` 就滚文档，
否则按 `dy` 滚。证据：`scrollBefore/After`（`window.scrollY`）+ `atBottom`。

### 1.4 `browser.wait({ expect, timeoutMs })`

`expect` 与 `verify` 同一形状（正文含 / 选择器出现 / URL 匹配…）。
**轮询**（默认 300ms 一跳）直到满足或超时。回 `{ ok, matched, waitedMs, checks }`。
超时**不算错**（`matched:false`），但要如实写「等了 N ms 没等到」。

### 1.5 `browser.navigate(url)`

先**问主进程的 `net-policy`**（不新写一套）；然后扩展侧 `chrome.tabs.update(tabId, {url})`。
回 `{ ok, urlBefore, urlAfter }` + 等 `onUpdated.status === 'complete'`（带上限 15s）。

---

## 2. 敏感操作确认（这一批的重点，不做「点一下过」）

### 2.1 判定在哪

**唯一一处**：`electron/core/ext-gate.cjs` 的 `needsConfirm(element, risk)`。纯函数，自检直接喂假元素。

判定来源有**两条**，任一命中就要确认：

1. **元素特征**（`ext-observe.cjs` 采到的那条元素记录）：
   - `tag === 'BUTTON'` 且 `type === 'submit'`
   - 或所在表单 `method === 'POST'`
2. **文本命中危险词表**：提交 / 发送 / 购买 / 支付 / 付款 / 下单 / 删除 / 移除 / 发布 / 上传 / 确认 / 注销 / 解绑 / 退订 / 同意并

→ 白名单**优先**：`role=button` 但文本明显是在做无关操作的（取消 / 关闭 / 返回 / 搜索 / 下一步）不拦。

### 2.2 谁来弹

**只有 `electron/handlers/` 有 emit**（`chat.cjs:143` 就是这么调的）。所以：
`ext-command.cjs` 的 `click` 多一个**注入的** `confirm` 依赖（与 `land` 同一路子）：

```js
createCommand({ getBridge, log, land, confirm })   // confirm: (info) => Promise<boolean>
```

装配处（`register-handlers.cjs`）注入 `handlers/ext-confirm.cjs` 的实现，它内部调
`chatConfirm.askUser(...)` —— **不另造一套**（用户明确要求）。

### 2.3 拒绝的后果（三种，都要说清）

| 情形 | 行为 |
|---|---|
| 用户点「允许」 | 真的点，返回正常证据 |
| 用户点「拒绝」 | **不点**，返回 `{ ok:false, reason:'denied-by-user' }` |
| 超时（5 分钟） | 按**拒绝**处理，`reason:'confirm-timeout'` |

**关键**：拒绝分支也要**回执**（不然扩展那侧白等 15 秒）—— 这一条会写进自检。

### 2.4 确认卡里写什么（不写空话）

`{ name: 'browser.click', summary: '点击「提交」', kind: 'browser-action',
   impact: ['页面：<标题>（<url>）', '元素：<文本>（<角色>）', '这是**外部提交类**操作，点下去可能不可撤销'] }`

---

## 3. M05：tabs 三件

| 能力 | 形状 | 边界 |
|---|---|---|
| `tabs.list` | `[{ id, title, url, active, index }]` | **只列 `http/https`**（浏览器内部页、扩展页一律不列 —— 与「不默认读所有标签页」同口径） |
| `tabs.activate(id)` | `{ ok, active: { id, title, url } }` | id 必须在 `list` 里出现过，否则拒（不让人从网页编 id） |
| `tabs.search(q)` | 按标题/URL 子串匹配（不区分大小写） | 回同 `tabs.list` 的形状 |

★ **不新增权限**：`tabs` 权限 + `url` 可见性靠 `activeTab`；拿不到 url 的标签**照样列**，但 `url` 写 `''`
并标 `urlHidden: true`（如实，不编）。

---

## 4. 验收口径（真机）

| 验收 | 判据 |
|---|---|
| `type` 正常 | 输入框 `value` 真的变了 + 证据里 `valueBefore/After` |
| **`type` 拒密码框** | `ok:false` + `reason:'sensitive-field'` + **页面里那个框的 value 仍是原样**（没被写） |
| `select` | `selected.index` 对得上 + 页面里 `select.value` 真的变了 |
| `scroll` | `scrollY` 由 0 → >0 |
| `wait` | 先 `matched:false`（还没到），滚动/改动后 `matched:true` |
| `navigate` | `urlAfter` 是目标地址 + 页面标题变了 |
| **提交按钮弹确认卡** | 卡真的推到了渲染层（`chat:event` 里有 confirm）+ 拒绝时**页面没被提交** |
| `tabs.list` | 真开 3 个标签 → 列出 3 条 |
| `tabs.activate` | 切过去后 `active` 那个的 id 变了（用 `tabs.list` 复查） |
| `tabs.search` | 按标题搜到那一条 |

---

## 5. 遗留（明确不做）

- 跨页编排 / 录制回放（用户定的边界）
- `browser.screenshot` / `browser.extract`（M09 / M10）
- `type` 的「逐字敲」（`dispatchKeyEvent` 序列）—— 现在是一次性 set value（够用且稳）
- iframe 内部操作（`frames` 只报告可读性）
