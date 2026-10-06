/*
 * 一次性升号工具：四处版本号 + CHANGELOG 一节（`docs/发布检查.md` 第 2 步）。
 *
 * 四处 = package.json + package-lock.json 的两处（顶层 version 与 packages[""].version）
 *       + CHANGELOG.md 第一条标题（自检 54 组会逐字比）。
 * 为什么写脚本：手工改四处，漏一处就是「自检红、发布卡」——那类漏已发生过。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'E:\\CodexWorkbench'
const NEXT = process.argv[2]
if (!NEXT) {
  console.error('用法：node tmp/bump.mjs <新版本号>')
  process.exit(1)
}

/* ① package.json */
const pkgPath = join(REPO, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const prev = pkg.version
pkg.version = NEXT
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

/* ② package-lock.json 里的两处 */
const lockPath = join(REPO, 'package-lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
lock.version = NEXT
if (lock.packages?.['']) lock.packages[''].version = NEXT
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')

/* ③ CHANGELOG 第一节（放在第一个 `## [` 之前） */
const changelogPath = join(REPO, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')
const at = changelog.indexOf('## [')
if (at < 0) {
  console.error('CHANGELOG 里找不到 `## [` 标题')
  process.exit(1)
}

const section = `## [${NEXT}] — 2026-10-06 · 能力探测（第一批：内核 + 自检）

> 按 \`docs/改造任务/多协议与中转站支持.md\` 的既有结论，Gemini 原生 / Anthropic /
> OpenAI Responses / 自定义鉴权头 / 代理都是**明确的「不做」**（理由当时写清了，不翻案）。
> 这一批只补台账里那条真缺口：\`Provider 能力 ⚠️ 部分 | 未做能力探测表\`。

### 这一批做了什么（**只做内核**，IPC 与界面在下一批）

- 新增 \`electron/core/model-probe.cjs\`：对「供应商 + 模型」发**最小请求**实测六件事 ——
  能不能回话、回的是不是 SSE、认不认工具调用、收不收图片、回不回 usage、模型名在不在 \`/models\` 清单里。
- 四条硬口径写死在文件头：**只影响提示、不改请求形状**；**只提示、不做硬门**；
  不自动改配置 / 不自动换模型；请求尽量小且可被中断。
- 失败或未知一律记 \`null\`（**未知 ≠ 不支持** —— 把未知画成不支持等于替用户猜了）。
- 流里带 \`{"error":…}\` 时**当场结束探测**，并把上游原话带出来
  （0.23.0 修过的「回答空白、不报错」是同一类坑）。
- 自检组 \`122-model-probe\`：37 项，**不联网** —— 探测函数支持注入假 fetch，
  「好模型 / 只有文本 / 名字打错 / 流里报错 / 网络挂」五种现场都能造出来。

### 还欠着（下一批）

- IPC + 设置页：把**实测**与现有的「声明与预设」（\`provider-capabilities.cjs\`）摆在一起，
  「声明说支持、实测不行」的当场指出来。
- 真机清单：一个支持工具的模型 + 一个纯文本模型 + 一个不收图的模型，看设置页结论对不对。

`

writeFileSync(changelogPath, `${changelog.slice(0, at)}${section}${changelog.slice(at)}`, 'utf8')
console.log(`${prev} → ${NEXT}：package.json / package-lock.json（两处）/ CHANGELOG.md 都改好了`)
