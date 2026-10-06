#!/usr/bin/env node
/* 交工前一站式：把「机器能跑的」全跑掉，并说清「剩下必须你自己做的」。
 *
 * 为什么要有它：钩子只覆盖 Node 侧（规范检查 + verify + 内核自检）。
 * 真机那一半还是靠记性 —— 而这个项目的两次事故（发不出消息、流式内容不更新）
 * **都过了 tsc、lint 和全部测试**，全出在真机那一半。
 *
 * 跑法：
 *   node scripts/preflight.mjs                  # verify + 应用自检（会闪一下窗口）
 *   node scripts/preflight.mjs --skip-app       # 只 verify（不想开窗口 / 没装 Electron）
 *   node scripts/preflight.mjs --acceptance     # 再加真机验收（真模型跑 5 类任务，会花 token）
 *
 * 它不是钩子的替代品：钩子拦「忘了跑」，它管「跑全」。
 */
import { runScript, step } from './lib/run.mjs'

const flags = new Set(process.argv.slice(2))
const skipApp = flags.has('--skip-app')
const withAcceptance = flags.has('--acceptance')
const done = []
const skipped = []

step('1/3 全链 verify（typecheck → lint → 格式 → 行数 → 单测 → 内核自检 → 构建）')
if (!runScript('verify')) {
  console.log('\n✗ verify 没过 —— 停在这里。哪一步红了就修哪一步，别绕过去。')
  process.exit(1)
}
done.push('verify（含内核自检）')

if (skipApp) {
  skipped.push('应用自检 npm run test:app（--skip-app）')
} else {
  step('2/3 应用自检（真 Electron 起来清点 IPC 通道，窗口会闪一下）')
  if (!runScript('test:app')) {
    console.log('\n✗ 应用自检没过 —— 看输出里的 channelsMissing。')
    console.log('  常见的：handler 注册块中间抛错 → 后面的通道**静默不注册**（窗口照开）。')
    process.exit(1)
  }
  done.push('test:app（channelsMissing 为空）')
}

if (withAcceptance) {
  step('3/3 真机验收（真模型跑 5 类任务，按产物判定成败 —— 会花 token）')
  if (!runScript('acceptance')) {
    console.log('\n✗ 验收没过 —— 看产物缺在哪一步。')
    process.exit(1)
  }
  done.push('acceptance（真机 5 类任务）')
}

console.log(`\n✓ 机器能查的都过了：${done.join(' · ')}`)
if (skipped.length) console.log(`! 跳过了：${skipped.join(' · ')}`)

console.log(`
────────────────────────────────────────────
还有几件**机器判不了**，按改了什么自己挑（AGENT.md 第 4 节）：

  改了 UI / 交互 / 权限 / 发送   → 真机走一遍：
        npm run shot:electron -- --exe=dist-portable/Harbor/Harbor.exe --js="..." --out=shots/xxx.png
        （隔离副本那套 tmp/sync-replica.cjs + tmp/perf/* 探针**已不在仓库**，别再照抄）
  改了会话 / 发送 / 流式         → 真发一条消息，看内容真的在动（别只看测试绿）
  改了性能                      → 改前 vs 改后的数字，没数字不算修好
  改了安全边界                  → 同步 docs/安全模型.md，含「这次没做什么」

一句话：**测试全绿 ≠ 能用。**
`)
