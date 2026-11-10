#!/usr/bin/env node
/*
 * 发布回归基线（第 20 项）—— **针对最终 Windows 便携包**的可重复验收入口。
 *
 * ── 它和 preflight 的分工 ────────────────────────────────────────
 *   `preflight.mjs`：交工前「机器能跑的都跑一遍」（源码树）。
 *   `release-baseline.mjs`（本文件）：**打包产物**发布前要过的那几道，按阶排好，
 *   每一阶写清「命令 / 期望结果 / 证据落在哪 / 过不了算不算阻断发布」。
 *
 * ── 为什么要单独一个文件 ──────────────────────────────────────
 * 发布前的检查散在 6 个脚本里（verify / test:app / security / release-check /
 * shot-electron / e2e-*），靠人记顺序必然漏。这里把它们按「能不能自动跑」分阶：
 *   自动阶（机器判得了）→ 半自动阶（要开窗口、要真模型）→ 人工阶（只有人能看）。
 *
 * ── 用法 ────────────────────────────────────────────────────
 *   node scripts/release-baseline.mjs              # 只打印计划，不执行任何东西
 *   node scripts/release-baseline.mjs --run=auto   # 真的跑「自动阶」
 *   node scripts/release-baseline.mjs --json       # 机器可读（给下一轮脚本吃）
 *
 * ⚠️ 默认是**只打印**。不带 `--run` 一律不执行，避免误跑真模型浪费 token。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..')
const args = new Set(process.argv.slice(2))
const runMode = [...args].find((a) => a.startsWith('--run='))?.slice(6) ?? ''
const asJson = args.has('--json')

/** 便携包位置（用户指定的两份；dev 是自举开发版） */
const PACKAGES = {
  portable: 'E:\\Harbor',
  dev: 'E:\\Harbor-Dev\\dist-portable\\Harbor',
  build: join(ROOT, 'dist-portable', 'Harbor'),
}

/**
 * 一阶 = 一道关。`tier`：
 *   auto  —— 机器判得了，能反复跑
 *   semi  —— 要开窗口 / 要真模型（本轮不跑）
 *   human —— 只有人能看（截图、手感）
 * `blocks` = 过不了**能不能发布**。数据损坏 / 安全 / 通道缺失一律阻断。
 */
const STAGES = [
  {
    id: 'verify',
    tier: 'auto',
    blocks: true,
    cmd: 'npm run verify',
    expect: '退出码 0（typecheck 0 错误 / lint 0 错误 / 行数全 ≤300 / 单测全过 / 内核自检 0 失败 / 构建成功）',
    evidence: '终端输出；内核自检末尾的「通过 N 项，失败 0 项」',
    why: '类型、行数、单测任一项红都说明源码不自洽',
  },
  {
    id: 'app-selftest',
    tier: 'auto',
    blocks: true,
    cmd: 'npm run test:app',
    expect: 'channelsOk: true 且 channelsMissing: []',
    evidence: '输出里的 JSON 尾行',
    why: 'handler 注册块中间抛错会让后面的通道静默不注册（窗口照开、只有打包自检看得见）',
  },
  {
    id: 'security',
    tier: 'auto',
    blocks: true,
    cmd: 'node scripts/security/run.mjs',
    expect: '退出码 0；SEC-002（原始 HTML 默认关）等阻断项全过',
    evidence: 'security 报告输出',
    why: '安全清单里的阻断项不是「建议」',
  },
  {
    id: 'release-check',
    tier: 'auto',
    blocks: true,
    cmd: 'node scripts/check-release.mjs',
    expect: '退出码 0',
    evidence: '终端输出',
    why: '版本号 / 清单 / 打包内容一致性',
  },
  {
    id: 'package',
    tier: 'auto',
    blocks: true,
    cmd: 'npm run package',
    expect: '打包完成；打印的主程序 / 主进程 / 界面等几项大小都正常',
    evidence: '终端输出 + dist-portable/Harbor 目录',
    why: '构建链本身不含测试，但产物完整性在这步才能看',
  },
  {
    id: 'payload-sync',
    tier: 'auto',
    blocks: true,
    cmd: 'node tmp/loadhash.cjs <app 目录>（两份分别算）',
    expect: '便携版与开发版的 manifestSha256 **相同**',
    evidence: '两份清单哈希 + 各自 app.bak-* 备份目录存在',
    why: '两版不一致 = 用户拿到的和你验过的不是同一份',
  },
  {
    id: 'desktop-smoke',
    tier: 'semi',
    blocks: true,
    cmd: 'npm run shot:electron -- --dev --js="..."',
    expect: '界面正常渲染：会话列表 / 对话区 / 输入框 / 过程入口都在，无布局错乱',
    evidence: 'shots/ 下的截图（人工看）',
    why: '测试全绿 ≠ 能用（项目里有两次教训：发不出消息、流式不更新）',
  },
  {
    id: 'real-model',
    tier: 'semi',
    blocks: true,
    cmd: '真发一条消息（或 npm run preflight -- --acceptance）',
    expect: '内容真的在动；工具调用、停止、继续都能走',
    evidence: '会话记录 + 截图',
    why: '真实模型行为无法用假上游代表',
  },
  {
    id: 'mcp-edge',
    tier: 'semi',
    blocks: false,
    cmd: '设置里连一个真实 MCP 服务器；Edge 侧栏配对一次',
    expect: 'MCP 每次调用都询问；Edge 侧栏能对话',
    evidence: '审计记录 + 截图',
    why: '第三方边界；本轮不具备条件时如实记「未运行」',
  },
  {
    id: 'migration',
    tier: 'semi',
    blocks: false,
    cmd: '用**旧数据副本**启动一次新包，核对会话 / 任务 / 设置 / 凭证都在',
    expect: '旧数据能读、能继续；失败可回退到旧包',
    evidence: '副本目录前后对比',
    why: '应用文件同步成功不代表旧数据迁移已验收',
  },
  {
    id: 'fault-injection',
    tier: 'semi',
    blocks: false,
    cmd: '恢复中途强杀进程 → 重启看是否认出「未完成」',
    expect: '启动日志出现 restore-in-progress 提示，指向 before-restore 快照',
    evidence: '日志 + data/restore-in-progress.json',
    why: '第 13 项的标记机制目前只有用例，没真杀过',
  },
  {
    id: 'visual',
    tier: 'human',
    blocks: false,
    cmd: '逐项看 A01–A26 的动效与交互',
    expect: '按对照表逐项勾',
    evidence: '截图 / 录屏',
    why: '动效只能人看',
  },
]

/** 本机实际有什么 —— 只是「看起来能跑」，不是「跑过」 */
function inventory() {
  const items = []
  for (const [key, dir] of Object.entries(PACKAGES)) {
    const exe = join(dir, 'Harbor.exe')
    const app = join(dir, 'resources', 'app')
    items.push({ key, dir, exe: existsSync(exe), app: existsSync(app) })
  }
  return items
}

const runnable = STAGES.filter((s) => s.tier === 'auto')

if (asJson) {
  console.log(JSON.stringify({ stages: STAGES, packages: inventory() }, null, 2))
  process.exit(0)
}

console.log('发布回归基线（第 20 项）\n')
console.log('本机产物：')
for (const p of inventory()) {
  console.log(`  ${p.key.padEnd(9)} ${p.dir}  exe=${p.exe ? '有' : '无'} app=${p.app ? '有' : '无'}`)
}

const tiers = [
  ['auto', '自动阶（机器判得了）'],
  ['semi', '半自动阶（要开窗口 / 真模型，本轮不跑）'],
  ['human', '人工阶（只有人能看）'],
]
let n = 0
for (const [tier, label] of tiers) {
  console.log(`\n=== ${label} ===`)
  for (const s of STAGES.filter((x) => x.tier === tier)) {
    n += 1
    console.log(`${n}. [${s.id}] ${s.blocks ? '**阻断发布**' : '不阻断'}`)
    console.log(`   命令：${s.cmd}`)
    console.log(`   期望：${s.expect}`)
    console.log(`   证据：${s.evidence}`)
  }
}

console.log(`\n共 ${STAGES.length} 关（自动 ${runnable.length} 关 / 阻断发布 ${STAGES.filter((s) => s.blocks).length} 关）`)

if (!runMode) {
  console.log('\n（默认只打印计划，什么都没执行。要跑自动阶：--run=auto）')
  process.exit(0)
}

if (runMode !== 'auto') {
  console.log(`\n✗ 不认识的 --run=${runMode}（只支持 auto）`)
  process.exit(2)
}

/* 真跑自动阶：顺序执行、一步红就停（后面的结果没有意义） */
for (const s of runnable) {
  console.log(`\n▶ [${s.id}] ${s.cmd}`)
  const res = spawnSync(s.cmd, { shell: true, stdio: 'inherit', cwd: ROOT })
  if (res.status !== 0) {
    console.log(`\n✗ [${s.id}] 没过（退出码 ${res.status}）—— 停在这里，后面的不跑`)
    process.exit(res.status ?? 1)
  }
  console.log(`✓ [${s.id}] 通过`)
}
console.log('\n自动阶全部通过。半自动阶与人工阶见上面清单，须下一轮执行。')
