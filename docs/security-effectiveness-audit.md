# 安全测试有效性审计报告

> 对应《Harbor Agent 安全测试有效性审计与缺陷注入验证规范》v1.0（2026-10-11）。
> 基线提交 `1c67a3d2b`（与当前 HEAD 一致）· 审计环境 win32 / node v24.19.0 / isolated-test。
> **原则：先证明测试能抓住错误，再讨论测试是否充分；不为追求全绿弱化安全断言。**

## 1. 结论摘要

- 上一轮「84 项全绿」的**结论本身成立**，但**不是所有断言都同强度**：审计把 84 项分成
  **STRONG 73 · PARTIAL 10 · N/A 1（SEC-081）**，**P0 无 WEAK / UNVERIFIED**。
- **测试确实能抓住防护退化**：在隔离副本里做的 **25 个受控缺陷注入（P0 优先）全部被目标用例击杀**，
  有效 **Mutation Kill Rate = 100%**（Killed 25 / Survived 0 / Invalid 0）。
- 本轮**发现并修复了 3 处问题**（1 个测试盲区、1 个假绿、1 个执行器 fail-open），
  修复以**加强断言/门禁**实现，并各自补了回归证据（见 §6）。
- 发布门禁**可信**：8 类异常报告（P0 FAIL/BLOCKED/NOT_RUN/缺失/重复/未知状态/套件抛异常）都让门禁非零；
  且门禁判据**不读历史报告文件**，旧报告缓存无法冒充成功。
- **仍未验证**（如实标注，不伪造）：① 第二台干净 Windows 环境（Phase F → `BLOCKED`）；
  ② SEC-040 对 IPv6/域名型/其它厂商元数据地址未硬拒；③ 真实模型对抗（另立入口，未执行）。

## 2. 基线复核（Phase A）

| 命令 | 退出码 | 耗时 |
|---|---|---|
| `npm run security:audit` | 0 | ~0.9s |
| `npm run security` | 0 | ~23s |
| `npm run security:gate` | 0 | ~20s |
| `npm run verify` | 0 | ~134s |

- 84 项唯一且被执行器识别（`security:audit`：9 套件不重叠覆盖 84 项）。
- **SEC-081 N/A 依据独立核实**：`package.json` 无任何更新类依赖，`electron/**` 无 `autoUpdater`
  → 确无更新包来源/签名可校验，判 N/A 成立。
- 报告所称修复去重后为 **7 个独立缺陷**（3 个首轮 P0 + 2 个全量跑出的 FAIL + 四笔遗留中的 2 个安全相关），
  提交 `111e6c6 / 47da2eb / 1c67a3d` 可追溯。
- 工作区开始时**干净**（`git status --short` 无输出），未做 `reset`/`clean`。

## 3. 84 项断言审计（Phase B）

逐项映射见 [`docs/security-assertion-map.md`](security-assertion-map.md)。分布：

| 评级 | 数量 | 含义 |
|---|---|---|
| STRONG | 73 | 覆盖真实安全决策路径，有正负对照，缺陷注入可击杀 |
| PARTIAL | 10 | 真实代码执行但边界/变异覆盖不完整（多为**配置面静态断言**或**确定性边界**） |
| WEAK | 0 | —— |
| UNVERIFIED | 0 | —— |
| N/A | 1 | SEC-081（无自动更新，附仓库证据） |

PARTIAL 的 10 项集中在：`SEC-005/010/080/082`（WebPreferences / CSP / 构建配置一致性 —— 本质是**配置面**，
只能读源码或产物，无运行期等价物）、`SEC-078/079/083`（供应链静态字符串）、
`SEC-013/014`（提示注入的**确定性边界**，规范 §C.2 明确要求如实标注为「确定性边界测试」而非「已证明模型不服从」）、
`SEC-040`（见 §7 缺口）。

> 审计强度**分布**如上；**不**把 STRONG 数量包装成「安全覆盖率百分比」。

## 4. 受控缺陷注入（Phase C）

机制与口径见 [`scripts/security/mutation/README.md`](../scripts/security/mutation/README.md)。
隔离：`robocopy` 复制 + `node_modules`/产物 junction，全部写在 `data/mutation/wt`（gitignore），
主工作区与用户真数据未被触碰；每个变异前把**所有涉及文件**还原，杜绝污染累积。

**结果：25 / 25 KILLED（Kill Rate 100%）**，逐项证据在
[`security-effectiveness-results.json`](../security-effectiveness-results.json) 的 `mutations[]` ——
每条含 `expected / actual / exitCode / verdict / collateral / durationMs / evidence`，其中 `evidence`
以**相对路径**引用脱敏的原始日志（`data/audit-logs/mutation-1-13.json`、`mutation-14-25.json`，不入库）。
> 收口时用固化工具**两批重跑**了全量 25 变异，并把 `mutations[]` 的结果字段**全量同步到这次权威日志**
> （此前单条 `collateral` 残留了更早运行的旧值）。重跑结果不变：25/25 KILLED。

| 变异 | 目标 | 受控缺陷 | 判定 |
|---|---|---|---|
| MUT-01 | SEC-002 | HTML 直通默认改开 | KILLED |
| MUT-02 | SEC-003/012 | 解除不可信 HTML 隔离 | KILLED |
| MUT-03 | SEC-007 | 削弱 IPC sender 来源判定 | KILLED（**加固后**） |
| MUT-04 | SEC-008 | 关掉 IPC 参数夹取 | KILLED |
| MUT-05 | SEC-009 | 外链协议白名单放行 file:/javascript: | KILLED |
| MUT-06 | SEC-011 | 来源判定改 fail-open | KILLED |
| MUT-07 | SEC-013 | 去掉网页「数据非指令」包装 | KILLED |
| MUT-08 | SEC-016 | 去掉授权按会话隔离 | KILLED |
| MUT-09 | SEC-017 | 判定退化为字符串路径（TOCTOU） | KILLED |
| MUT-10 | SEC-018 | 关掉只读权限门 | KILLED |
| MUT-11 | SEC-019 | 被否决后不再停手 | KILLED |
| MUT-12 | SEC-021 | 关掉联网门 | KILLED |
| MUT-13 | SEC-025/026 | 放松路径边界 | KILLED |
| MUT-14 | SEC-027 | 跳过符号链接真实路径解析 | KILLED |
| MUT-15 | SEC-029 | 停掉危险度分级 | KILLED |
| MUT-16 | SEC-037 | 让 CDP 指向非授权标签 | KILLED |
| MUT-17 | SEC-040 | 移除云元数据硬拒 | KILLED |
| MUT-18 | SEC-041 | 去掉主机名归一化 | KILLED |
| MUT-19 | SEC-052 | 去掉下载文件名清洗 | KILLED |
| MUT-20 | SEC-057 | 关掉项目级记忆隔离 | KILLED |
| MUT-21 | SEC-065 | 关掉会话级记忆隔离 | KILLED |
| MUT-22 | SEC-067 | 关掉密钥脱敏 | KILLED |
| MUT-23 | SEC-077 | 门禁解析器喂受控高危（模拟） | KILLED |
| MUT-24 | SEC-080 | 生产/开发构建关闭 sandbox | KILLED |
| MUT-25 | SEC-069 | forRenderer 把明文密钥交给界面 | KILLED（**加固后**） |

Collateral（仅无关用例失败）均为**同一安全边界**的连带（如路径边界被破坏时 SEC-016/022/027 一起红），非误报；
无「编译错误/进程启动失败被计为击杀」的情形（Invalid = 0）。

## 5. 门禁负例验证（Phase D）

逐项命令与退出码见 [`docs/security-gate-negative-tests.md`](security-gate-negative-tests.md)。**12 / 12 通过**：

| # | 场景 | 档 | 退出码 |
|---|---|---|---|
| D-1 | 适用 P0 FAIL | gate | 1 ✅ |
| D-2 | 适用 P0 BLOCKED | gate | 1 ✅ |
| D-3 | 适用 P0 NOT_RUN | gate | 1 ✅ |
| D-4a | P0 条目缺失 | gate | 1 ✅ |
| D-4b | id 重复 | gate | 1 ✅ |
| D-4c | 未知状态 | gate | 1 ✅ |
| D-5 | **套件抛异常** | 默认 / gate | 1 / 1 ✅（**修复后**） |
| X-1 | P0 NOT_RUN 在默认档不挡（设计如此，记录在案） | 默认 | 0 |
| B-1/2 | 全 PASS → 门禁/默认档为零 | gate/默认 | 0 ✅ |

接线实证：`.github/workflows/ci.yml` 跑 `npm run verify`；`.github/hooks/pre-push` →
`scripts/hooks/pre-push.mjs` → `verify`；`scripts/preflight.mjs` → `verify`。
**verify 内含 `npm run security`** —— 不是 README 宣称，是配置 + 一次真实运行核实。

## 6. 发现的测试盲区与修复（只加强，不降标）

| # | 问题 | 类型 | 最小修复 | 回归证据 |
|---|---|---|---|---|
| F-1 | **SEC-007** 只跑测试**自造**的 `isTrusted`，没跑真实 `trustedSender` → 削弱真实判据它照样 PASS（MUT-03 Survived） | 测试盲区 | `scripts/security/suites/ipc.mjs` 补真跑 `rh.trustedSender(...)` 正反例 | MUT-03 重跑 → KILLED |
| F-2 | **SEC-069** 观测的 provider **从不引用**所塞凭证，看到的是本就空/掩码的字段 → 「不含明文密钥」恒真（假绿） | 弱断言 | `privacy.mjs` 先让该 provider 真引用凭证 + 补 `hasKey` 对照 | 新增 MUT-25 → KILLED |
| F-3 | **套件抛异常时默认档 exit=0**（异常被 `finally` 里的 `process.exit(0)` 抢先）→ `verify` 会假绿 | 执行器 fail-open | `run.mjs` 捕获套件异常 → 标记该套件未结论项为 BLOCKED 并**强制非零** | D-5（默认/gate 档）→ exit 1 |

三处修复**均未改动产品安全语义**，只加强测试与门禁。修复后重跑：`npm run security` 仍 **83 PASS / 0 FAIL**，
`security:gate` exit 0。

## 7. 关键风险专项复核（Phase E）

- **E.1 HTML/IPC**：`harbor.rawHtml` **默认关**（MUT-01 可击杀配置回退）。⚠️ **默认关不是完整沙箱** ——
  手动开启后，注入的 HTML 与**应用渲染层同 origin / 同 preload / 同 IPC**（`RawHtml` 在 `src/` 内，与应用同渲染进程）。
  这是**已知取舍**：需要的话应给预览内容单独的 sandboxed 窗口/iframe，本轮未做（如实记）。
  IPC sender 校验已核实覆盖 origin/webContents 身份与生命周期（SEC-007/011，MUT-03/06 击杀）。
- **E.2 SSRF**：`electrode-policy` 的 `decide` 对 `169.254.0.0/16` **任何档位硬拒**（MUT-17 击杀）；
  IPv4-mapped `[::ffff:169.254.169.254]` 也拒。**缺口**：`[fe80::1]`（IPv6 链路本地）、
  `metadata.google.internal`（域名型）、`100.100.100.200`（阿里云元数据）在 `allow` 档**未拒** →
  SEC-040 判 PARTIAL。**建议最小修复**：把 `METADATA_HOST_RE` 扩到 IPv6 链路本地/ULA 与常见厂商元数据 IP 段。
- **E.3 Memory Scope**：`sessionId` 的存储（`memory-store` 新增字段）、旧记录读时补空串迁移、
  召回过滤、模型工具写入（`remember` 带 `scope`）、提示组装（`loop-prompt` 透传 `sessionId`）走**同一条链**；
  旧 `session` 记录缺 `sessionId` 时**保守不注入**（非降级为全局）。MUT-20/21 击杀。
- **E.4 供应链**：`xlsx` = `cdn.sheetjs.com/xlsx-0.20.3` tarball，lockfile **有 integrity**；
  `npm audit --omit=dev` high/critical 为 0（SEC-077，MUT-23 击杀）。**残留**：离线/镜像安装复现未验证。
- **E.5 下载/文件/密钥**：真失败注入（真掐连接 / 真 SIGKILL 子进程 / 真往不可用路径写）与模拟错误**分开标注**
  （`suites/downloads-injection.mjs`）；`.part`/Range/ETag/文件名清洗均有断言（MUT-19 击杀）；
  密钥哨兵覆盖日志/导出/前端状态（MUT-22/25 击杀）。

## 8. 独立环境与真实模型范围（Phase F）

- **第二台干净 Windows 环境：`BLOCKED`** —— 当前执行环境没有第二台机器/VM。
  可直接运行的复现步骤见 [`docs/security-reproduction.md`](security-reproduction.md)；**未伪造跨机结论**。
- **真实模型对抗测试：未执行**（规范 §F 另立受控验收入口，本轮不使用真实密钥）。可提交测试设计，**不报告为已执行**。

## 9. 代码改动

| 文件 | 改动 | 是否改产品语义 |
|---|---|---|
| `scripts/security/gate.mjs` | 新增：门禁判据（P0 非 PASS + 缺失 + 重复），由 run.mjs 与审计夹具共用 | 否 |
| `scripts/security/run.mjs` | 接 gate.mjs；套件抛异常 → 标 BLOCKED 且强制非零 | 否（门禁更严） |
| `scripts/security/suites/ipc.mjs` | SEC-007 补真跑真实判据 | 否（加强断言） |
| `scripts/security/suites/privacy.mjs` | SEC-069 建立凭证关联 + hasKey 对照 | 否（加强断言） |
| `scripts/security/mutation/` | 新增：worktree.mjs / mutate.mjs / gate-negative.mjs / README.md | 否（审计工具，仅写 data/） |
| `docs/security-*.md`、`security-effectiveness-results.json` | 新增报告与机器结果 | 否 |

**未 commit 任何故意注入**；注入只存在于 `data/mutation/wt`（已随副本清理）。提交前扫描无注入残留。

## 10. 最终门禁（真实退出码）

| 命令 | 退出码 |
|---|---|
| `npm run security:gate` | **0** |
| `npm run verify` | **0** |
| `npm run security` | 0（`PASS 83 · FAIL 0 · N/A 1 · NOT_RUN 0`） |

证据路径：`data/audit-logs/security-gate.log`、`data/audit-logs/verify.log`、
`security-results.json`、`security-effectiveness-results.json`。

---

### 完成判定

不是「84 项再次全绿」，而是「**能以可复现的反例证明关键安全测试在防护退化时会变红，且发布门禁确实阻断**」——
本轮已达成：25 个受控注入全部击杀、12 项门禁负例全部阻断、修复 3 处测试/门禁缺陷。
**未完成项（跨机复现、IPv6 元数据、真实模型）已如实标注，不伪造 PASS。**
