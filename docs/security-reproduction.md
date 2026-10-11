# 独立环境复现（Phase F）

> 对应《安全测试有效性审计规范》Phase F。
> **状态：`BLOCKED: second clean Windows environment unavailable`（无第二台干净环境，如实标注，不伪造）。**

## 为什么是 BLOCKED

本轮审计在**同一台**（win32 / node v24.19.0 / npm 11.17.0）上完成。规范要求在**第二台干净 Windows
机器或干净 VM** 上用同一提交、同一锁文件重跑，以坐实「跨机可复现」。当前执行环境**没有**第二台机器 ——
按规范 §F「不得在原机重复一次就宣称跨机验证」，记 BLOCKED，并交付下面可直接照做的步骤。

## 复现步骤（在干净 Windows 机器上照做）

前置：Windows 10/11、Node **v24.19.0**、npm 11.17.0（或读 `.nvmrc` / `package.json` 的 engines，若存在）。

```bash
git clone https://github.com/KhooTsuen/harbor-agent.git
cd harbor-agent
git checkout 1c67a3d2b6201d09364306f3df5f86414617e7f4   # 基线提交（审计起点）
npm ci                                                    # 锁定安装（用 package-lock.json）

npm run security:audit     # 期望 exit 0；「84 项齐、编号唯一、套件不重叠」
npm run security           # 期望 exit 0；PASS 83 · FAIL 0 · N/A 1 · NOT_RUN 0
npm run security:gate      # 期望 exit 0（适用 P0 全 PASS）
npm run verify             # 期望 exit 0（全链）
```

### 变异与门禁负例（可选，但更能证明有效性）

```bash
node scripts/security/mutation/mutate.mjs          # 25 个受控注入，期望全部 KILLED
node scripts/security/mutation/gate-negative.mjs   # 12 项门禁负例，期望 12/12
```

> 变异工具只写 `data/mutation/wt`（gitignore），不碰主工作区/真数据。若需拆分以避开单次超时：
> `node scripts/security/mutation/mutate.mjs 1 12` 再 `13 25`。

## 需要记录并回填的字段

| 字段 | 值 |
|---|---|
| 机器 / OS 版本 | （待第二台环境填） |
| Node / npm 版本 | （待填） |
| `security:audit` 退出码 | （待填） |
| `security` 退出码 | （待填） |
| `security:gate` 退出码 | （待填） |
| `verify` 退出码 | （待填） |
| 与基线的差异 | （待填；理论上应为「无差异」） |

## 已知的环境敏感点（第二台要特别留意）

1. **`xlsx` 依赖来源**：`package.json` 指向 `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` ——
   `npm ci` 需要能访问该域名（本机经代理可达）。若离线/镜像，`npm ci` 会失败。
2. **`npm audit` 需要联网**（SEC-077）。离线时该项会判 `BLOCKED`，不影响其它项。
3. **`npm run security` 里的渲染层用例**用 `npx vitest run`（jsdom），需要 `npm ci` 装全依赖。
4. **`dist` / `dist-portable`**：SEC-010/080 会读构建产物（`dist/index.html`、`dist-portable/…`）。
   干净检出时 `dist` 由 `verify` 末尾的 build 生成；`dist-portable` 需 `npm run package`（可选，
   缺了对应断言会如实标 BLOCKED，不是 PASS）。

## 真实模型对抗（另一个入口，未执行）

规范 §F 允许「另立受控验收入口」，但**不得报告为已执行**。本项目已有的真机入口是
`npm run acceptance`（`tools/acceptance.mjs`，真凭证 + 真模型）。本轮**未**使用真实密钥、**未**执行 ——
仅记录入口位置，供后续单独排期。
