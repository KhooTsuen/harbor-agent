# credentials 写入保护 —— 设计修订与实施边界确认（**已按本稿实施**）

> **性质**：设计稿 + 边界确认。**本文不改任何核心代码**（唯一的例外：为取证跑了两个
> 只读探针，见 §3/§4，写完即清理）。
> **取代**：[`credentials写入保护-设计.md`](credentials写入保护-设计.md)（上一版）—— 本版把
> 「状态转换 / 提交一致性 / ENOENT 边界 / 独立 reset / 负向测试」五处补齐，并对「解密失败
> 是否会覆盖密文」给了一次**实测**结论。
> **基线**：`HEAD = b7bf014`（含 E2 第一项 task-io 修复），工作树干净，`v1.30.0-beta.17`。
> **日期**：2026-10-13。**证据规矩**同其它文档：每条指得住 `文件:行号` 或一次注入观察。

---

## 0. 一句话

`credentials.load()` 现在用**一个 catch 吞掉所有失败**（`credentials.cjs:60-77`），
把「文件不存在」「文件坏了」「读不了」**压成同一件事**（都退化成空 `entries`）。于是
下一次任意 `set()` 都会把空表 `persist()` 写回去 —— 用户 API Key 无声消失、无提示、无证据。

**要做的是「状态不明时拒绝写」，而不是「加个 `.corrupt` 副本」。** 留档只保住证据，不阻止覆盖。

> ⚠️ 本轮用户已定的边界（逐条遵守）：
> 仅增加 `.corrupt` 副本**不足以**证明安全；不新增锁框架；不新增 UI / IPC 恢复入口；
> 用独立 `reset()`，**不用** `set(force:true)`；只有 `writeAtomic` 成功后**才**更新内存缓存。

---

## 1. 实际调用链（本轮核实，逐个点名）

`credentials.cjs` 对外只有 8 个出口；**真正会写盘**的只有 `set()` 和 `remove()`（都经 `persist()`）。

| 调用方 | 调用 | 用途 | 现状风险 |
| --- | --- | --- | --- |
| `config-secrets.cjs:38/40` | `remove/set` | 保存供应商密钥 | **不检查返回**；`set` 静默覆盖坏库 |
| `config-secrets.cjs:49/65/66` | `remove/set` | 删供应商 / 搜索密钥 | 同上 |
| `config.cjs:32/46` | `set` | 老版本明文密钥**迁移**（`migrateLegacySecrets`）| 已包 try/catch，失败仅 `console.warn` |
| `config.cjs:258` | `remove` | 删供应商时清密钥 | 不检查返回 |
| `session-crypto.cjs:68` | `get` | 读会话加密密钥 | `get` 抛错 → 上层已有明确提示（对的）|
| `session-crypto.cjs:92` | `set` | 首次开启加密时**生成**密钥 | **不检查返回** |
| `config.cjs:122/276` | `primeRedaction` | 启动时把密钥登记进脱敏表 | 逐条 catch，单条坏不影响启动 |
| `handlers/safety.cjs:297` | `status` | IPC `credentials:status`（只报条数/后端）| 只读 |

**读方向**：`config.hasKey/get/providerKey/searchKey`（`config.cjs:183/189/195`）→ `has/get`。

**结论**：写路径全部集中在 `set/remove`；只要在这两个口把住「库不健康就不写」，
整条链就守住了。**不需要**新增 IPC —— `set` 失败靠**异常**向调用方传播（与本项目
`writeAtomic` / `task-io` 的先例一致）。

---

## 2. 状态模型与转换表

「健康态」是**进程内**的（不落盘、不改文件格式、不需要迁移）。今天**根本没有**这个状态 ——
`load()` 只有「成功 / 失败」两分，失败一律当空。修订后定义 5 态：

| 状态 | 怎么进入 | 能写？ | 读（get/list/status）|
| --- | --- | --- | --- |
| `ok` | 读到 + 解析成功 + 后端与当前环境一致 | ✅ | 正常 |
| `missing` | `ENOENT` 且**从未成功加载过**（首次启动）| ✅（等于全新）| 空 |
| `corrupt` | 读到但 `JSON.parse` 失败 | ❌ 拒写 | 空 + 明确错误 |
| `unreadable` | 读失败且**不是** ENOENT（EPERM/EACCES/EISDIR）；**或加载成功后文件消失/被外部改动** | ❌ 拒写 | 空 + 明确错误 |
| `undecryptable` | 文件能解析，但**解密不可行**：`backend='safeStorage'` 而当前环境 `encryptionAvailable()=false`；或 `get/primeRedaction` 里某条 `decrypt()` 抛错 | ❌ 拒写 | 逐条能读的读、读不了的抛/跳过 |

### 2.1 转换表（谁把谁变成谁）

```
                 ┌──────────── load() 首次读 ────────────┐
  ENOENT(没建过) ─→ missing
  读失败(非ENOENT)→ unreadable
  parse 失败      → corrupt
  parse 成功      → ok            ← 除非 backend=safeStorage 且本机无解密能力 → undecryptable

  运行期（已 ok）：
    get(ref) 解密抛错          → undecryptable（并继续抛，get 的对外行为不变）
    primeRedaction 某条抛错    → undecryptable（但**不抛**，保启动）
    写前 stat 发现文件消失/变了 → unreadable（见 §5）
    reset({confirm:true}) 成功 → ok（清空重建）

  拒写态（corrupt/unreadable/undecryptable）**只能**靠 reset() 离开 —— 普通 set 永不离开。
```

**关键区分**（用户点名的「首次 ENOENT vs 加载后消失」）：

- `missing` 专指「**从没读到过**」→ 正常（首启、用户还没填 Key）→ 允许建文件。
- 「曾经 `ok`、后来文件没了」→ **不是** `missing`，落到 `unreadable`（**拒写**），
  错误文案点明「凭证库在本次运行期间消失，已停止写入以免静默重建」。
- 两者都靠加载时记一个 `loadedOnce` 标记区分，**不引入锁**。

---

## 3. 关键核实①：解密失败 / 会不会覆盖原始密文（**实测**）

**问**：解密失败会不会改变全局健康态？有没有「解密失败后仍覆盖原始密文」的路径？

**代码结论**：`load()` 压根不解密（只有 `get`/`primeRedaction` 解）→ **解密失败不改 cache、
也没有任何全局健康态**（因为今天根本没这个态）。但 `set()` 里有一行是隐患：

```js
// credentials.cjs:137   —— 把整个文件的 backend 统一改成「当前后端」，但**不重新加密旧条目**
data.backend = packed.backend
```

**实测（只读探针，隔离目录 `data/unit-test-data`）**：

```
文件 backend=safeStorage；本进程（纯 Node）encryptionAvailable = false
get(provider:alpha) → 抛「凭证解密失败（当前环境没有系统加密能力）」

—— 做一次与 alpha 无关的 set(provider:gamma, 'NEW-SECRET') ——
set 返回: {"ok":true,"backend":"plain"}
写回后文件 backend: plain            ← 原来是 safeStorage
写回后 alpha 仍在: ['provider:alpha','provider:gamma']
alpha 的 value 原样: QkFTRTY0...（base64 密文，字节没丢）
backend 变 plain 后再读 alpha → "QkFTRTY0..."   ← ★ 密文被当明文返回
```

**结论（如实、分两半说）**：

- **字节层面没丢**：旧条目的 `value` 原样保留，没有把密文那串字节抹掉。
- **语义层面被破坏**：一次无关的 `set()` 会把文件 `backend` 从 `safeStorage` **重贴成 `plain`**，
  之后读旧条目会把 base64 密文**当明文 API Key 返回** —— 用户看到的是「我的 Key 变成一串乱码」，
  而且这串乱码**会被当 key 发出去**（`config.providerKey`）。这就是 `paths.cjs:86-90` 记的
  2026-10-07 真机事故的形状。
- 因此修订后 `undecryptable` 态**必须拒写**（含 `set`/`remove`）—— 这正是 §2 把
  `backend=safeStorage 且本机无解密能力` 列为 `undecryptable` 的理由。

> ⚠️ 明确：**`keepCorruptCopy` 管不了这一条**（文件是合法 JSON，不是损坏）。这条只能靠
> 「状态不对 → 拒写」堵。

---

## 4. 关键核实②：内存 ↔ 磁盘提交一致性（**实测**）

**现状**：`set()` 先改**内存缓存对象**、再 `persist()`（`credentials.cjs:132-139`）。
`load()` 返回的是同一个 `cache` 引用，`set` 直接在其上增删 → 一旦 `persist()` 抛错，
**内存已脏**。

**实测（同一只读探针）**：

```
set 是否抛出: true
内存里 has(provider:beta): true      ← 磁盘其实没写成功
磁盘文件是否存在: false
→ 「内存成功 / 磁盘失败」不一致： true
```

**修订设计（用户要求：只有 `writeAtomic` 成功后，才更新内存缓存）**：

```
commit(nextData):
  text = JSON.stringify(nextData, null, 2)
  ① 写前校验指纹（§5）
  ② writeAtomic(filePath(), text)      ← 失败即抛，**不动 cache**
  ③ cache = nextData; backend = nextData.backend   ← 只有到这里才替换内存

set/remove：
  nextData = { ...data, entries: { ...data.entries } }   ← 复制，不原地改
  改 nextData；commit(nextData)
```

→ 覆盖 `set` / `remove` / `reset`。任何写失败后，`has()/get()/list()` 读到的仍是**旧的内存**，
与磁盘一致；异常向调用方传播，**不假报成功**。

---

## 5. 缺失文件边界 & 外部修改（不新增锁）

- **首次 ENOENT vs 加载后消失**：见 §2.1 —— 靠 `loadedOnce` 标记区分，仅前者可写。
- **多进程 / 外部修改风险**：本应用是**单实例**（打包版），但 `data/` 可被用户手工改、
  被杀毒/同步盘动过。**不加锁**，用**极轻指纹检测**：
  - `load()` 成功时 `fs.statSync` 记下 `{ size, mtimeMs }`。
  - 每次 `commit()` **写前**重新 `stat`：文件消失、或 `size/mtimeMs` 变了 → 抛错、
    转 `unreadable`、**不写**（避免把「别人刚写的密钥」覆盖掉）。
  - 检测不到「同一毫秒内的等价改写」——**明确记为局限**，不追求强一致（不引锁框架）。
- 这样满足「不新增锁框架」，又能在最常见的「文件被外部动过」时停在安全侧。

---

## 6. 显式重置：独立 `reset()`（唯一出口）

**不用** `set(force:true)` 绕过保护 —— 破坏性动作单列一个函数，语义清楚、好审计。

```
reset({ confirm: true })
  1. confirm !== true        → 抛错（**没有未经确认即可调用的破坏性路径**）
  2. 若文件存在             → keepCorruptCopy(filePath())  先留档
  3. 留档**失败**           → 直接抛错、中止（保住证据优先）；health 不变、原文件不动
  4. writeAtomic 写空库     → 成功才 cache=空、health=ok
  5. 返回 { ok:true, archived: <路径|''>, reason }
```

- **调用权限**：只允许「用户显式确认后」的路径调用（如设置页「重置凭证库」二次确认）。
  **本轮不实现该 UI/IPC** —— `reset()` 先作为 API 存在（带 `confirm` 门槛），接线是**另一项**。
- **留档失败时**：中止重置（不覆盖）—— 与「必须保留损坏证据」一致；错误文案给可操作提示
  （检查磁盘空间/权限）。
- **重置失败后状态**：`health` 保持不变（仍是 `corrupt/unreadable/undecryptable`），
  仍拒写，**原文件不删不改**。绝不留「半重置」。
- **重置成功后**：`health → ok`，`cache` 重建为空，旧文件已被 `.corrupt-<ts>` 留档。

> ⚠️ **本阶段的可用性代价**（如实说）：接线 UI 之前，损坏态下用户**无法**通过界面恢复，
> 只能自己备份/删除 `credentials.json`。这是「先保证不丢、再谈好恢复」的取舍，**恢复 UI 单独立项**。

---

## 7. 最小代码修改点（批准后才做）

| # | 文件 | 改什么 | 说明 |
| --- | --- | --- | --- |
| 1 | `electron/core/credentials.cjs` | `load()` 拆成 ENOENT / 读错 / parse 错 / ok 四支；记 `health` / `loadedOnce` / `fingerprint` | 唯一核心改动 |
| 2 | 同上 | `persist()` → `commit(nextData)`：`writeAtomic` + 写前指纹校验 + **成功才换 cache** | 复用 `safe-write`，不新增实现 |
| 3 | 同上 | `set()` / `remove()`：健康态守卫、复制后提交、失败抛错 | 不假报成功 |
| 4 | 同上 | 新增 `reset({ confirm })` | 唯一恢复出口 |
| 5 | 同上 | `get()` 解密抛错时把 `health` 降为 `undecryptable`（再抛）；`primeRedaction` 同理（不抛） | 堵 §3 那条 |
| 6 | 同上 | `status()` 增 `health` 字段（**同通道**，非新增 IPC）| 若你判为越界可去掉 |
| 7 | `scripts/security/suites/privacy.mjs` | 扩 **SEC-073**（写保护）+ **SEC-074**（reset 语义）| **不新增 SEC 编号**（84 项是固定表）|

**改动文件数 = 2**（核心 + 测试）。**不改** `config-secrets.cjs` / `session-crypto.cjs` ——
因为 `set/remove` 改为**抛错**后，它们的调用点天然「显式传播」（`config.cjs` 的迁移路径本就有 try/catch）。

> ⚠️ **撞硬禁区 10**（`credentials.cjs` 属权限/安全模型）→ 必须**单独批准、单独提交、单独验收**。
> ⚠️ 不碰：备份范围、权限模型、IPC 通道清单、Runtime、持久化格式。

---

## 8. 验收测试方案（正向 + 负向，全部落 SEC 套件）

隔离：安全套件 `sandbox.mjs` 已把 `paths.markPackaged(data/security-data)`，**不碰真凭证**。

| # | 用例 | 注入 | 断言 | 归属 |
| --- | --- | --- | --- | --- |
| 1 | 首次无文件可正常保存 | 删掉 `credentials.json` | `set` 成功、文件生成、读回一致 | SEC-073 |
| 2 | 非法 JSON 拒写、原文件字节不变 | 写入 `{ 坏 JSON` | `set` **抛错**；文件字节**逐一相等** | SEC-073 |
| 3 | EPERM/EACCES 读取错误拒写 | 桩掉 `fs.readFileSync` 抛 EACCES | `set` 抛错；原文件不动 | SEC-073 |
| 4 | 写失败时**原文件与内存都不提交** | 桩 `writeAtomic` 抛 ENOSPC | `set` 抛错；文件不变**且** `has(ref)===false` | SEC-073 |
| 5 | 解密失败不丢原始密文 | 种 `backend=safeStorage` 条目 + 无解密能力 | `set(无关ref)` **抛错**；文件 `backend`/字节**都不变** | SEC-073 |
| 6 | 已存在文件意外消失不静默重建 | 先 `ok` 再删文件，然后 `set` | `set` 抛错；**文件未被重建** | SEC-073 |
| 7 | （负向）退回裸写 → 断言必须失败 | 临时把 `commit` 换回裸写跑同一注入 | 4/5 的保护断言**变红**；实验后自动还原 | SEC-073 |
| 8 | reset 需显式确认 | `reset()` 无参 | 抛错；文件不动 | SEC-074 |
| 9 | reset 清空并留档、不影响他项 | 有 corrupt 文件时 `reset({confirm:true})` | 产生 `.corrupt-<ts>`；重建可写；他数据不动 | SEC-074 |

**「确实被执行」的保证**：`npm run security` 在 `verify` 链里（`package.json` 的 `verify`），
`run.mjs` 无参跑全部套件（含 privacy → SEC-073/074）。负向用例（#7）用**自动还原的临时脚本**
同 `SEC-073` 已有做法（`privacy.mjs:189-202`）。**不新增测试入口文件**，不碰 `selftest.mjs`（贴线）。

---

## 9. 风险与回滚

| 项 | 说明 |
| --- | --- |
| 主要行为变化 | `set/remove` 在坏库下**由「静默覆盖」变「抛错」** —— 这是**特意**的（用户要的就是不静默）|
| 影响面 | 保存供应商/搜索密钥会失败并报错（而非悄悄清空）；`session-crypto.ensureKey` 在坏库下会抛（不静默写坏）|
| 不碰 | 文件格式不变（仍 `{version,backend,entries}`）→ **零迁移**；无新 IPC / UI |
| 回滚 | 单文件改动：`git revert <commit>`。回滚后磁盘格式完全一致，无数据副作用 |
| 已知局限 | 不检测「同毫秒等价改写」；恢复 UI 未做（本阶段） |

---

## 10. 明确不做（本设计边界）

- 不改凭证**文件格式**、不加**迁移**。
- 不新增**锁框架**（用 mtime/size 指纹，够用即止）。
- 不新增 **UI / IPC 恢复入口**（`reset()` 先作 API，接线单独批）。
- 不给凭证库加进**备份范围**（另一项独立决定）。
- 不改 `decrypt()` 的报错口径（已够清楚）。
- 不碰 `config.cjs` 的 `.broken` 逻辑（它更完善，是**参照物**）。
- 不动 `task-io` / `changeset` / `session-io` / 备份范围（E2 的其它项，各自单独批）。

---

## 11. 与 task-io（E2 第一项，已实施）的关系

同型：都是「写用户数据用裸写 + 读失败静默当空」。task-io 立了模板
（**状态分清 → 状态不对拒写 → 留档不删原件 → 原子写 → 负向测试**），credentials 照同一模板，
**多三点**：① 第三态 `undecryptable`（凭证特有）；② **提交一致性**（先落盘、后换内存）；
③ **显式 reset 出口**（坏库不能永久锁死）。
