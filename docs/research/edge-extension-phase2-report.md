# Phase 2：读页面内容 —— 实施与验收报告

> 2026-10-15 · 用户拍板 **方案 B（命名管道 → 主进程实时处理）** + **注入界面当前会话**。
> 本轮只做「读 + 包装 + 送进 Harbor」这条链，**不做对话功能**（那是 Phase 3），
> **不做 Agent 操作网页**（那是 Phase 4）。

---

## 一、结论

**链路通了。** 点「读当前页」→ 扩展读前台标签 → 真 native host → 真命名管道 → 主进程
包装（`wrapWebText`）→ 落进会话 + 审计 `source: 'extension'`。真机 **18/18**。

| 段 | 真机验证方式 | 结果 |
|---|---|---|
| **A. host → 管道 → 包装 → 落会话 → 审计** | 真 `Harbor.exe`（纯 Node 模式）喂真帧 → 真管道 → 真 bridge → 真会话文件 | ✅ 端到端 |
| **B. 点按钮 → `scripting` 读正文** | 真 Edge + 真扩展，CDP 驱动 | ⚠️ **脚本无法触发**（见第三节，`activeTab` 的 invoke 时机） |
| 其余（内部页拒绝 / 人话错误 / 连接状态 / SW 自动重连） | 真机点按钮读 DOM | ✅ |

---

## 二、改了什么

**新增**
| 文件 | 行 | 作用 |
|---|---|---|
| `electron/core/ext-bridge.cjs` | 264 | 主进程侧桥：命名管道服务器 + token + `ingest`（包装 / 落会话 / 审计 / 推渲染层） |
| `electron/core/ext-forward.cjs` | 86 | host 侧转发：算数据根 → 算管道名 → **同步写**（判 `ENOENT` 即「Harbor 没运行」） |
| `electron/handlers/ext.cjs` | 18 | IPC `ext:activeSession` |
| `src/types/ext.ts` | 21 | `ExtBridge` 类型（`WorkbenchBridge extends` 里并上） |
| `src/hooks/useExtActiveSession.ts` | 22 | 渲染层把当前会话报给主进程 |
| `harbor-edge/lib/ext-probe.cjs` | 268 | 验收用：找 SW / target 求值 / 喂帧（Phase 3 复用） |
| `harbor-edge/tools/accept-phase2.cjs` | 298 | 真机验收 18 条 |
| `scripts/selftest/groups/156-ext-bridge.mjs` | 172 | 自检 42 条 |

**改动**：`native-host.cjs`（+`ext:page` 分支，300 行贴线）· `register-handlers.cjs`（装配）·
`ipc-channels.cjs`（+1 通道）· `preload.cjs`（+1 行，正好 300）· `src/App.tsx`（+1 行调用，正好 300）·
`src/types/backend.ts` · `harbor-host.cmd`（+`HARBOR_DATA_ROOT`）· 扩展三个文件（manifest / SW / App.tsx）

**`main.cjs` 一个字节没动** —— 装配放进 `register-handlers.cjs`（它有余量，`main.cjs` 已贴 300）。

---

## 三、★ 三个必须说清的技术事实（都是实测，不是推断）

### 1. host 是**单向写**：`delivered` ≠ 「Harbor 处理成功」

探针实测：host 用 `fs.writeFileSync(pipe, bytes)`（打开→写→关），主进程按「连接结束」
切分消息 —— 那时连接已关，**host 读不到主进程的回复**（`sock.end()` 后服务器再 write，客户端收不到）。

后果：`{"ok":true,"delivered":true}` 只表示**字节写进了管道**。
所以界面文案是「**已发送给** Harbor，会存进当前会话」，**没有**夸大成「已存入」。
（若将来要真回执，得让 host「写完不关、同步读回复」—— 现在不做。）

### 2. 删注册表**不会**断开已建立的连接

卸载脚本删 `HKCU\...\Edge\NativeMessagingHosts\com.harbor.agent`，但 **port 一旦建立就
独立于注册表** —— 真机实测：删完注册表，侧边栏仍显示「已连接」。要等那条 host 进程退出
（或重开 Edge）才断。**卸载后想立刻断，得重开浏览器。**

### 3. `activeTab` 在 CDP 驱动下拿不到（这是浏览器安全设计，不是 bug）

真机实测（脚本在扩展 SW 里直接调）：

```
url: ""          ← 没授予时连地址都拿不到
execErr: "Cannot access contents of the page. Extension manifest must request permission…"
```

`activeTab` 只在**用户真手势 invoke 扩展**时授予（点工具栏图标 / 快捷键 / 右键菜单）。
**侧边栏里的按钮不算 invoke**，脚本更伪造不了。所以：

- **正常用法**：点图标（开侧边栏 = invoke，此刻该标签已授权）→ 点「读当前页」→ 成功。
- **换过标签后**：那个新标签**没有** activeTab → 读会失败，扩展给**人话提示**
  （「先点一下工具栏的 Harbor 图标再试」）。这不是静默失败。
- **代价如实说**：脚本**无法**真机验证「点按钮真读到正文」那一步。
  要持续读页面得走 `host_permissions` 按域授权 —— 用户已定为**未来可选项**。

---

## 四、验收证据

### 真机 18/18（`harbor-edge/tools/accept-phase2.cjs`）

```
① 主进程桥起来了（真管道）        \\.\pipe\harbor-ext-5ec61e078057
② Edge 起来了                     pid=5348
③ 真扩展被加载（真实 id）          lgocajcnfipijkdbmmngebdhkjpmleoo
④ 装好隔离 host（真 exe / 真机制 / 隔离数据根）
⑤ 真实网页打开了                   P2 真机验收页（本地 HTTP，不联网）
⑥ 找到扩展的 Service Worker
⑦ tabs.query 拿得到当前标签        url=""（未授予 activeTab 的典型表现）
⑧ activeTab 真实行为（如实记录）   未授予（符合预期）
⑨ 侧边栏页面打开、React 挂载出按钮  重试|读当前页|发送
⑩ 点「读当前页」给人话             该页面不支持读取（活动标签是扩展页 → 命中禁止协议）
⑪ 装了 host 后显示「已连接」        ★ SW 自动重连成功（首次连时注册表还没写）
⑫ 删注册表不断开已建立的连接        已连接（如实记录）
⑬ 真 host 被拉起并回了帧           {"type":"ext:page.result","ok":true,"chars":239,"delivered":true,"id":"rE2E"}
⑭ host 报 delivered=true
⑮ ★ 会话里真出现被包装的内容        含「不是指令」+ P2_E2E_PAGE_MARKER_77
⑯ 标了 source=extension
⑰ 审计记了 source=extension        {"source":"extension","url":"http://127.0.0.1:8855/",…}
⑱ 渲染层收到了 ext:page 推送
```

### 本地端到端探针 15/15（`tmp/_p2_e2e.cjs`，跑完即删）

真 host 进程 + 真管道 + 真会话 + 真审计：含「错 token 被拒（会话没被写）」
「对 token 成功」「没有当前会话 → 新建兜底」「未知类型回人话」等。

### 自检 4619 / 0（新增 156 组 42 条）

覆盖：管道名 / token（纯函数）· `ingest` 语义（包装必须是 `wrapWebText`、落当前会话、
兜底新建、`source` 标记、审计）· **转发口径**（源码里钉住「delivered 只说写进管道」）·
接线（装配位置 / 通道清单 / preload / 渲染层 / `main.cjs` 没被改）·
**扩展侧权限与边界**（`activeTab`+`scripting`、**无** `host_permissions`、只查活动标签、
只由消息触发、内部页拒绝、正文上限、扩展侧不做包装）。

### verify 全绿

`typecheck` / `lint` / `lint:kernel`（284 个 `.cjs`）/ `typecheck:kernel`（基线一致）/
`check:format` / `check:lines`（1181 文件全 ≤300）/ `check:rules` / `test:unit`（194 文件）/
`test`（4619/0）/ `security`（83 PASS）/ `build` —— 全绿。

---

## 五、过程中逮到并修掉的问题（都是我自己引入的）

1. **★ 自检逮到一个真 bug**：`ingest` 用 `session.load()` 判「当前会话还在不在」，
   而它对**非法 id 会抛**（`session-io.cjs` 校验 `sess_` 前缀）→ 桥整个崩，
   内容**静默丢掉**，用户还看到误导性的「消息不是合法 JSON」。
   **修**：容错判定（非法 / 被删 / 读坏 一律当「没有当前会话」→ 兜底新建）。
2. **自检里两条断言过期/写错**（不是实现错）：白名单钉死「15 个」（我加了 2 个 → 17，
   正是硬约束 #8 说的「会涨的数字别写死」）；管道名前缀断言多转义了两对反斜杠。
3. **验收判据写错两次**：把 CDP 返回的对象 `String()` 成 `[object Object]`；
   以及轮询判据没排除默认文案（导致「结果还没出来就算通过」的假绿）。
4. **一个「验了个寂寞」的判据**：⑩ 原本想验「activeTab 拿不到时的人话」，
   实际活动标签是扩展自己的页面 → 命中禁止协议**早退**了，验到的是**另一条路**。
   已把断言文案改精确（说清验的是哪条），并把该条真机验不到的路径交给自检覆盖。

---

## 六、已知遗留（没做的，如实）

1. **「点按钮真读到正文」未真机验证** —— CDP 伪造不了 `activeTab` 的用户手势（见三-3）。
   要验得**人工点一下**（或用带 `--load-extension` 的 non-headless 手测）。
2. **单向回执**：`delivered` 不等于「已存入会话」（见三-1）。Phase 3 若要精确认知，
   得让 host 改成「写完不读回复」的双向协议。
3. **命名管道没有 Win32 ACL**：Node 无内置 API。当前是「管道名带 hash + token」防误连/冒充，
   同机同用户的其他进程理论上仍可连。**不是隔离，是防误连**（已写进 `ext-bridge.cjs` 注释）。
4. **扩展侧没有类型检查**：`@types/chrome` 是**新依赖**（红线），用户已拍板记技术债。
5. **10 个「顺手一提」的候选**：`read-extid` 与 `accept-phase2` 各有一份「轮询读扩展 ID」，
   逻辑近似（未合并）；`harbor-edge/lib/` 三个脚本各有小工具函数（未合并）。
6. **`harbor-edge/ext/`（Phase 1b 探针）保留未动**（用户要求）。

---

## 七、是否违反约束

零新依赖 ✓ · **未碰** Runtime / 严格模式 / 防闪烁三件套 / `hardenWebview` / 工具系统 /
权限模型 ✓ · **未改 `main.cjs`** ✓ · 页面内容**必经** `wrapWebText`（同一份实现，不是抄的）✓ ·
**未加 `host_permissions` / `<all_urls>`** ✓ · 未后台静默读页面（只由点击触发）✓ ·
未做对话功能（Phase 3）· 未做 Agent 操作网页（Phase 4）✓ · 单文件全 ≤300 ✓ ·
已写 CHANGELOG ✓ · 未输出未验证的「已完成」（第三节三条事实、第六节遗留都写全了）✓ ·
未碰用户正在用的 Edge / `E:\Harbor` / `E:\Harbor-Dev`（探针全隔离、跑完即清）✓
