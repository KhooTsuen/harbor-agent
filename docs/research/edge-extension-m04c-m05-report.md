# M04 剩余 + M05 交付报告（2026-10-16）

> 验收脚本：`harbor-edge/tools/accept-m04d.cjs`（34 条判据，真机）
> 设计：`docs/research/edge-extension-m04c-m05-design.md`

## 1. 改了什么

**新增 10 个文件**（原有 9 个文件贴着 300 红线，不拆装不下）：

| 文件 | 装什么 |
|---|---|
| `electron/core/ext-kinds.cjs` | `KIND` / `ERR` 两张表（从 ext-protocol 移出，后者**再导出**） |
| `electron/core/ext-ref.cjs` | `inspectRef`（ref 三条判定，纯函数） |
| `electron/core/ext-actions.cjs` | type/select/scroll/wait/navigate 的主进程侧 + 它们的结果渲染 |
| `electron/core/ext-tabs.cjs` | tabs 三件 + 渲染 |
| `electron/core/ext-gate.cjs` | **敏感操作判定**（唯一一处，纯函数） |
| `electron/handlers/ext-confirm.cjs` | 确认卡接线（复用 `chat-confirm.askUser`） |
| `harbor-edge/extension/lib/act-form.js` | 注入函数 `typeText` / `selectOption` |
| `harbor-edge/extension/lib/act-nav.js` | 注入函数 `scrollPage` |
| `harbor-edge/extension/lib/act-run.js` | 5 个页面动作的扩展侧执行 + wait 轮询 |
| `harbor-edge/extension/lib/tabs-run.js` | tabs 三件的扩展侧实现 |

**改**：`ext-protocol`（改为再导出）· `ext-command`（转调 + 敏感闸）· `ext-observe`（渲染按 kind 转发）·
`ext-ops`（无需改，落盘复用既有 `ingestAction`）· `register-handlers`（注入 confirm）·
`observe.js`（**指纹按结构算** —— 见 §4）· `service-worker.js`/`command-run.js`（分派）·
`groups.mjs` + 新增自检组 162 · `161-act.mjs`（断言跟真相源走）。

## 2. 为什么这么改（设计决策）

1. **协议层零新增 kind**：M04-2 把下行做成「通用指令」（`payload.command` 区分），这批 8 个能力
   全是这条通道上的不同 command。收益是实打实的 —— 否则要加 8 个 kind + 8 个分派分支。
2. **敏感字段「拒绝」而不是「遮蔽」**：遮蔽意味着值已经进过页面/进过回传；密码与卡号连
   「写进去」这一步都不该发生。判定放在**页面里**（`typeText` 自己判），因为它需要知道
   真实的 `type` / `autocomplete`，而那正是页面才有的事实。
3. **敏感操作判定单独一处**（`ext-gate.judge`）：界面拦了但内核没拦、或者反过来，
   是必然漂的一条路径。所以判定是纯函数，自检能直接喂假元素跑。
4. **确认卡不另造**：走 `chat-confirm.askUser`（写操作确认用的就是它）。确认需要 `emit`，
   而 emit 只有 `handlers/` 有 → 由装配处**注入** `confirm`，内核仍不 require handlers
   （自检能单独跑 `ext-command`，喂一个假 confirm 就行）。
5. **fail-closed**：没注入 confirm 时，敏感点击**直接拒绝**并说明原因 —— 不能因为装配漏了
   就把这道闸绕过去。
6. **`wait` 复用 `verifyPage`**：条件语义若另写一份，迟早与 verify 漂。代价是每 300ms 一次
   IPC，换来「只一处实现」。
7. **`tabs.activate` 的 id 必须在 list 里**：不这么做，网页/模型可以编一个 id 去激活
   **我们看不见的标签** —— 等于绕过「只看得到这几个」的边界。

## 3. 怎么验证的（数字 + 真机）

| 验收 | 结果 |
|---|---|
| `accept-m04d.cjs`（新，34 条） | **34/34** |
| 九条真机脚本**逐条单独跑** | phase2 **19/19** · 3a **17/17** · 3b **15/15** · 3c **20/20** · m03 **32/32** · m04a **16/16** · m04b **34/34** · m04c **8/8** · m04d **34/34** |
| 自检 / 单测 | **4932 / 0**（新增 162 组 44 条）· 1765 / 1765 |
| `npm run verify` | **全绿** |
| Node 里真跑接线探针 | 18/18（假桥 + 假 confirm 真跑 `click` 三种分支 + 8 个动作转调） |

**★ 实测证据（报告要的那几项）**：

- **`type` 拒密码框**：`sensitive-field`，且页面里的值 `"secret123" → "secret123"`（**一个字没变**）。
  信用卡字段 `autocomplete="cc-number"` 同样被拒（`field=cc-*`）。
- **提交按钮弹确认卡**：`asked=1`（真的问了）· 卡里 4 条影响（页面 / 元素 / 会提交 POST 表单 /
  可能不可撤销）· **拒绝后 url 仍是 `http://127.0.0.1:8841/`**（没提交）· **允许后**标题 →「已提交」。
- **普通按钮（显式 `type=button`）不问**：`asked=0`。
- **tabs**：`list` 4 条 · `search('/p3')` 命中 1 条 · `activate` 回读确认「想要 484790231 · 实际前台 484790231」·
  编造 id → `NO_TAB`。
- **无明文落盘**：会话文本里搜不到 `hunter2` / `secret123` / `4111111111111111`。

## 4. ★ 过程中逮到并修掉三个**原有**缺陷（不是本批功能）

1. **页面版本号会被「自己填表」打变**（真机决定性证据：`refVersion: 8a733502 → pageVersion: 66cc88d4`）。
   指纹里用了 `labelOf(el)`，而它对没有 placeholder 的元素会**回退到 `el.value`** —— `<select>`
   正是这种。于是「填名字 / 选下拉框」之后，**提交按钮的 ref 立刻失效**，模型得反复重新观察。
   修法：指纹按**结构**算（`labelOf(el, true)` 跳过 value）—— 防误点依赖的本来就该是结构。
2. **只读按钮被当成提交**（`ext-gate.isSubmitLike`）：HTML 里 `<button>` 不写 type 时
   `el.type` 读出来就是 `submit`，所以「凡 button 皆算提交」会把 POST 表单里的「看详情」
   也拦下来（真机 ⑪ 逮到）。修法：用**显式否定的那一边**（作者写了 `type="button"`/`reset` → 排除）。
3. **`accept-m04c` 只有串行才红**：CDP 附着会激活 target，前一条的标签把测试页挤到后台
   →「读不到当前页地址」。加了显式 `/json/activate`。

## 5. 是否是「敏感操作扎实」（用户特别要求）

不是「点一下过」：

- 判定**两个来源**（危险词表 + POST 表单上下文），并**安全词优先**（「取消」「返回」不拦）；
- **显式排除** `type=button`（否则满屏确认卡 = 噪声不是保护）—— 这条是真机逮到的；
- 卡里写**为什么**（不写空话）：页面 / 元素 / 具体后果；
- **三种结局都明确**：允许 → 真点；拒绝 → 不发指令 + `pageUntouched`；超时 → 同拒绝；
- 拒绝也**落盘**（让人看到「为什么这次没点下去」）；
- 自检 9 条断言钉判定 + 3 条钉接线（含 fail-closed）。

## 6. 违反约束？

| 约束 | 状态 |
|---|---|
| 单文件 ≤300 | ✓ 1199 文件全 ≤300（拆了 10 个文件） |
| 协议层复用 KIND 机制 | ✓ 零新增 kind（走既有 PAGE_COMMAND） |
| 注入函数自包含 | ✓ 自检有静态断言；真机验证通过 |
| 网页内容走 wrapWebText | ✓ 落盘那条链没变，判据 ⑲ 钉着 |
| `main.cjs` / `ipc-channels.cjs` | ✓ **0 行改动** |
| 敏感确认复用既有机制 | ✓ `chat-confirm.askUser`，未另造 |
| CHANGELOG | ✓ |
| 每层 verify | ✓（拆文件/adapter 层各跑过） |

## 7. 遗留（如实）

1. `type` 是一次性 set value（不是逐字敲键盘）—— 够用且稳（React 受控组件已验证）。
2. iframe 内部不能操作（`frames` 只报告可读性）。
3. `tabs` 权限没要 → 非 activeTab 标签的 url/title 拿不到，**如实标 `urlHidden`**（要全量得做权限扩张）。
4. `browser.screenshot` / `extract`（M09 / M10）· 跨页编排（用户定的边界外）。
5. **串行**跑全部真机脚本时，个别脚本会因前台/Edge 退出竞争而红（单独跑全绿）；
   建议仍**逐条单独跑**（README 已写）。
