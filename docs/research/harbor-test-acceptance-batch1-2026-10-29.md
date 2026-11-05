# Harbor 统一测试工具：第一批使用与验收

> **回迁说明（2026-11-06）**：原文件在仓库外
> `C:\Users\BinLin\Documents\Codex\2026-10-29\e-codexworkbench\outputs\`，
> 资料整理第一批移入本仓库，**原件保留在原处**。
> **状态：历史验收记录** —— 里面的数字是 2026-10-29 当次实跑的结果，**不是现行判据**；
> 要看现在能不能用，跑 `npm run harbor-test`，别拿这份当基线。

第一批已写入 `E:\CodexWorkbench`，供 `E:\Harbor-Dev` 自举开发版的 PowerShell 终端使用。进入源码目录后运行：

```powershell
Set-Location E:\CodexWorkbench
npm run harbor-test
```

空参数打开 TUI，可选测试套件和被测目标；方向键选择，Enter 启动，报告页左右键切换六节、`l` 看日志尾部、`e` 看证据路径、`q` 退出。也可直接运行：

```powershell
npm run harbor-test -- self --target=source
npm run harbor-test -- unit --target=source
npm run harbor-test -- e2e --target=source
npm run harbor-test -- all --target=source
npm run harbor-test -- all --target=installed
npm run harbor-test -- --diff --target=source --scope=all
```

在无交互终端或保存日志时加 `--plain`；需要 HTML 同时加 `--html`。每轮的 `report.md`、`run.json`、脱敏后的日志、退出码和可取得的失败证据保存在 `E:\CodexWorkbench\data\harbor-test\runs\<run-id>\`。安装版测试会复制 `E:\Harbor` 的程序文件到隔离目录，排除真实 `data/`，校验 EXE 哈希后运行副本自检；**不会**把源码单测或当前 Edge 脚本误称为安装版验收。

## 本次实测

| 项目 | 结果 |
| --- | --- |
| 工具的解析/报告测试 | 8 项通过 |
| `self --target=source` | 内核自检 5953 项通过、0 失败；报告提示同组判据名称重复的可疑信号 |
| `all --target=installed` | 安装版隔离副本 `channelsOk: true`；源码单测和 Edge 验收明确列为未覆盖 |
| `all --target=source` | 单测 2039 项通过、自检 5953 项通过；安全 `SEC-073 健康态报 undecryptable` 失败，构建与 e2e 未运行 |
| 真机抽样 | 早期 `accept-sidepanel` 仍要求旧的 “Hello Harbor” 页面；现在默认跳过，显式运行标“判据过时”，不冒充产品故障 |
| `npm run preflight` | 退出码 1，仍停在既有 `SEC-073` |
| `HARBOR_UNIT_TEST=1 npm run test:app` | 退出码 0，`channelsMissing: []`、`channelsOk: true` |
| 行数与仓库规则 | `node tools/line-limit.mjs`、`npm run check:rules` 通过 |

第二批的独立端口/profile、失败保留现场、失败重试与“真红/环境抖动”分类尚未实施。第一批报告会把单次失败写为“待复核”，不会凭一次红断言代码真的坏了。

**下一步：**先验收 TUI 和默认人话报告是否符合你的阅读习惯，再决定第二批的隔离适配方案。当前 `SEC-073` 是源码安全门禁的独立待办。
