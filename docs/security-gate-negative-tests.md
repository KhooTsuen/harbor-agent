# 门禁负例验证结果（Phase D）

> 对应《安全测试有效性审计规范》Phase D。验证「异常结果一定让 `security:gate` 非零」，
> 以及默认档（`verify` 用的那条）不会把崩掉的套件当全绿。

## 怎么跑

```bash
node scripts/security/mutation/gate-negative.mjs      # 12 项，独立算，不污染 security-results.json
```

夹具用**合成报告**喂**真实门禁判据**（`scripts/security/gate.mjs` —— 与 `run.mjs` 同一处实现），
`D-5` 在隔离副本里让一个套件 import 失败，spawn 真跑 `run.mjs` 读退出码。

## 判据（`scripts/security/gate.mjs`）

- `--gate`（发布门禁，规范 §12）：P0 **不得** FAIL / BLOCKED / NOT_RUN / **缺失** / **重复**，且无任何 FAIL。
- 默认档（`verify` 挂的）：只挡 FAIL —— NOT_RUN 不挡（不然「还没写的用例」会拦住每次提交）。
- **另加**（本轮审计修复）：任何套件**抛异常** → 强制非零（两种档都挡）。

## 结果：12 / 12 通过

| # | 场景 | 档 | 期望 | 实际退出码 | 结论 |
|---|---|---|---|---|---|
| B-1 | 全 PASS → 门禁通过 | gate | 0 | 0 | ✅ |
| B-2 | 全 PASS → 默认档通过 | 默认 | 0 | 0 | ✅ |
| D-1 | 适用 P0 FAIL | gate | 非零 | 1 | ✅ |
| D-2 | 适用 P0 BLOCKED | gate | 非零 | 1 | ✅ |
| D-3 | 适用 P0 NOT_RUN | gate | 非零 | 1 | ✅ |
| D-4a | P0 条目**缺失** | gate | 非零 | 1 | ✅ |
| D-4b | id **重复** | gate | 非零 | 1 | ✅ |
| D-4c | **未知状态** | gate | 非零 | 1 | ✅ |
| D-5 | **套件抛异常** | 默认 | 非零 | 1 | ✅（修复后） |
| D-5 | **套件抛异常** | gate | 非零 | 1 | ✅ |
| X-1 | P0 NOT_RUN 在默认档不挡 | 默认 | 0 | 0 | ✅（设计如此，记录在案） |
| X-2 | 非 P0 的 FAIL 在默认档也挡 | 默认 | 非零 | 1 | ✅ |

## 记录在案的两点

1. **X-1**：默认档**不**因 P0 NOT_RUN 而红。这是刻意的（否则开发中期每次提交都被拦）。
   发布前必须跑 `--gate`。`verify` 挂的是默认档 —— 所以**发布门禁不能只靠 `verify`**。
2. **D-5 的修复**：审计前，套件抛异常时默认档退出码是 **0**（异常被 `finally` 里的 `process.exit(0)`
   抢先），`verify` 会假绿。本轮在 `run.mjs` 捕获套件异常、把该套件未结论项标记为 BLOCKED 并**强制非零**。
   修复前实测 exit=0，修复后 exit=1（D-5 两档）。

## 报告文件损坏 / schemaVersion

门禁判据在**内存**里对执行结果计算，**不读** `security-results.json` —— 所以「旧报告缓存冒充成功」
在结构上不可能发生（Phase D 第 10 项）。**残留**：读取侧没有对 `security-results.json` 的
`schemaVersion` 做校验（没有消费方需要它）；如实记为局限，不美化成「已覆盖」。

## 接线实证（非 README 宣称）

| 入口 | 实际命令 | 证据 |
|---|---|---|
| CI | `npm run verify` | `.github/workflows/ci.yml`（`run: npm run verify`） |
| pre-push | `verify` | `.github/hooks/pre-push` → `scripts/hooks/pre-push.mjs` |
| preflight | `verify` | `scripts/preflight.mjs` 第 1/3 步 |
| verify 内容 | 含 `npm run security` | `package.json` 的 `verify` 链 |
