# 安全回归覆盖映射（security-coverage-map）

> 对应《Harbor Agent 自动化安全测试清单》v1.0（84 项 · 9 套件）。
> **这不是测试报告，是「哪一项由谁负责、落到哪个文件」的映射。** 实际状态看
> `npm run security` 的输出与 `security-results.json`（数字会随实现进度变，不写死在这里）。
>
> 首次建立：2026-10-11。基线 commit 见 `security-results.json` 的 `commit` 字段。

## 怎么跑

```bash
npm run security                 # 跑 9 个套件，写 security-results.json
npm run security -- ipc agent    # 只跑指定套件
npm run security:audit           # 只查元数据表：84 项齐 / 编号唯一 / 9 套件不重叠
```

套件实现落在 `scripts/security/suites/<name>.mjs`，元数据表在 `scripts/security/cases.mjs`。
渲染层用例（SEC-001~004）由 `src/lib/__tests__/securityHtml.test.tsx` 承载 —— jsdom + 真渲染器，
因为清单第 0 节禁止「凭源码字符串判定安全」。

## 状态口径

| 记号 | 含义 |
|---|---|
| ✅ | **既有覆盖**：本轮之前就有的真实断言（列在「既有依据」列） |
| ➕ | **本轮新增**并通过 |
| ✗ | **本轮新增**且**未通过**（找到缺口，见「本轮发现」） |
| ◐ | 部分覆盖（只覆盖了一部分，仍需补） |
| ▢ | 未覆盖（NOT_RUN，待实现） |

「既有依据」是**实际断言所在**，不是测试文件名。凡标 ✅/◐ 的都经过人工核对断言内容。

## 一、首批 20 项（清单第 13 节）结果

| ID | 优先级 | 状态 | 本轮实现位置 | 既有依据 |
|---|---|---|---|---|
| SEC-001 | P0 | ➕ | `securityHtml.test.tsx`（script 经 innerHTML 不执行） | — |
| SEC-002 | P0 | ➕ | `securityHtml.test.tsx` + `suites/ipc.mjs`（默认已关） | — |
| SEC-003 | P0 | ➕ | `securityHtml.test.tsx`（iframe/srcdoc 关闭后不进 DOM） | — |
| SEC-005 | P0 | ➕ | `suites/static.mjs`（webPreferences） | `09-browser`「webview 加固」 |
| SEC-006 | P0 | ➕ | `suites/static.mjs`（假 electron 真枚举 preload 面） | — |
| SEC-007 | P0 | ➕ | `suites/ipc.mjs`（真跑包装层） | `register-handlers.cjs` isTrustedEvent |
| SEC-008 | P0 | ➕ | `suites/static.mjs`（真注册 handler 喂坏参数） | `127-action` / `schemas` |
| SEC-013 | P0 | ▢ | — | `49-injection`（提示层，部分） |
| SEC-014 | P0 | ▢ | — | — |
| SEC-016 | P0 | ➕ | `suites/agent.mjs`（授权 scope / 撤销 / 敏感） | `03-fs-safety` / `64-approval-center` |
| SEC-017 | P0 | ➕ | `suites/agent.mjs`（junction 换目标后重判） | — |
| SEC-018 | P0 | ▢ | — | `123-subagent`（只读硬拦 / 写不落盘，既有） |
| SEC-021 | P0 | ▢ | — | — |
| SEC-025 | P0 | ➕ | `suites/filesystem.mjs`（穿越） | `03-fs-safety`「resolveInside」 |
| SEC-027 | P0 | ➕ | `suites/filesystem.mjs`（junction 越界） | — |
| SEC-029 | P0 | ➕ | `suites/filesystem.mjs`（Shell 注入） | `03-fs-safety` / `61-destructive` |
| SEC-037 | P0 | ▢ | — | `browserTabPolicy` / `135-cdp`（部分） |
| SEC-040 | P0 | ➕ | `suites/browser.mjs`（三档都拦元数据） | `73-net-policy` / `117-url-policy`（部分） |
| SEC-057 | P0 | ➕ | `suites/memory.mjs`（项目级隔离） | `71-memory-explain`「数据隔离」 |
| SEC-067 | P0 | ➕ | `suites/privacy.mjs`（哨兵密钥） | `03-fs-safety` / `62-redact` / `74-session-crypto` |

## 二、84 项全表（既有覆盖 + 本轮）

### 1. Electron 渲染与 IPC（P0）

| ID | 状态 | 既有依据 / 本轮实现 |
|---|---|---|
| SEC-001 | ➕ | `securityHtml.test.tsx` |
| SEC-002 | ➕ | 默认已关（`DEFAULT_ENABLED=false`）+ `securityHtml.test.tsx` |
| SEC-003 | ➕ | `securityHtml.test.tsx` |
| SEC-004 | ➕ | `securityHtml.test.tsx` + `markdown.test.ts`「危险协议当普通文字」 |
| SEC-005 | ➕ | `static.mjs` + `09-browser` |
| SEC-006 | ➕ | `static.mjs`（枚举 168 个具名方法，通道全部登记） |
| SEC-007 | ➕ | `register-handlers.cjs` 的 isTrustedEvent + `static`/`ipc` 真跑 |
| SEC-008 | ➕ | `static.mjs` + 各工具 schema |
| SEC-009 | ▢ | `117-url-policy` / `batch5UrlPolicy`（外链白名单，属既有但未接进套件） |
| SEC-010 | ➕ | `static.mjs`（vite CSP + 构建产物 meta） |
| SEC-011 | ▢ | — |
| SEC-012 | ▢ | — |

### 2. Agent 授权、工具与 Prompt Injection（P0）

| ID | 状态 | 既有依据 / 本轮实现 |
|---|---|---|
| SEC-013 | ◐ | `49-injection`「外部内容是数据不是指令」（提示层已钉，工具层未接） |
| SEC-014 | ▢ | — |
| SEC-015 | ◐ | `125-decision-shape`（决策形状一处真相源） |
| SEC-016 | ➕ | `agent.mjs` + `03-fs-safety` / `64-approval-center` |
| SEC-017 | ➕ | `agent.mjs` |
| SEC-018 | ✅ | `123-subagent`「只读是硬拦」「写操作真的没落盘」 |
| SEC-019 | ◐ | `19-abort` / `45-pause` |
| SEC-020 | ◐ | `41-budget` / `42-loopguard` |
| SEC-021 | ▢ | — |
| SEC-022 | ◐ | `64-approval-center`（scope 归一成一次性） |
| SEC-023 | ◐ | `96-replay-risk` / `23-approval` |
| SEC-024 | ✅ | `73-net-policy`「读配置失败不能变成放行」 |

### 3. 文件系统与命令执行（P0）

| ID | 状态 | 既有依据 / 本轮实现 |
|---|---|---|
| SEC-025 | ➕ | `filesystem.mjs` + `03-fs-safety` |
| SEC-026 | ◐ | `50-path-encoding`（中文路径边界） |
| SEC-027 | ➕ | `filesystem.mjs` |
| SEC-028 | ▢ | — |
| SEC-029 | ➕ | `filesystem.mjs` + `03-fs-safety` / `61-destructive` |
| SEC-030 | ◐ | `03-fs-safety`（脱敏）/ `batch3Redaction` |
| SEC-031 | ✅ | `03-fs-safety` / `61-destructive`（未授权不得删） |
| SEC-032 | ◐ | `108-scale-gate` / `78-bounds` |
| SEC-033 | ✅ | `66-rollback-to` / `98-rollback-preview` |
| SEC-034 | ▢ | — |
| SEC-035 | ◐ | `file-extract`（附件解析，崩溃面未专测） |
| SEC-036 | ▢ | — |

### 4. 浏览器、CDP 与网络隔离（P0/P1）

| ID | 状态 | 既有依据 / 本轮实现 |
|---|---|---|
| SEC-037 | ◐ | `browserTabPolicy`「不碰用户标签」/ `135-cdp` |
| SEC-038 | ◐ | `browse-ops`（元素索引）/ `137-browse-ops` |
| SEC-039 | ▢ | — |
| SEC-040 | ➕ | `browser.mjs`（deny/ask/allow 三档都拦元数据）+ `net-policy.cjs` |
| SEC-041 | ▢ | — |
| SEC-042 | ◐ | `139-browse-settle` / `88-browser-wait` |
| SEC-043 | ◐ | `74-session-crypto`（密文不含明文） |
| SEC-044 | ✅ | `119-download` + `downloadIntake.test.ts` |
| SEC-045 | ✅ | `139-browse-settle`（不把未渲染当完成） |
| SEC-046 | ◐ | `79-llm-stream`（断流取证） |

### 5. 下载管理器（P1，越界按 P0）

| ID | 状态 | 既有依据 |
|---|---|---|
| SEC-047 | ◐ | `119-download`（planFor 不支持 Range 回退单连接） |
| SEC-048 | ◐ | `119-download`（planSegments 连续性） |
| SEC-049 | ◐ | `download-engine`（ETag，部分） |
| SEC-050 | ◐ | `119-download`（状态机） |
| SEC-051 | ◐ | `download-store.settle` + `119-download`（回落 paused） |
| SEC-052 | ✅ | `119-download` + `03-fs-safety`（下载路径边界） |
| SEC-053 | ◐ | `118-safe-write`（写失败处理） |
| SEC-054 | ✅ | `119-download`（并发夹 8 / 连接夹 16 / 限速） |
| SEC-055 | ✅ | `download-store.load`（丢脏记录）+ `119-download` |
| SEC-056 | ◐ | `119-download`（哈希校验，生成端） |

### 6. Memory 边界（P0/P1）

| ID | 状态 | 既有依据 / 本轮实现 |
|---|---|---|
| SEC-057 | ➕ | `memory.mjs` + `71-memory-explain` |
| SEC-058 | ▢ | — |
| SEC-059 | ◐ | `49-injection`（提示层） |
| SEC-060 | ✅ | `133-memory-conflict-expire`（同类型同范围才取代） |
| SEC-061 | ✅ | `133-memory-conflict-expire`（过期不再注入） |
| SEC-062 | ✅ | `133-memory-conflict-expire`（expired 状态） |
| SEC-063 | ✅ | `batch1DataLoss`（记忆原子写 + `.corrupt` 留档） |
| SEC-064 | ◐ | `116-project-context-complete` / `85-token-opt` |
| SEC-065 | ✅ | `82-task-isolation`（上下文只注入本会话） |
| SEC-066 | ✅ | `71-memory-explain`（注入账） |

### 7. 密钥 / 隐私 / 日志（P0/P1）

| ID | 状态 | 既有依据 / 本轮实现 |
|---|---|---|
| SEC-067 | ➕ | `privacy.mjs` + `03-fs-safety` / `62-redact` / `74-session-crypto` |
| SEC-068 | ▢ | — |
| SEC-069 | ◐ | `static.mjs`（SEC-006 通道白名单）/ `batch2Exits`（问题 24） |
| SEC-070 | ◐ | `batch3Redaction`（台账脱敏） |
| SEC-071 | ▢ | — |
| SEC-072 | ✅ | `batch2Exits`（问题 24）/ `diagnosticsRedaction` |
| SEC-073 | ✅ | `batch1DataLoss`（原子写不留 .tmp） |
| SEC-074 | ◐ | `47-purge` / `deleteThreadPurge` |
| SEC-075 | ✅ | `75-projects`（迁移不重写会话）+ `backup` |
| SEC-076 | ✅ | `batch4Retention`（保留期 / 轮转 / 至少留 N 份） |

### 8. 依赖 / 构建 / 发布（P0/P1/P2）

| ID | 状态 | 既有依据 |
|---|---|---|
| SEC-077 | ▢ | 无 `npm audit` 门禁 |
| SEC-078 | ✅ | `check-rules`（密钥扫描 / 无明文密钥） |
| SEC-079 | ✅ | `check-rules`（依赖两侧一致） |
| SEC-080 | ◐ | `static.mjs`（源码级；构建后实际配置未测） |
| SEC-081 | ▢ | — |
| SEC-082 | ◐ | `80-handlers`（调试端口相关） |
| SEC-083 | ▢ | — |
| SEC-084 | ▢ | — |

## 三、本轮发现与处置（三个 P0，已修）

首轮跑出 3 个 P0 FAIL —— **如实记录**，没有为了让测试变绿而弱化断言。
三项已按「修复」处置（见下），`npm run security` 现已全绿，并接入 `verify` 链。

### F-1 · SEC-002｜HTML 直通默认开启 → **已改为默认关**

- **位置**：`src/components/chat/markdown/RawHtml.tsx`
- **做了什么**：`DEFAULT_ENABLED` 由 `true` 改 **`false`**。默认聊天展示不再执行
  不可信脚本（清单第 1 节口径）。想保留直通能力的人：`localStorage` 设
  `harbor.rawHtml = '1'` 打开（行内/块级两条路径都认这个开关）。
- **代价**：这是**改变 2026-10-08 用户主动钦定的默认行为** —— 用户于 2026-10-11 明确
  选择「按安全清单默认关」。既有测试 `renderExtensions.test.tsx` 已同步为
  「默认关/显式开」两态。

### F-2 · SEC-007｜主进程无 IPC sender 来源校验 → **已加来源校验收口**

- **位置**：`electron/register-handlers.cjs`
- **做了什么**：`wrapInvokeHandlers(ipcMain, isTrusted)` 加一层来源校验；
  `registerHandlers` 注入 `isTrustedEvent`（只接受主窗口的 `webContents`）。
  非受信来源一律拒绝 + 留痕（动作流水 + 主日志）。
  `getMainWindow()` 拿不到时（启动早期）**放行**，有窗口后生效。
- **为什么不粗暴掐死**：当前只有主窗口带 preload，webview 无 preload；这一层是
  **纵深防御**（防以后给某个 webContents 加桥），不是修一个可利用漏洞。
- **验证**：`suites/ipc.mjs` 真跑包装层 —— 受信来源放行、非受信来源被拒。

### F-3 · SEC-040｜`allow` 档下云元数据地址被放行 → **已加硬拒绝**

- **位置**：`electron/core/net-policy.cjs`（新增 `metadataBlocked`）
- **做了什么**：`169.254.0.0/16`（云元数据 / 链路本地）在 `decide()` 里**不受档位影响、
  一律拒绝**。刻意**只**收窄这一个网段：不碰 `127.0.0.1`/localhost（本地 dev server
  要逛）、不碰私网整体（内网服务是用户的正常工作对象）。
- **验证**：`suites/browser.mjs` —— deny/ask/allow 三档都拒元数据，localhost 在 allow 档照常放行。

> **已接入 `verify`**：三项处置后 `npm run security` 退出码为 0，
> 已在 `package.json` 的 `verify` 链尾追加 `&& npm run security`。
> 从此有 P0 FAIL 会一并挡 CI / pre-push / preflight。

