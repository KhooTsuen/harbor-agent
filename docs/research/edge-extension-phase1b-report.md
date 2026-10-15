# Phase 1b 第一步 · 实施与验收报告（Edge native host 安装链路）

> 范围：**只做第一步** —— fuse 检查 + 安装/卸载脚本 + 判据调整 + 自检断言。
> 扩展骨架与侧边栏 UI（Phase 1c）**未开始**，按约定停下等确认。
>
> 本轮**没有**引入新依赖，**没有**碰 Runtime / 严格模式 / 防闪烁 / `hardenWebview` / 工具系统 / 权限模型。

---

## 一、结论一句话

`runAsNode` fuse **启用**（三重取证），路径 2 成立；安装链路真机跑通 ——
`install-host.cmd` 一次跑完即能在真实 Edge 里连上 host 收到 `{"pong":1}`，
`uninstall-host.cmd` 跑完**注册表 / 文件 / profile / 进程全无残留**。

**一个额外的重要结论**：路径 2 下 **`main.cjs` 根本不会执行**（`.cmd` 直接跑
`native-host.cjs`，`require.main === module` 就进 `run()`）—— 所以本轮**没有改 `main.cjs`**，
它原有的兼容分支保留不动。

---

## 二、fuse 检查（路径 2 的命门）

### 结论：✅ runAsNode **enabled**，未被禁用

四条互相独立的取证：

| # | 方式 | 结果 |
|---|---|---|
| ① | **静态**：`package.json` + 打包脚本 | 无 `@electron/fuses`、无 `electron-builder`；`scripts/build-portable.mjs` 是纯 `cpSync` → **链路里没有翻 fuse 的工具** |
| ② | **手工解析** exe 里的 fuse wire | `electron.exe` 与便携版 `Harbor.exe` **完全一致**：`01 09` + `"101100011"` → 第 0 位（runAsNode）= `'1'` = enabled，九位**全等于 Electron 默认值**（从没被翻过） |
| ③ | **行为实测**（三组） | `RUN_AS_NODE=1` + `native-host.cjs` → stdout **纯帧、无 CRLF**，`{"pong":1,…}`；不带 → 只有 `\r\n`；`RUN_AS_NODE=1` + `-e` → `NODEMODE:24.20.0` |
| ④ | **权威 CLI** | `npx @electron/fuses read --app Harbor.exe` → **`RunAsNode is Enabled`** |

fuse wire 格式依据官方文档（Electron Fuses 页）：
`| sentinel_bytes | fuse_version | fuse_wire_length | fuse_wire |`，
每字节 `'0'`=disabled / `'1'`=enabled / `'r'`=removed，**第 0 位就是 runAsNode**。

> ⚠️ **一处如实说明**：我最初按记忆把 `'1'` 读成 disabled，得出「fuse 被禁」的结论 ——
> **与 Phase 0 实验 3b/3c 的实测直接矛盾**。核官方文档后发现是**我读反了**。
> 记忆不可靠，**行为实测 + 官方原文 + 权威 CLI** 三方一致才算数。

「为什么必须查这个」：路径 2 依赖 `ELECTRON_RUN_AS_NODE`，而它**受 runAsNode fuse 控制**
（官方：*"If the runAsNode fuse is disabled, ELECTRON_RUN_AS_NODE will be ignored."*）。
现在没翻 ≠ 以后不会翻 —— 所以加了自检保命线（见第五节）。

---

## 三、改了什么（严格核对授权范围）

| 文件 | 类型 | 改动 | 在授权范围内？ |
|---|---|---|---|
| `electron/native-host.cjs` | 改 | `isHostArgv(argv, env)` 改三形态 + 加 `RUN_AS_NODE_ENV` 常量 + 文件头补路径 2 说明。**帧编解码一行未动** | ✅ 用户明确要求「调整」 |
| `electron/main.cjs` | **未动** | 路径 2 下它不执行，无需改 | ✅ 更小 |
| `scripts/selftest/groups/154-native-host.mjs` | 改 | 按协议层（154）+ 装配层（**拆出 155**）分组，并修一处注释误判 | ✅ |
| `scripts/selftest/groups/155-native-host-install.mjs` | **新** | 路径 2 判据 / 脚本规矩 / fuse 保命线 | ✅ |
| `scripts/selftest/groups.mjs` | 改 | 注册 155 组（+2 行） | ✅ |
| `harbor-edge/harbor-host.cmd` | **新** | 包装器 | ✅ |
| `harbor-edge/install-host.cmd` | **新** | 安装 | ✅ |
| `harbor-edge/uninstall-host.cmd` | **新** | 卸载 | ✅ |
| `harbor-edge/tools/read-extid.cjs` | **新** | 读真实扩展 ID（带重试 + 自清理） | ✅ |
| `harbor-edge/tools/accept-host.cjs` | **新** | 端到端验收 | ✅ |
| `harbor-edge/lib/driver.cjs` | **新** | 隔离 Edge 驱动 | ✅ |
| `harbor-edge/ext/{manifest.json,service-worker.js}` | **新** | Phase 1b 探针扩展 | ✅ |
| `.gitignore` | 改 | 忽略 `harbor-edge/profiles/`（兜底） | ✅ |
| `CHANGELOG.md` | 改 | 记账 | ✅ 硬约束 #10 |
| `docs/research/edge-extension-phase1b-report.md` | **新** | 本报告 | ✅ |

**不在授权范围、也确认没做的**：扩展骨架 / 侧边栏 UI（Phase 1c）· 任何新依赖 ·
Runtime / 严格模式 / 防闪烁 / `hardenWebview` / 工具系统 / 权限模型 · 新增 IPC 通道。

---

## 四、真机验收（逐条对标准）

| 验收标准 | 结果 | 证据 |
|---|---|---|
| 跑一次 `install-host.cmd`，Edge 能连上 host，收到 `{"pong":1}` | **✅** | `install-host.cmd` → `[1/4]…[4/4] Done`；`accept-host.cjs` → **`PASS got: {"pong":1,"echo":{"ping":1,"at":…}}`**（真实 Edge 扩展收到的消息） |
| 跑一次 `uninstall-host.cmd`，注册表干净、无残留 | **✅** | 独立复核（不采信脚本自述）：注册表 `rc=1`（键不存在）、父键下 0 个子键、包装器无、清单目录无、profile 无、进程无 |
| `npm run verify` 全绿 | **✅** | 见第六节 |
| 自检断言钉住 fuse 依赖（被禁则红） | **✅** | `155` 组读 fuse wire 第 0 位判 `'1'`；另有一条「便携版 fuse 与 `electron.exe` 一致」 |

**幂等性**（用户明确要求）：

```
第一次运行后：注册表 rc=0 / 清单 X / 包装器 2155 bytes
第二次运行后：注册表 rc=0 / 清单 X / 包装器 2155 bytes
注册表一致 = true   清单一致 = true   包装器一致 = true   ★ 总体 = ✅ 幂等
```

**扩展 ID 必须真加载读回**（用户拍板）：实测加载 `harbor-edge/ext` 得到
**`okiedieobcmdikkiflelpaipheodjafa`**（与按算法手算的结果不同 —— 印证了这条规矩）。
安装脚本默认自己跑一次读回来；也支持显式传 ID 兜底。

---

## 五、自检断言（含 fuse 保命线）

新增/调整后自检 **4545 → 4577 项**（+32）。

**155 组三块**：

1. **路径 2 判据**（7 条）：含「开了 Node 模式但目标不是 `main.cjs` → **不认**」
   （防误伤正常启动）与「没开 Node 模式 + 指 `main.cjs` → 不认」。
2. **脚本规矩**（约 20 条）：`.cmd` **纯 ASCII**（逐字符判，放行 TAB/LF/**CR** ——
   Windows 上 CRLF 行尾是正常的，把 CR 判成危险会造成假红）；`@echo off` 存在；
   **不执行 `chcp`**（只扫非注释行 —— 注释里解释这条规矩是允许的）；**不转发 `%*`**；
   设 `ELECTRON_RUN_AS_NODE=1`；用 `%~dp0`；注册表写 Edge 根（**大小写不敏感** ——
   cmd 里习惯写 `SOFTWARE`，文档常写 `Software`，区分就会假红）；两视图都写/都删；
   清单落 `data/`；`%VAR:\=\\%` 转义。
3. **★ fuse 保命线**：读 `electron.exe` 与便携版 `Harbor.exe` 的 fuse wire，
   断言 `wire[0] === '1'` 且两者一致。

> ⚠️ **fuse 断言故意不跑 `electron.exe`**：启动失败会弹**原生对话框**（要人点）——
> 装进自检（CI 也跑）就是一个会卡住的坑。改读字节，格式由官方文档写死。

**过程中修掉一条自己的假红**：`require('electron')` 出现在**块注释**里
（我在解释「白名单只收顶层不 require electron 的模块」时写了这个字面量）→
断言改成**先剥块注释只扫代码**。

---

## 六、verify

```
含 ❌ = 0   含 ✗ = 0   含 npm error = 0
✓ 内核 281 个 .cjs：没有未定义的标识符（允许清单为空）
✓ 内核 75 个 .cjs 的类型错误与基线一致（基线 181 条，只许下调）
✓ 行数 ≤ 300　1175 个文件全 ≤ 300 行
✓ 规范检查通过
  Test Files  194 passed (194)
  通过 4577 项，失败 0 项
  PASS 83 · FAIL 0 · BLOCKED 0 · N/A 1
  ✓ built in …s
```

---

## 七、过程中发现并修掉的一个缺陷（如实）

**读扩展 ID 与验收各会起一个隔离 Edge profile，实测每个 15 MB，原来跑完不删** ——
「装一次留一个」，用户机器上会慢慢攒出几百 MB 垃圾。

- 发现方式：卸载后**独立复核**时看到 `harbor-edge/profiles/` 里躺着
  `profile-accept` / `profile-extid`，量了一下**各 15.0 MB**。
- 修法：`lib/driver.cjs` 加 `removeProfile(profile, attempts)`（带重试，
  **删不掉只记 stderr、绝不让安装失败**），`read-extid.cjs` / `accept-host.cjs`
  在 `finally` 里清自己那个 profile。
- 修后实测：连跑 `read-extid` 与 `accept-host`，`harbor-edge/profiles/` **为空**。

另修一处**不确定行为**：`install-host.cmd` 第一次跑读 ID 失败过一次
（新建 profile + 首次装扩展落盘慢），紧接着手动跑就成功。这种「有时行有时不行」
不该留在安装脚本里 → `read-extid.cjs` 改成**每轮换一个独立 profile 名、最多重试 3 轮**。

---

## 八、已知遗留

1. **`npx @electron/fuses` 是构建/诊断期工具**：本轮用它做权威交叉验证，
   **没有**写进 `package.json`。日常 `npm test` 不依赖它（自检读字节，不跑 npx）。
2. **`.cmd` 行尾**：当前文件是 LF 行尾，实测 Windows cmd 能正常执行（本轮全部真机跑通）。
   若将来有工具把它转成 CRLF，自检的 ASCII 判定**放行 CR**，不会假红。
3. **`read-extid` 的等待窗口是经验值**（CDP 就绪 + 4s / 重试 3 轮）——
   换台更慢的机器可能要多试几轮，但**不会失败**（脚本自己会重试）。
4. **`main.cjs` 的兼容分支（`--parent-window=`）**：路径 2 下用不到，**保留**。
   将来若确认永远用不到，可单独提一笔删掉 —— 本轮**不动**。
5. **Phase 1c（扩展骨架 + 侧边栏 UI）未开始**：`harbor-edge/ext` 现在是**探针版**
   （service-worker 里硬编码了 `REPORT_URL = http://127.0.0.1:8792/report`，
   只用于 Phase 1b 验收）—— **Phase 1c 做真骨架时必须删掉那行**，
   正式扩展不该往本地服务器发东西。

---

## 九、是否违反约束

零新依赖 ✓ · 零新增 IPC ✓ · 未碰 Runtime / 严格模式 / 防闪烁 / `hardenWebview` /
工具系统 / 权限模型 ✓ · `electron/main.cjs` **未动**（不是「小改」而是**不需要改**） ✓ ·
单文件 ≤300（`native-host.cjs` 293 / `154` 185 / `155` 177） ✓ · 已写 CHANGELOG ✓ ·
未碰用户正在用的 Edge 与 `E:\Harbor` / `E:\Harbor-Dev` ✓ · 探针全部隔离（独立 profile + 生产键
`com.harbor.agent` 装完即卸） ✓ · 未输出未验证的「已完成」（第一节说的「main.cjs 不需要改」
是实测结论，不是推断） ✓
