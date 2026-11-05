# Harbor 统一测试工具：第二批实施与验收

> **回迁说明（2026-11-06）**：原文件在仓库外
> `C:\Users\BinLin\Documents\Codex\2026-10-29\e-codexworkbench\outputs\`，
> 资料整理第一批移入本仓库，**原件保留在原处**。
> **状态：历史验收记录** —— 下面「已实现」一栏是 2026-10-29 当时的真实行为，
> 现在要以 `tools/harbor-test/e2e.mjs` 等现有代码为准；复跑用 `npm run harbor-test`。

日期：2026-10-29。控制端：在 Harbor-Dev 的 PowerShell 终端进入 `E:\CodexWorkbench`，运行源码仓库中的工具。被测目标：`source`（源码工作区）或 `installed`（`E:\Harbor` 的隔离副本）。

## 已实现

| 能力 | 当前行为 |
| --- | --- |
| 串行队列 | 一个脚本结束并完成注册表、测试数据恢复后才启动下一个；`data/harbor-test/runner.lock` 防止本工具多开。 |
| 每次独立端口与 profile | 在验收子进程内存中替换端口常量、profile 名和 Edge 驱动的 profile 根；原脚本文件与判据不改。每次尝试记录端口段和 profile 路径。 |
| 注册表保护 | 每次尝试快照 64 位和 32 位 `com.harbor.agent` 项，运行后恢复并回读比对；恢复失败时停止队列。脚本自己的备份位置改到本次证据目录。 |
| 测试数据保护 | 运行前备份 `data/unit-test-data`，运行后恢复；成功或失败都不会把它当作可丢弃目录。恢复失败时停止队列。证据中保留日志尾部，临时完整备份恢复后删除。 |
| 失败复测 | 首次失败后用新端口和新 profile 复测一次。两次明确判据失败才称“真红”；复测通过标 `FLAKY`；基础设施失败标 `FAIL_INFRA`。 |
| 失败现场 | 每次尝试保存脱敏 stdout/stderr、退出码、近期日志尾部、Edge 关键 profile 文件；已有截图/HTML 快照会复制。失败时保留独立 profile，成功后清理。 |
| 目标切换 | `E:\Harbor` 的程序文件先复制到本次运行目录，不复制 `data/`；native host 指向这个副本。源码脚本若启动源码 Electron UI，便携版目标下标“未覆盖”。 |

运行示例：

```powershell
cd E:\CodexWorkbench
npm run harbor-test -- e2e --target=source
npm run harbor-test -- e2e --target=installed
npm run harbor-test -- e2e --target=source --script=accept-phase2 --plain
npm run harbor-test -- --diff --target=source --scope=e2e
```

报告位于 `E:\CodexWorkbench\data\harbor-test\runs\<运行编号>\report.md`，同目录有 `run.json`；单个真机脚本的两次尝试在 `accept-*/attempt-1`、`attempt-2`。默认终端显示六节人话报告；交互终端进入 TUI，`--plain` 用于日志和 CI。

## 本次实际验收

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 工具解析、报告、复测判定测试 | 12 项通过 | `node --test tools/harbor-test/*.test.mjs` |
| 文件行数限制 | 通过 | `node tools/line-limit.mjs` |
| 源码 Phase 2 真 Edge + 真扩展 + 真 host | 19 项通过，0 失败 | `data/harbor-test/runs/2026-10-28T22-49-32-386Z-17116/` |
| 便携版隔离副本 Phase 2 | 19 项通过，0 失败 | `data/harbor-test/runs/2026-10-28T22-50-14-304Z-8992/` |
| 旧侧栏探针双次失败 | 2/6；已定位其 “Hello Harbor” 文案判据过时，后续版本标 `SUSPECT` | `data/harbor-test/runs/2026-10-28T22-48-27-036Z-16320/` |

这些代表性试跑证明了隔离与目标切换的主要路径；不能推论整套 Edge 验收已全绿。已有的 `SEC-073 健康态报 undecryptable` 安全门禁失败也仍需单独修复。

## 明确的覆盖边界与下一步

1. `accept-extension` 已接入隔离安装器副本与自动队列，使用 CommonJS preload、独立端口和独立 profile；2026-10-29 真机抽测两次同一判据失败，需先人工核对判据，详见“后续接入进展”。
2. `accept-regen-real.mjs` 已接入 ESM 隔离副本队列分支，并在副本中配置独立端口和数据根；专项测试通过，但尚无可核实的真机队列运行报告，仍待实测。
3. `accept-toolbar-entry` 需要人手点击工具栏图标，标 `NEEDS_HUMAN`；`accept-host` 依赖既有 host 安装，也标 `NEEDS_HUMAN`。
4. `accept-sidepanel` 默认跳过，因为其旧文案判据已不代表当前产品；显式运行的失败标“可疑旧判据”。`accept-m02b` 与 `accept-ownership` 原脚本的注册表恢复调用参数有误，外层恢复校验会兜底，并在报告列可疑信号。
5. 暂未逐个真机运行全部自动脚本。优先按队列运行并检查首次失败；若环境恢复失败，不继续后面的脚本。随后核对原脚本判据、补人工入口验收，再决定发布。
6. 现有脚本和 Electron 测试模式把数据根写死为 `data/unit-test-data`。工具通过串行快照恢复隔离本工具的每次尝试，但**不能防止外部直接运行的 `npm run preflight`、`npm run test:unit` 同时写这个目录**。真机队列运行期间不要在另一终端启动这些命令；后续若要支持并行外部测试，必须给产品测试模式增加可配置数据根，属于本轮“不碰产品代码”的边界外。

注意：本次测试时工具自身仍在迭代，旧的两份试跑目录保留了当时的完整测试数据快照和安装版隔离副本；后续版本已改为恢复后删除临时完整备份、成功后清理安装版副本。不要把这些旧试跑目录当作长期归档或产品数据。

## 后续接入进展（2026-10-30）

已把此前待处理的两个自动脚本接入每次尝试的隔离队列：

- `accept-extension` 继续以 CommonJS preload 运行。队列先校验关键源文件 SHA-256 与适配锚点，再在本轮证据目录暂存安装器、扩展和 host 副本；安装器与 Edge profile 使用本轮路径，脚本通过 preload 获得独立端口和 profile。原验收脚本及其判据未改。
- `accept-regen-real.mjs` 改为复制 ESM 探针和假上游到本轮暂存目录后运行；适配器校验源文件哈希和每个替换锚点，只在副本中替换应用端口、假上游端口、Electron 路径、隔离数据根、请求日志路径及模块路径。隔离数据落在本轮证据目录下，不使用共享 `data/unit-test-data`。
- 两类脚本都在每次尝试分配独立端口段。失败时保留对应尝试的 profile 与证据；成功后清理 profile。队列仍按尝试完成、环境恢复后再进入下一脚本。

**当前验证结果：**

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 适配器与队列相关专项测试 | 9 项通过，0 失败 | `node --test tools/harbor-test/e2e.test.mjs`，2026-10-30 本机重跑 |
| `accept-extension` 真机抽测 | 两次均为 `FAIL_ASSERTION`；判据 9 项通过、1 项失败 | `E:\CodexWorkbench\data\harbor-test\runs\2026-10-29T17-17-26-227Z-7240\report.md` 与 `run.json` |
| 安装器抽测的失败项 | `⑦ 输入框是占位态（disabled）`；两次端口段分别从 37232、38864 开始，profile 分属 attempt-1/attempt-2 | 同一 `run.json`；两轮 `evidence/manifest.json` 均记录已采集 profile 文件 |
| 环境恢复 | 上述两次抽测均记录 `registryOk: true`、`dataOk: true` | `run.json` 两次 attempt 记录 |

这次安装器真机抽测**不能记为通过**：报告把重复失败归类为真红，但同一报告也指出原脚本汇总 10 项、逐项日志只识别到 9 项，且唯一可识别失败项要求输入框 `disabled`。因此这里只记录观测事实，判据是否仍符合当前产品行为需人工核对，不据此认定产品故障或宣布适配器验收全绿。失败 profile 与脱敏后的运行证据留在上述运行目录。

ESM 探针目前已接入队列分支，隔离副本生成、端口替换和数据根约束由专项测试覆盖；本次没有找到可核实的 ESM 真机队列运行报告，故仍标记为**真机待验**。其余自动脚本完整队列、工具栏人工入口、`accept-host` 安装前置以及 `SEC-073` 仍是未完成项。真机队列运行时继续避免并行执行会写 `data/unit-test-data` 的外部测试。
