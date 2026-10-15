/**
 * 端到端验收：**真实** Edge → 扩展 → 已安装的 native host → 回 pong？
 *
 * 前置：先跑 install-host.cmd（要有注册表键 + 清单 + 包装器）。
 *
 * 判据来源是**扩展真实收到的消息**（service-worker.js 把每次 onMessage POST 到
 * 本地报告服务器），不是我们的推测 —— 这一点从 Phase 0 起就是这么做的。
 *
 * 用法（用 Harbor.exe 的 Node 模式跑，这样不依赖用户装 Node）：
 *   set ELECTRON_RUN_AS_NODE=1
 *   "<Harbor.exe>" "harbor-edge\tools\accept-host.cjs"
 */

const D = require('../lib/driver.cjs')

async function main() {
  const report = D.startReportServer()
  let edge = null
  let pong = null
  try {
    process.stdout.write('launching an isolated Edge with the extension loaded ...\n')
    edge = await D.launchEdge({ profileName: 'profile-accept', port: 9461 })

    const t0 = Date.now()
    while (Date.now() - t0 < 15000 && !pong) {
      await D.sleep(500)
      for (const r of report.reports) {
        if (r.stage === 'message' && r.msg && r.msg.pong) pong = r.msg
      }
    }
  } finally {
    if (edge) {
      D.killEdge(edge.child.pid)
      /* ★ 验收也用它自己那个 profile（15 MB）—— 跑完就删，不留垃圾 */
      await D.sleep(1500)
      D.removeProfile(edge.profile)
    }
    await report.close()
  }

  const stages = report.reports.map((r) => `${r.stage}${r.error ? `(${r.error})` : ''}`)
  process.stdout.write(`\nreports: ${report.reports.length}\n`)
  for (const line of stages) process.stdout.write(`  ${line}\n`)

  if (pong) {
    process.stdout.write(`\nPASS  got: ${JSON.stringify(pong)}\n`)
    return
  }
  process.stdout.write('\nFAIL  the extension never received a pong\n')
  const lastError = [...report.reports].reverse().find((r) => r.error)?.error
  if (lastError) process.stdout.write(`  last error: ${lastError}\n`)
  process.exit(1)
}

main().catch((error) => {
  process.stdout.write(`ERROR ${error.message}\n`)
  process.exit(1)
})
