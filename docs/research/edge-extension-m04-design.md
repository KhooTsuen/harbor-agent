# M04 设计说明：受控浏览器操作（第 1 步 getElements + 下行通道）

> **状态**：第 1 步（getElements + 下行指令通道）**已完成并真机验收 16/16**（2026-10-16）；
> 第 2 步（click + verify）起待做。
> **范围**：只做**单步操作**。不做跨页编排、不做录制回放（用户定）。
> **前置**：`edge-extension-m03-design.md`（§8.1 注入函数自包含）、`edge-extension-roadmap.md` §3。

---

## 0. 地基：本轮开工前探针实测的两条事实（`tmp/_m04probe.cjs`，跑完即删）

M03 的真机 A 段是 **CDP 在页面里内联执行**采集器（走 **main world**），
**不是** `chrome.scripting.executeScript`（默认走 **ISOLATED world**）。所以 M04
要依赖的两条前提，M03 **从没验过**。先钉死：

| # | 问题 | 实测 | 含义 |
|---|---|---|---|
| ① | CDP 驱动下，真 SW 的 `executeScript` 能注入测试页吗 | **不能**：`Cannot access contents of the page. Extension manifest must request permission to access the respective host.` | manifest **没有** `host_permissions`，只能靠 `activeTab`；而 **CDP 驱动下 activeTab 不授予**（accept-phase2 ⑧ 早记过） |
| ② | 两次 `executeScript` 是否共享 world | **共享**：第 1 次设 `window.__probeX = 7`，第 2 次读到 **`7`** | ★ **M04 的地基成立** —— `window.__harborObs`（M03 登记的 `ref → WeakRef(el)`）能被后续 click/type 读到 |

### 0.1 由此定下的验收口径（重要，别含糊）

- **产品路径**：用户点扩展图标 → `activeTab` 授予 → `executeScript` 可访问当前标签。**这是正常的**。
- **验收路径**：CDP 驱动没有 activeTab → 必须给**验收副本**的 manifest 临时加
  `host_permissions: ["http://127.0.0.1/*"]`（只加在 `stage` 出来的副本里，**不改产品 manifest**）。
- **这不算作弊，但必须说清**：验收验的是「注入的**逻辑**对不对」，不是「activeTab 授不授予」
  （后者 phase2 ⑧ 已单独验过、且是浏览器行为不是我们的代码）。**报告里要写明这一条。**

---

## 1. 三条硬要求怎么落实

### 1.1 操作成功 ≠ 业务目标完成

每次操作**必须返回状态证据**，形状固定为：

```
evidence: {
  pageVersionBefore, pageVersionAfter,   // 版本号（M03 的算法，唯一真相源）
  urlBefore, urlAfter,                   // URL 变没变
  changed: 'url' | 'dom' | 'none',       // 归因
  expect: { ok: boolean, kind, detail },  // 调用方给的期望判据满没满足
}
```

`click` 的返回**不只是 `clicked: true`** —— 它会重新观察一次，把上面四项填上。
`expect` 由调用方给（如 `{kind:'urlChanged'}` / `{kind:'textAppears', text:'成功'}`）。

### 1.2 元素引用带页面版本号

- ref 形态（M03 已定）：`<pageVersion>.<序号>`，如 `60684574.3`。
- 解析规则（**纯数据比较，不注新逻辑**）：
  | 情形 | 判定 | 返回 |
  |---|---|---|
  | ref 版本 ≠ 当前版本 | **引用失效** | `stale: true` + `reason: 'page-changed'`，附当前版本与「必须重新观察」的人话 |
  | 版本相同、ref 在本次列表里 | 有效 | `stale: false` + 该元素当前状态 |
  | 版本相同、ref 不在列表里 | 元素没了 / 不再可交互 | `stale: true` + `reason: 'not-found'` |

  ★ **为什么用「重新采一次再比字符串」而不是 deref**：deref 只能证明「元素还在内存」，
  **证明不了「页面没变」** —— 而防误点靠的正是后者。同一版算法算出的版本号才是权威。

### 1.3 敏感操作逐次确认

- 判定在**主进程**（`electron/core/ext-command.cjs`）：动作词（提交/发送/购买/删除/发布/支付…）
  命中 → **必须先过确认卡**。
- 复用 Harbor 现有门禁：`electron/handlers/chat-confirm.cjs` 的 **`askUser`**
  （它内部走 `confirmBridge` → 渲染层 `PermissionBar` 那一套）。**不另造。**
- 这一条**放在最后一步做**（用户定的顺序）—— 它依赖 click/type 都通了。

---

## 2. ★ 新增：下行指令通道（M04 与 M03 的根本差别）

**M03 是「扩展 → 主进程」**（用户点按钮，扩展采集，送给主进程）。
**M04 要「主进程 → 扩展」**（模型决定点哪个，主进程得让浏览器去点）。

现协议只有前者。但**下行的物理通道已经存在**，只是没被当指令用：

```
主进程 ext-bridge.push(kind, payload)
  → 写给所有活着的 host 连接（socks）
  → host 的 setPushHandler 把帧 fs.writeSync(1, …) 转给扩展
  → 扩展 native.js 收到 msg.push === true
       ⚠️ 现在只 broadcast 给侧边栏 —— M04 起**同时交给 SW 的指令处理器**
  → SW 执行（executeScript）
  → 用**现有** request 通道回一帧 {type:'page:result', id:<原指令 id>, …}
  → 主进程 ext-ops 分派 page:result → 配对 pending，resolve
```

要点：

- **零新增 IPC 通道**（`main.cjs` / `ipc-channels.cjs` 仍不动），也**不新增帧类型**
  （复用 `push`；「推送 vs 应答」的判据仍是「有没有 id」）。
- 指令有**超时**（默认 15s）：浏览器没开 / 扩展没连 → 人话错误码，不干等。
- 回执**按 id 配对**（`ext-command.cjs` 里的 pending Map），并发安全。

---

## 3. 七个能力的形状（第 1 步只做 getElements）

| 工具 | kind（主进程→扩展的指令） | 参数 | 返回要点 |
|---|---|---|---|
| **`browser.getElements`** | `page:get-elements` | `{ ref?, maxItems? }` | `elements[]`（或单个 `element`）+ `pageVersion` + `stale` |
| `browser.click` | `page:click` | `{ ref, expect? }` | `clicked` + **evidence**（1.1） |
| `browser.type` | `page:type` | `{ ref, text, mode? }` | `typed` + evidence；敏感字段**拒绝** |
| `browser.select` | `page:select` | `{ ref, option }` | `selected` + evidence |
| `browser.scroll` | `page:scroll` | `{ dir, amount? }` | `scrolled` + 新视口 |
| `browser.wait` | `page:wait` | `{ condition, timeoutMs }` | `met` + 用时 |
| `browser.verify` | `page:verify` | `{ expect }` | `ok` + 证据 |

**注入函数一律自包含**（§8.1 那条约束对 M04 同样致命）：点击/填写的函数体里
**只能引用自己的参数、局部变量、嵌套函数**。自检要有一条静态断言扫这件事。

**复用而非重写**：`page:get-elements` 的采集**直接复用 M03 的 `collectPageContext`**
（同一个注入函数、同一套版本号算法、同一套 ref 登记）—— 扩展侧只裁掉
`selection` / `frames` / `shadow`，因为它只要元素。**不新写第二个采集器**（那必然漂）。

---

## 4. 第 1 步（getElements）的落地清单

| 层 | 文件 | 做什么 |
|---|---|---|
| 协议 | `electron/core/ext-protocol.cjs` | 加 `PAGE_COMMAND:`page:command`` / `PAGE_RESULT:'page:result'`；错误码 `NO_BROWSER`（没连）/`STALE_REF` |
| 主进程 | `electron/core/ext-command.cjs`（**新**） | 下行指令 + pending 配对 + 超时；`getElements(payload)`；ref 解析（1.2 的三条判定） |
| 主进程 | `electron/core/ext-ops.cjs` | 分派 `page:result` → 交给 command |
| 主进程 | `electron/core/ext-bridge.cjs` | 装配 `command`（push 已有；`start` 时注入） |
| 扩展 | `harbor-edge/extension/lib/native.js` | 收到 push 时，`page:command` 类**同时**交给 SW 的处理器 |
| 扩展 | `harbor-edge/extension/service-worker.js` | 注册指令处理器 → 调 `elements-run.js` |
| 扩展 | `harbor-edge/extension/lib/elements-run.js`（**新**） | 注入 `collectPageContext` → 裁视图 → 回 `page:result` |
| 自检 | `scripts/selftest/groups/160-ext-command.mjs`（**新**） | 指令配对 / 超时 / ref 三条判定 / 注入函数自包含 |
| 真机 | `harbor-edge/tools/accept-m04a.cjs`（**新**） | 副本加 `host_permissions`（§0.1）→ 真注入 → 版本稳定/失效 → 回执配对 |

**不做**（本轮）：给模型注册工具（`core/tools/browser-*.cjs`）—— 那是让 Agent 真能用的一步，
放在后续轮次（用户定的「逐轮推进」）。

---

## 5. 遗留与风险（如实列）

1. **验收靠副本加 `host_permissions`**（§0.1）—— 产品 manifest 不加，理由已写明。
2. **`window.__harborObs` 只留最近一次观察** —— 两次观察之间页面变了，旧 ref 会失效，
   这正是设计要的；但**同一轮里 observe 两次**会让前一次的 ref 全废（调用方要么重观察、
   要么用最新一次）。已知取舍。
3. **跨域 iframe 内的元素点不了**（M03 只报告能不能读）—— M04 同样不递归。
4. closed shadow root 里的元素拿不到（浏览器不暴露）。
