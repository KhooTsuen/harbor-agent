# tmp/ —— 临时工作区（**不提交**，除本文件）

这个目录是「干活时用的东西」，不是项目的一部分：**只有本文件被提交**（见 `.gitignore` 里
`tmp/*` + `!tmp/README.md` 两条）。别的都可以随时删 —— 删了最多重跑一次命令。

> **2026-10-07 大整理**：以前这里攒了 41 个历史副本 / 700+ 项，而且本文件点名的一批脚本
> **早就被清掉了**（索引在撒谎）。这次把**还活着的一次性脚本**分了两处放，见下。

## 1. 还活着的脚本 —— 分两处

### `tools/dev/`（**进仓库**，可复用的一次性脚本搬过去了）

| 脚本 | 干什么 |
| --- | --- |
| `where-am-i.mjs` | 「我现在在哪」：工作区未提交项 / 最近三笔提交 / 服务器 main / 装机版版本 |
| `ship.mjs` / `finish.mjs` | 提交 → 推送 → 打包 → 同步到 `E:\Harbor`（跳过顶层 `data/`），结论落 `tmp/*.txt` |
| `ship-beta.mjs` / `do-release.mjs` / `mk-release.mjs` | 建 beta release / 归档产物 / 收尾 |
| `bump.mjs` / `bump2.mjs` | 改 `package.json` 版本号（旧手法；现在优先 `npm version`） |
| `check-commit-msg.mjs` | 提交信息格式检查 |
| `github-check.mjs` / `release-state.mjs` | GitHub 连不通时核对线上状态 |
| `run-selftest.mjs` / `selftest-tail.mjs` | 只跑内核自检并把尾部写文件 |
| `verify.mjs` | 只跑验证链并落盘（终端会乱码，所以写文件） |
| `sync-harbor-24.mjs` / `post-sync-check.mjs` | 同步到装机版后做一遍体检 |
| `old-safe-write.mjs` | 拿「旧版本」跑新自检的那条断言，证明它抓的是真问题 |
| `read-conv.mjs` | 从 `E:\Harbor\data\sessions\*.jsonl` 里捞某条对话看 |

> 搬过去时补了路径层级：这些脚本用 `import.meta.dirname, '..'` 当仓库根，
> 深了一级，`check-commit-msg.mjs` / `mk-release.mjs` / `old-safe-write.mjs` 各改了一行。

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
