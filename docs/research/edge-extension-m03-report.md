# M03 网页感知补完 · 交付报告

> 2026-10-16。按《Harbor Agent Browser Extension》模块体系推进；**只做「看」，不做「动」**。
> M04 是下一步 —— 按用户要求，M03 验收通过前不碰。

---

## 1. 改了什么

| 文件 | 行数 | 做了什么 |
|---|---|---|
| `harbor-edge/extension/lib/observe.js` | **新** 298 | **采集器**（注入页面执行）：选区 / 元素列表 / iframe 能力检测 / shadow 计数 / **FNV-1a 页面指纹** / `WeakRef` 登记 refs |
| `harbor-edge/extension/lib/observe-run.js` | **新** 74 | 执行「观察页面」那一步（注入 → 送主进程 → 落快照） |
| `harbor-edge/extension/lib/active-tab.js` | **新** 66 | ★ 从 SW 抽出的「拿前台标签 + 判受限页」—— 读正文与观察页面**共用一处** |
| `harbor-edge/src/sidepanel/ObserveButton.tsx` | **新** 77 | 侧边栏「观察页面」按钮（与「读当前页」平行） |
| `electron/core/ext-observe.cjs` | **新** 121 | 观察结果 → markdown（纯函数：预算 / 不捏造 / 敏感字段再兜一道） |
| `electron/core/ext-protocol.cjs` | 296 | 加 `KIND.PAGE_OBSERVE` |
| `electron/core/ext-ops.cjs` | 239 | 落会话逻辑抽成共用 `ingest()`；加 `observePage` 分派 |
| `electron/core/ext-host-loop.cjs` | 205 | host 转发 `observe-page` |
| `harbor-edge/extension/service-worker.js` | 278 | 改用共享 `resolveActiveTab`；加 `observe-page` 入口（`observePage` 从新文件 import） |
| `harbor-edge/src/sidepanel/ChatPanel.tsx` | 298 | 输入框左端放第二个按钮 |
| `harbor-edge/lib/ext-probe-panel.cjs` | 152 | 锚点归属表加「观察页面」；新增 `CLICK_OBSERVE_EXPR` |
| `scripts/selftest/groups/159-observe.mjs` | **新** 154 | M03 自检组（41 条） |
| `scripts/selftest/groups/156-ext-bridge.mjs` | — | 那两条判据跟着**真相源**走（见 §4.1） |
| `harbor-edge/tools/accept-m03.cjs` | **新** 341 | 真机验收（31 条） |
| `docs/research/edge-extension-roadmap.md` | **新** 116 | ★ 模块路线图与进度（M01–M12 的唯一真相源） |
| `docs/research/edge-extension-m03-design.md` | **新** 259 | M03 设计说明 + 实测结果 |
| CHANGELOG / harbor-edge README | — | 记账 |

**`electron/main.cjs` 与 `electron/ipc-channels.cjs`：0 行改动**（走既有通道，零新增 IPC）。

---

## 2. 为什么这么改（设计决策）

1. **版本号是这一层的核心，不是附加项**。元素引用写成 `<版本号>.<n>` —— 引用**自带版本**，
   M04 拿旧引用**比对前缀**就能判失效，不必再问页面一次。少了它，M04 的「旧引用误点」无解。
2. **指纹用 FNV-1a 而不是 `crypto.subtle`**：后者是**异步**的，而 ref 要**同步**生成。
   而且指纹必须**同时**满足两个相反的要求 —— 同页面**必须相同**（否则永远假失效）、
   改了就**必须变**（否则旧引用误命中）。这两条真机各有一条判据钉着。
3. **敏感字段「不给」而不是「脱敏」**：`value: null`，连长度都不给（长度也是信息）。
   这是 M07 的要求，但**必须在 M03 就做到** —— 采集是唯一能拿到值的时刻，错过就晚了。
4. **复用 `ext:page` 那条落盘链**（包装 / 审计 / 推送三件事抽成共用 `ingest()`）：
   规格 §7 要求「不建立第二套真相来源」，而 `wrapWebText` 是**安全职责**（网页上的文字
   同样是不可信数据）。观察结果的元素标签、选区文本都来自网页 —— 必须同样过包装。
5. **抽取 `active-tab.js`**：读正文与观察页面都要「拿前台标签 + 判受限页」。两份各写一遍
   必定漂（硬约束 #9）；而且那两句人话是 `accept-phase2` 的断言对象，抽出来才守得住。

---

## 3. 怎么验证的（真机 31/31）

**脚本**：`node harbor-edge/tools/accept-m03.cjs` → **31/31**。

分三段，每段验**不同的真东西**：

| 段 | 验什么 | 怎么做的 |
|---|---|---|
| A | **采集器在真 DOM 上跑** | 本地 http server（**两个端口** = 同源 + 跨域 iframe）；真 Edge 打开测试页；CDP 在那页上**真执行 `collectPageContext`** |
| B | 侧边栏按钮接线 | 真扩展 + 侧边栏，**真点**「观察页面」，状态行出**结果态**人话 |
| C | 完整链路落盘 | 真源码树 Harbor + 真 host（喂**扩展形状**的帧）→ 验会话文件里是渲染后的 markdown |

**最关键的两条实测**：

```
⑤ ★ 同一页面反复观察 → 版本号相同    60684574 vs 60684574
⑤ ★★ 改动 DOM 后再观察 → 版本号变了  60684574 → c4d13c51
④ ★★ 密码框的 value 一个字都没带出来  整个返回值里不含 secret123
```

**回归（串行跑，零回归）**：`accept-phase2` **18/18** · `3a` **16/16** · `3b` **15/15** · `3c` **20/20**。

**其他门**：自检 **4785/0**（+41）· 单测 1765 · 内核三层与基线一致 · 1189 文件全 ≤300 · 构建成功 ·
`npm run verify` 全绿。

---

## 4. 过程中发现的两个真问题

### 4.1 ★ 采集器必须自包含（这一阶段最该记住的一条）

`chrome.scripting.executeScript({ func })` 会把函数 **`toString()` 序列化**后注入页面 ——
所以函数体内**只能引用自己的参数、局部变量和嵌套函数**。

引用任何**模块级**常量 / 导入 → 注入后 `ReferenceError`。**而单测抓不到**：Node 里
`require` 这个模块时一切都在。**只有真机会现形。**

处理：采集器写成一个自包含函数；规矩写在文件头；自检组 159 加一条断言**扫 top-level
常量名有没有泄漏进函数体**（这条断言是**静态可查**的，能提前挡住）。

> ⚠️ **对 M04 同样成立** —— 点击 / 填写也要注入，同样踩。

### 4.2 验收脚本喂帧的形状

host 的 dispatcher 分派键是 `obj.type`（它面向**扩展发来的消息**），不是协议帧的 `kind`。
第一版我喂 `{v,id,kind,payload}` → host 回「只认 …」的兜底（`echo` 里能一眼看到原始帧）。
喂 `{type:'observe-page', observation}` 才对。已写进脚本注释。

> **另一类失败也记一笔**：A、B 段跑得太快，主进程还没起来就喂帧 → 空回复。加了 ⓪ 判据
> 等 CDP 端口通才往下走（**不许拿固定毫秒等待当判据** —— README 那条硬规则）。

### 4.3 ⚠️ 一个**已发现、未修**的验收资产缺陷（报告，不擅自改）

**现象**：我串行跑完四条回归后，`com.harbor.agent` 注册表被留在了
`data/unit-test-data/p3c-manifest.json`（**隔离值**），而我手工装的原来那条被覆盖了。
我立刻改回了原值（`与期望一致 = true`）。

**根因**：`accept-phase3c.cjs` 的 finally 里，恢复段包在 `try { … } catch { /* 忽略 */ }` 里，
而 `console.log('清理：注册表已恢复…')` 是**无条件打印**的 —— **出错了也显示「已恢复」**。
这正是我被误导的原因（脚本说恢复了，我看到的是隔离值）。

**对照**：`accept-phase3b.cjs` 会打印实际恢复到的值（有验证），`accept-phase3a.cjs` 也有；
**只有 3c 既没验证、又无条件打印**。（`accept-phase2.cjs` 与本轮的 `accept-m03.cjs` 都
**不碰注册表** —— 它们用 `runHost` 直起 exe，不走 Edge 的 native messaging。）

**建议修法（3 行，但我没动 —— 按项目规矩「发现前一轮做错了要先说，不偷偷改」）**：
恢复后 `reg QUERY` 一次，把**实际值**打出来并与期望比对；不一致就报红。

**影响面**：只影响**验收脚本**（用户手工装的 host 条目可能在跑验收后被覆盖）——
产品代码无关。`harbor-edge/README.md` 已写明「跑完会恢复原值」，但那条**现在不完全可信**。

---

## 5. 已知遗留（4 条，都不是遗漏）

| # | 遗留 | 归属 |
|---|---|---|
| 1 | 阅读模式正文提取（标题层级 / 表格 / 图片 alt）—— 现在仍只有 `innerText` | 未排期 |
| 2 | SPA 的 DOM 更新观察 / 页面稳定判断 | **M04 的 `wait` 一起做** |
| 3 | iframe 内部**不递归采集**（只报告能不能读） | 需要时再加 |
| 4 | shadow 扫描有 3000 元素上限（超了 open 计数是**下界**，已如实标注） | 可接受 |

---

## 6. 是否违反约束

| 约束 | 结果 |
|---|---|
| 零新依赖 | ✅ 没有新增任何依赖 |
| 不碰 Runtime / 严格模式 / 防闪烁 / `hardenWebview` / 工具系统 / 权限模型 | ✅ 一行未碰 |
| 单文件 ≤300 | ✅ 产品源码全过（`accept-m03.cjs` 341 行在 `tools/`，`line-limit.mjs` 不覆盖） |
| 复用 `ext-protocol` 的 KIND 机制 | ✅ 只加一个 `page:observe` |
| 敏感操作走现有权限门禁 | N/A（M03 只有「看」，没有敏感操作）；**敏感字段已遮蔽** |
| 网页内容送模型前过 `wrapWebText` | ✅ 观察结果同样过（真机判据钉着） |
| 不做跨页编排 / 录制回放 | ✅ 只做观察 |
| 每层跑 verify | ✅ 每层跑内核检查；收尾跑完整 verify |

---

## 7. 下一步

**M04 受控操作**（`browser.click` / `type` / `verify` / `wait` …）—— **等你验收 M03 后再开工**。
开工前先读：本文档 §4.1（注入自包含）+ `docs/research/edge-extension-roadmap.md` §3。
