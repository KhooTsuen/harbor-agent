# tmp/ —— 临时工作区（**不提交**，除本文件）

这个目录是「干活时用的东西」，不是项目的一部分：**只有本文件被提交**（见 `.gitignore` 里
`tmp/*` + `!tmp/README.md` 两条）。别的都可以随时删 —— 删了最多重跑一次命令。

- 这里放**当前轮次**的临时脚本、日志、探针输出；更早的历史归档到
  `E:\Harbor-归档资料\04-开发仓库留档\`（tmp-历史 / 截图历史 / 沙箱副本 / 数据备份 / 发布包历史），
  本目录内的一小批历史（旧日志、旧 `verify-*.txt`、`b21-*` 这类一次性脚本）收在 `tmp/archive/`。
- 大件（沙箱副本、干净测试环境）不要放这里：用 `tmp\prep-*.cjs` 模式现搭现用，用完即清或归档。

从 2026-09 起 `tmp/` 在资源管理器里是**隐藏**的（`.vscode/settings.json` 的 `files.exclude`），
所以不用看着它乱；但它自己也不能变成垃圾场，规则如下。

## 三条规矩

1. **用完登记**：新写的脚本如果「以后还要用」，加进下面第 2 节的表。
2. **一次性脚本不留在根目录**：按版本/按次命名的（`b21-*`、`fix2-*`）和输出（`*.log`、`*.txt`）
   会被 `node tmp/organize2.cjs --apply` 收进 `tmp/archive/`。要长期留就别用那种名字。
3. **`archive/` 是回收站**：进去的东西没人看，攒够了整个删掉。

## 1. 固定要留的

| 路径 | 是什么 | 为什么不能删 |
| --- | --- | --- |
| `tok/` | **隔离副本**（一份能随便折腾的 Harbor，含 `data/`） | 真机验证都在它上面跑；用 `tmp/sync-replica.cjs` 同步 |
| `perf/` | 探针工具箱：`lib.cjs`（CDP 启动/求值/截图）、`probe-*.cjs`、`walk-gate.js` | 改 UI 后「真跑一遍」靠它 |
| `README.md` | 本文件（唯一被提交的） | 索引 |
| `archive/` | 历史包袱 | 可整删 |

## 2. 还活着的工具（要用就找这些）

**验证**

| 脚本 | 干什么 |
| --- | --- |
| `verify-all.cjs` | 跑完 `npm run verify` 七步并落 `tmp/verify.txt`（终端会乱码，所以写文件） |
| `run-selftest-dump.cjs` | 只跑内核自检，把尾部结果写文件 |
| `check-fmt.cjs` | 只跑格式检查（prettier） |
| `unit-all.cjs` | 只跑单测 |
| `ci-status.cjs` / `wait-ci.cjs` | 看 / 等 GitHub Actions 结果（**走 `gh-api.cjs`**，见下） |
| `gh-api.cjs` | **调 GitHub API 的通道**：用 `curl.exe` + `git config http.proxy` 那个本地代理。<br>⚠️ 直接 `fetch` 会 **ECONNRESET**（2026-09-29 实测）；VPN 没开时代理端口是死的，也会失败 |
| `gh-net.cjs` | GitHub 连通性诊断：DNS → TCP 443 → HTTPS → 代理配置 → 本地/远端提交指针 |

**真机 · 隔离副本**

| 脚本 | 干什么 |
| --- | --- |
| `sync-replica.cjs` | 把 `dist-portable/Harbor` 同步进 `tmp/tok`（验证前必跑） |
| `perf/kill-replica.cjs` | 关掉副本进程（起新探针前先关，否则抢单实例锁） |
| `perf/probe-*.cjs` | 真机探针：读页面、模型选择、流式、权限…… |
| `perf/run-npm.cjs` | 在副本里跑 npm 脚本 |

**发布**

| 脚本 | 干什么 |
| --- | --- |
| `bump-version.cjs` | 改 `package.json` 版本号 |
| `gh-release-*.cjs` / `rel-finalize-*.cjs` | 建 beta release、归档产物、收尾 |
| `gh-releases.cjs` | 列线上 release（核对「只留 1 个正式 + 1 个测试」） |
| `update-harbor.cjs` | 把新版同步到 `E:\Harbor` |

> 发布相关脚本里有 `gh-release-beta3..beta24.cjs` 这类**按版本一次性**的（每个 beta 一份）。
> 现在的规矩是别再那样写：一次性的用完就让 `organize2.cjs` 收走。

**盘点 / 整理**

| 脚本 | 干什么 |
| --- | --- |
| `inventory.cjs` / `inventory2.cjs` | 数仓库家底（体积、文件数、被引用次数） |
| `organize2.cjs` | 整理 `tmp/` 根目录：历史包袱收进 `archive/`（先 dry-run 再 `--apply`） |
| `organize2-guard.cjs` | 移动前保险：检查有没有文件被跟踪文档点名 |
| `perf-tidy.cjs` | 整理 `tmp/perf/`：日志/旧脚本收进 `archive/perf/`，**探针一律不动** |
| `tok-tidy.cjs` | 整理 `tmp/tok/`：旧脚本收进 `archive/tok-scratch/`，**只留副本本体 `Harbor/`** |
| `stage0-clean.cjs` | 删过 `tok17` 等冗余副本（已执行完，释放 363.7 MB） |
| `check-vscode-settings.cjs` | 校验 `.vscode/settings.json` 没写坏 |
| `stage01-check.cjs` | 改完 tmp/ 之后的自查：关键文件在不在 + 规范检查 + 行数红线 |

## 3. 常用命令

```bash
node tmp/sync-replica.cjs                       # 同步隔离副本
node tmp/perf/probe-browse-read.cjs             # 真机读页面探针
node tmp/verify-all.cjs                         # 全套验证 → tmp/verify.txt
node tmp/organize2.cjs                          # 看 tmp/ 该收哪些（dry-run）
node tmp/organize2.cjs --apply                  # 真收进 archive/
```
