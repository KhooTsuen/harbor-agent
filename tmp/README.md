# tmp/ —— 临时工作区（**不提交**，除本文件）

这个目录是「干活时用的东西」，不是项目的一部分：**只有本文件被提交**（见 `.gitignore` 里
`tmp/*` + `!tmp/README.md` 两条）。别的都可以随时删 —— 删了最多重跑一次命令。

> **2026-10-07 大整理**：以前这里攒了 41 个历史副本 / 700+ 项，而且本文件点名的一批脚本
> **早就被清掉了**（索引在撒谎）。这次把**还活着的一次性脚本**分了两处放，见下。

## 1. 还活着的脚本 —— 分两处

### `tools/dev/`（**进仓库**，只留真正还在用的）

> **2026-11-09 清理**：这里原来有 19 个脚本，18 个已退役 —— 原因是
> **发版/同步/自检这三件事全部有了正式入口**，旧脚本成了「可误用又没有新功能」的
> 第二套：`npm run package` / `release:zip` / `release:upload` / `check:release` /
> `npm test` / `npm run test:app` 覆盖了它们的全部能力。
> 其中几个还带着真风险：`ship.mjs` 用 `git commit --no-verify` 跳过检查；
> `do-release.mjs` / `ship.mjs` / `github-check.mjs` 写死 1.29.0；
> `sync-harbor-24.mjs` 写死 1.24.0；`read-conv.mjs` 直接读
> `E:\Harbor\data\sessions`（真实用户会话）。
> 历史都还在 Git 里（`git log -- tools/dev/<名字>`），需要时能捞回来。

| 脚本 | 干什么 | 为什么留着 |
| --- | --- | --- |
| `context-replay.mjs` | 上下文链路回放：真实会话 → 两层裁剪 → `assemble` → **模型最终看到什么** | 唯一能回答「模型到底收到了什么」的只读诊断，P0/P1 报告点名引用；参数化路径，不写死 |

**要发版/同步/自检，用正式入口，别再造脚本：**

| 想干什么 | 正式命令 |
| --- | --- |
| 全链验证 | `npm run verify`（CI、pre-push、preflight 用的是同一条） |
| 自检 + 应用自检 | `npm test` · `npm run test:app` |
| 打包 / 打 zip / 发 Release | `npm run package` · `release:zip` · `release:upload` |
| tag 到位检查 | `npm run check:release` |
| 升版本号 | `npm version <版本>`（`package.json` + lock 两处一起改） |

### `tmp/`（**留在这里**）

| 路径 | 是什么 | 为什么没搬 |
| --- | --- | --- |
| `probe-composer-drag.mjs`（760 行） | 输入框拖拽探针 | 超 300 行红线，进 `tools/` 会干红 `check:lines` |
| `probe-composer-resize.mjs`（307 行） | 输入框缩放探针 | 同上（刚过线） |
| `composer-drag.mjs` / `shot-example-dialogue.mjs` | 同族探针（`import '../tools/probe.mjs'`） | 跟上面两个是一族，留一起 |
| `organize2.cjs` | 整理 `tmp/`：历史包袱收进 `archive/`（先 dry-run 再 `--apply`） | 被 `scripts/check-rules/checks-hygiene.mjs` 与它的单测**点名引用** |
| `*.log` / `*.txt` | 历次运行的输出 | 本来就是产物 |

## 2. 三条规矩

1. **用完登记**：新写的脚本如果「以后还要用」，加进上面第 1 节的表（`tmp/` 那栏或 `tools/dev/` 那栏）。
2. **一次性脚本不留在根目录**：按版本/按次命名的（`b21-*`、`fix2-*`）和输出（`*.log`、`*.txt`）
   会被 `node tmp/organize2.cjs --apply` 收进 `tmp/archive/`。要长期留就别用那种名字。
3. **`archive/` 是回收站**：进去的东西没人看，攒够了整个删掉。

## 3. 常用命令

```bash
node tmp/organize2.cjs                          # 看 tmp/ 该收哪些（dry-run）
node tmp/organize2.cjs --apply                  # 真收进 archive/
node tools/dev/where-am-i.mjs                   # 我改到哪了 / 线上到哪了
```

> 大件（隔离副本、干净测试环境）不要放这里：现搭现用，用完即清或归档。
