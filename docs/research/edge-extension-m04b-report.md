# M04 第 2 步 · 交付报告（click + verify + 验收资产修复）

> 2026-10-16。用户批准 `32f9d69`（M04-1 getElements）后，分两步走：**先修 `accept-m03.cjs`
> 的 serve 缺陷**，再做 **M04 第 2 步 click + verify**。本轮只做 click / verify ——
> `type` / `select` / `scroll` / `wait` / `navigate` 与**敏感操作确认**按用户定的顺序**没做**。
>
> ★ 本轮真正的技术风险不在 click 本身（它是一段 DOM 操作），而在**「点了」与「生效」之间
> 那条缝**：浏览器怎么把「一下点击产生了什么后果」变成**可读的证据**交给模型。

---

## 1. 改了什么

| 文件 | 动作 | 说明 |
|---|---|---|
| `harbor-edge/tools/accept-m03.cjs` | 改 | `serve()` 端口冲突**明确报错 + 早退**（新增判据 ⓪b）；A 段固定等待改轮询 |
| `harbor-edge/tools/accept-m04a.cjs` | 改 | 注册表走共享快照；④ 从**硬编码 `true`**（永远绿的假判据）改成真查 target 列表 |
| `harbor-edge/tools/accept-m04b.cjs` | 改 | 注册表走共享快照（**新增脚本**本身在上一轮） |
| `harbor-edge/tools/accept-phase2.cjs` | 改 | 注册表：**只删不恢复 → 快照 + 恢复 + 回读比对**（它还会故意删一次验判据 ⑰） |
| `harbor-edge/tools/accept-phase3a/3b/3c.cjs` | 改 | 统一走共享快照 + 回读比对；删掉无条件的「已恢复」 |
| `harbor-edge/lib/ext-stage.cjs` | 改 | 新增 `snapshotRegistry` / `restoreRegistry` / `parseRegValue`（**外部备份**） |
| `harbor-edge/extension/lib/act.js` | **新增** | 注入函数 `clickElement` / `verifyPage`（★ 必须**自包含**） |
| `harbor-edge/extension/lib/command-run.js` | **新增** | SW 侧：收下行指令 → 注入执行 → 回执；**导航型点击的判定** |
| `harbor-edge/extension/lib/native.js` | 改 | `setCommandHandler`（**指令不广播给侧边栏**）；`ensureConnected` 主动连 |
| `harbor-edge/extension/service-worker.js` | 改 | 注册指令处理器 |
| `electron/core/ext-command.cjs` | **新增**（M04-1 建，本轮扩） | `getElements` / `click` / `verify` + `inspectRef` + `handleResult` |
| `electron/core/ext-observe.cjs` | 改 | `renderAction`（前后对比表 + 「点了≠生效」）+ `finish` 共用收尾 |
| `electron/core/ext-bridge.cjs` / `ext-ops.cjs` | 改 | `landAction` / `ingestAction`（操作结果落盘，复用 `ingest` 那条链） |
| `electron/core/ext-client.cjs` / `ext-host-loop.cjs` | 改 | **host 启动即主动连**（原来懒连 → 主进程推不出指令）；`page-result` 转发 |
| `electron/core/ext-protocol.cjs` | 改 | `PAGE_COMMAND` / `PAGE_RESULT` / `PAGE_ELEMENTS` + `NO_BROWSER` / `STALE_REF` |
| `scripts/selftest/groups/161-act.mjs` | **新增** | 自检组 161（注入自包含 / 判定 / 渲染 / 下行通道 / 接线） |
| `CHANGELOG.md` / `harbor-edge/README.md` / `docs/research/edge-extension-roadmap.md` / `docs/research/edge-extension-m04-design.md` | 改 | 记账 |

**`main.cjs` / `ipc-channels.cjs` 0 行改动**（零新增 IPC 通道）。产品源码单文件 **≤300**（压注释达到，代码行本来就没超）。

---

## 2. 为什么这么改（设计决策）

1. **状态证据用「可读的前后值」，不用哈希。** 哈希只能证明「变了」，说不出**怎么变** ——
   而模型要判断的是「这一下点出了我要的效果吗」。所以证据是 URL / 标题 / 节点数 /
   正文字数的前后对比 + 目标元素是否还在，渲染成一张并排表。
2. **失效校验放在主进程、且放在「发指令之前」。** 点了才说「哦这引用过期了」是没用的 ——
   错的东西可能已经被点出去了。所以 `click` 先 `getElements('')` 拿当前版本号，对不上就
   **根本不发指令**（`STALE_REF` + 人话）。
3. **重采一次比字符串** 而不是 `deref` 元素还在不在 —— deref 只证明元素还在内存，
   **证明不了页面没变**，而防误点靠的正是后者。（M04-1 定的，本轮沿用。）
4. **注入函数必须自包含**（M03 §8.1 的铁律对 click 同样成立）：`executeScript` 会把函数
   `toString()` 注入页面，引用任何模块级东西 → `ReferenceError`，而**单测抓不到**。
5. **操作结果复用 `ingest` 那条落盘链**（会话 / 审计 / 推渲染层），网页文字仍过
   `wrapWebText` —— 点完的页面文字同样是不可信数据。
6. **「结果拿不回来」必须如实说清**：导航时注入代码被销毁 → promise 永不 resolve。
   不能含糊报错（模型会重试 → 点两次），也不能假装成功。

---

## 3. 怎么验证的

### 真机验收（串行跑，注册表每次恢复后回读一致）

| 脚本 | 结果 |
|---|---|
| `accept-m04b.cjs`（**本轮核心**） | **33/33** |
| `accept-m03.cjs` | **32/32**（原 31 + 新 ⓪b） |
| `accept-phase2.cjs` | **19/19**（18 + 新「注册表恢复到真原值」） |
| `accept-phase3a.cjs` | **17/17**（16 + 新判据） |
| `accept-phase3b.cjs` | **15/15** |
| `accept-phase3c.cjs` | **20/20** |
| `accept-m04a.cjs` | **16/16** |

### 关键实测值（`accept-m04b` 打的）

| 判据 | 实测 |
|---|---|
| ★★ 真点到页面上 | 节点 `10 → 11` · 字数 `19 → 24` · `#out` 从「初始」变「已点击」 |
| ★ 证据带「怎么变」 | `{"domChanged":true,"nodesBefore":10,"nodesAfter":11,"targetStillThere":true}` |
| ★ 旧引用 → 拒绝 | `STALE_REF`「页面已经变了（你手上的引用是旧版本的）—— 请重新观察页面再点」 |
| ★ 拒绝时**页面没被改动** | 仍在 `.../next`（证明**没发指令**） |
| ★ verify 四类 | 文本含 / 文本不含 / 选择器出现 / 选择器消失 / URL 含 —— 各自命中与不命中都对 |
| ★★ 导航型点击 | 返回「**点击发出去了，但状态证据没采到**……**不代表没点上**，用 `browser.verify` 确认，**不要直接重试**」；随后 verify 确认到新页面 |
| 落盘 | 会话里是**前后对比表**，且过防注入包装 |

### 静态 / 全链

- 自检 **4886 / 0**（新增 `161-act` 组）
- 单测 **83 文件全过**
- `npm run verify` **exit=0 全绿**（内核与基线一致 · 1192 文件全 ≤300 · 构建成功）

---

## 4. 过程中发现并修的真问题（都不是计划里的）

| # | 问题 | 性质 |
|---|---|---|
| 1 | **`ext-client` 懒连接** → 扩展没发过请求时，主进程**根本推不出下行指令**（`NO_BROWSER`）。3b 的推送能工作只是巧合 | **产品缺口**（真机暴露） |
| 2 | **导航型点击：注入 promise 永不 resolve** → 整条链白等主进程 15 秒才超时 | **产品行为**（真机暴露） |
| 3 | **`accept-phase2` 只删不恢复注册表**，而它还会故意删一次验判据 ⑰ → 跑一次抹掉用户手工装的值 | 验收资产（**我上一轮还说过它「不碰注册表」，说错了**） |
| 4 | **注册表「原值」现读 = 会被上一轮隔离值污染** → 恢复成隔离值还回读一致、打印「✓ 一致」 | 验收资产（假绿根源） |
| 5 | **`accept-m04a` 的 ④ 判据硬编码 `true`** → 永远绿的假判据 | 验收资产（假绿） |
| 6 | **`accept-m03` 的 `serve()` 端口冲突静默继续** → 拿一个「不是测试页」的页面跑完判据 | 验收资产（假红/假绿） |

### 我自己犯的错（如实记）

- **把 `regSnap` 写在 `try` 里面** → `finally` 里 `const` 取不到 → `ReferenceError` →
  恢复那步抛异常 → **注册表被删**。已修（挪到 `try` 外）+ 自检式核对（六个脚本的
  `regSnap` 缩进都查过）。

---

## 5. 已知遗留（都不是遗漏）

| # | 遗留 | 归属 |
|---|---|---|
| 1 | `type` / `select` / `scroll` / `wait` / `navigate` 未做 | 用户定的顺序，下一步 |
| 2 | **敏感操作确认未做**（提交 / 发送 / 购买 / 删除 / 发布）—— 复用 Harbor 的确认卡 | 用户定的：它依赖 click 先通过 |
| 3 | 验收仍靠**副本**临时加 `host_permissions`（产品 manifest 不加，M07「不默认要全站权限」） | 已记设计文档 §0.1，**不算作弊但不含糊** |
| 4 | `browser.*` 还没注册成 Harbor 工具（真实调用方式待定；本轮由验收脚本直接驱动下行通道） | 下一步（要动工具注册，属硬禁区） |
| 5 | `accept-phase2` / `m04a` **单独跑**才稳（串行时前一个残留抢前台） | 已写进 README |

---

## 6. 是否违反约束

| 约束 | 状态 |
|---|---|
| 单文件 ≤300 行 | ✓（四个超线文件**压注释**达标 —— 代码行本来就没超） |
| 复用 `ext-protocol.cjs` 的 KIND 机制 | ✓（新 kind 加在那一处） |
| 网页内容走 `wrapWebText` | ✓（真机判据钉着） |
| 走既有 `chat:event` channel，`main.cjs` 零改动 | ✓ |
| 每完成一层跑一次 verify | ✓（本轮多次） |
| 只做 click + verify，不做 type/select/scroll/wait/navigate | ✓ |
| 敏感操作确认暂不做 | ✓（未做） |
| 注入函数自包含 | ✓（自检组 161 静态断言 + 真机） |
| 零新依赖 | ✓ |
| 不碰 Runtime / 严格模式 / 防闪烁 / hardenWebview / 工具系统 / 权限模型 | ✓ |
