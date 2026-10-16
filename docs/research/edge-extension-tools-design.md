# Edge 能力接成 Harbor 工具 + M04/M05 补动作（设计）

> 本轮要解决的第一件事：**M04/M05 做的 9 个能力，Agent 在对话里调不到**
> （`registry.cjs` 的工具表里没有任何 edge 系工具，`extCommand` 在 `core/tools/**`
> 与 `loop.cjs` 里零引用）。本轮把它接上，并补规格点名但还没做的动作。

## §1 两套浏览器必须分开（命名）

| 族 | 操作对象 | 现状 |
|---|---|---|
| `browse*` | Harbor **内嵌** webview（`<webview>`，渲染层的 DOM） | 已有 6 个（browse / elements / click / type / nav / ax） |
| `edge*` | **用户自己的 Edge**（真扩展 + native host + 下行指令） | **本轮新增** |

⚠️ 绝不能改 `browse*` 的语义去兼容 Edge —— 那会静默破坏现有工具。
判据：`edge*` 的工具描述里必须写明「用户正在用的 Edge 浏览器」。

## §2 工具族清单（8 个，按「一个工具一件事」切）

照 `browse*` 的先例**分开**（不合并成 `edge_act {action}`）—— 合并要 `oneOf`，
模型填错率明显更高，而分开只是多几行 schema。

| 工具 | 底层 | 读/写 | 说明 |
|---|---|---|---|
| `edge_page` | `navigate` + `getElements` | 写（改地址） | 在用户 Edge 打开地址并**读回元素清单**（带引用） |
| `edge_click` | `click` | **写** | 点元素（**敏感按钮走确认卡**） |
| `edge_type` | `type`（`text:''` = 清空） | **写** | 往输入框填文本 / 清空 |
| `edge_select` | `select` | **写** | 下拉框选值 |
| `edge_scroll` | `scroll` | **写** | 滚动 |
| `edge_wait` | `wait`（`timeoutMs:0` = 立刻检查 = verify） | 读 | 等条件满足（元素/文本/URL） |
| `edge_key` | `key`（新） | **写** | 键盘事件（Enter / Tab / Escape…），可先聚焦某元素 |
| `edge_focus` | `focus`（新） | 写 | 聚焦元素（键盘操作前用） |
| `edge_tabs` | `tabsList` / `search` / `activate` / `create` / `close`（新） | 写 | 标签页：列 / 搜 / 切 / 新建 / 关 |

> `verify` 不单列工具：`edge_wait {timeoutMs:0}` 就是「立刻验一次」——
> 语义重复的工具只会让模型犹豫（挑哪个都一样）。

## §3 风险档（用户 2026-10-16 拍板：「只在敏感动作确认」）

- **不进 `WRITE_TOOLS`** → 「需要确认」档**不弹**风险框（读写都不弹）
- **写类进 `MUTATING_TOOLS`** → 「只分析，不修改」那一轮**拦下**
  （这一条是用户没明说但必须守的：不守的话「先别动」会被理解成「可以操作浏览器」）
- `network: true`（联网 + 占用用户浏览器）

写类 = click / type / select / scroll / key / focus / tabs；读类 = page / wait。

## §4 接线方式（照 `browse*` 的现成做法）

工具 `run()` 里 `require('../../handlers/ext.cjs')` 拿**单例** ——
`browse.cjs` 就是这么拿内嵌浏览器的（`require('../../handlers/browser.cjs')`）。

所以 `handlers/ext.cjs` 要从「只有 IPC」扩成「也持有 extCommand」：

```js
let command = null
function setCommand(c) { command = c }     // register-handlers 装配时注入
function getCommand() { return command }
```

`register-handlers.cjs` 创建 `extCommand` 后调一次 `setCommand`。

## §5 ★ 工具看到与会话落盘**同一份文本**（硬约束 #9）

现在 `landAction` 只回 `{sessionId, chars, truncated}`，工具拿不到渲染好的 markdown，
只能**再写一份**格式化 → 两份必然漂。

改法（一处）：`ext-ops.ingestAction` 多返回一个 `markdown`，`landAction` 透传。
工具返回给模型的就是**同一份 markdown** —— 「操作结果 → 文本」仍然只有一处实现。

## §6 补的三个动作（M04）与两个（M05）

### 6.1 `clear` —— **不加扩展函数，复用 `type`**

清空输入框 = 设空值。`ext-actions.clear` 直接调 `call('type', {ref, text:''})`，
省一个注入函数（少一处能漂的实现）。

### 6.2 `focus` / `key` —— 新注入函数（自包含）

放新文件 `harbor-edge/extension/lib/act-edit.js`（`act-form.js` 已 264 行贴线）：
- `focusElement(ref, opts)` —— 校验版本 → `el.focus()` → 证据 `focused`
- `pressKey(ref, key, opts)` —— 先聚焦（ref 给的话）→ 派发 `keydown`/`keypress`/`keyup`

★ 二者**同样受自包含铁律约束**（M03 §8.1）：辅助函数嵌套在函数体内。

### 6.3 `tabs.create` / `tabs.close`（M05）

- create：`chrome.tabs.create({url, active})` → 回读确认（标题/地址）
- close：**只允许关「list 里出现过的 id」**（与 `activate` 同一道闸，防编 id 关用户标签）；
  关完回读确认（那个 id 不在列表里了）

## §7 验收

| 层 | 怎么验 |
|---|---|
| 自检 | 新组 163：工具 schema / 风险档归属 / 接线单例 / 三个新动作的形状 / tabs 两道闸 |
| 真机 | `accept-m04e`：真 Edge 上跑 clear / focus / key + tabs 新建 / 关闭 |
| **工具链路** | `accept-m04f`：**真调 `tools.execute('edge_page'/'edge_click'/...)`**（不是直调 extCommand）—— 这是「能被调用」的判据 |
| 回归 | phase2 / 3a / 3b / 3c / m03 / m04a / m04b / m04c / m04d 逐条单独跑 |

## §8 本批不做（如实记，留下批）

M02 侧边栏 UI 面 · M03 阅读模式/周边上下文/SPA 稳定 · M06 幂等 · M07 站点级权限 ·
M08–M12 五个模块。
