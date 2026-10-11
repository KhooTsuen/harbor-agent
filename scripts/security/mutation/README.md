# 安全测试有效性审计 · 变异工具（mutation testing）

> 对应《Harbor Agent 安全测试有效性审计与缺陷注入验证规范》Phase C / Phase D。
> 用途：**证明安全测试真的能抓住错误** —— 故意破坏一处防护，看对应用例是否变红、门禁是否非零。

## 为什么要它

「84 项全绿」不等于「这 84 项测得住」。本工具在**隔离副本**里逐个注入最小缺陷，统计
Kill Rate：击杀 = 防护被破坏后目标用例确实 FAIL；存活 = 破坏了却没红（那是**测试盲区**）。

## 安全护栏（重要）

- **只写 `data/mutation/wt`**（在 `data/` 下，gitignore）。主工作区、用户真数据、真密钥**不被触碰**。
- 隔离副本用 `robocopy` 复制 + 对 `node_modules` / 构建产物建 junction；`require` 能跑，但**任何写入都落在副本里**。
- 每个变异前把**所有涉及文件**还原成主工作区版本 —— 避免上一个变异改的文件在副本里累积。
- **不要**在主工作区直接注入缺陷；本工具不会这样做，也请不要绕过它。

## 怎么跑

```bash
node scripts/security/mutation/worktree.mjs          # 只建隔离副本
node scripts/security/mutation/mutate.mjs            # 跑全部 25 个变异
node scripts/security/mutation/mutate.mjs 1 6        # 只跑 MUT-01..06
node scripts/security/mutation/gate-negative.mjs     # Phase D 门禁负例（12 项）
```

结果写 `data/audit-logs/mutation-*.json` 与 `gate-negative.json`（相对路径引用，不入库）。

## 变异统计口径

- **Killed**：目标用例因防护缺陷 FAIL。
- **Survived**：缺陷已生效但目标用例仍 PASS —— **登记为测试盲区**。
- **Invalid**：注入点没匹配上 / 编译不过，不计入杀伤率。
- **Collateral**：只有无关用例失败，不算有效击杀。

`Kill Rate = Killed / (Killed + Survived)`。

## 当前结果（2026-10-11 基线 `1c67a3d2b`）

25 个变异**全部 KILLED**（P0 100%）。审计中被变异抓出并已修的两个测试盲区：
SEC-007（原来只跑测试自造的判据）、SEC-069（原来观测了一个从不引用凭证的字段），
以及一个执行器缺陷（套件抛异常时默认档 exit=0）。详见 `docs/security-effectiveness-audit.md`。
