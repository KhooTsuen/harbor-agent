/**
 * 前置：起一次隔离 Edge，读**真实扩展 ID**（清单 allowed_origins 必须用它）。
 *
 * 为什么不能靠路径算：Phase 0 实测 —— 按 Chromium 算法算得 doacoiidbmccehjb，
 * 实际是 fgiopdanmkafnmpcjiiofkbbgikmdljn。所以「加载一次、读回来」是唯一可靠办法。
 */

const { startReportServer, launchEdge, killEdge, sleep } = require('./lib/driver.cjs')

async function main() {
  const report = startReportServer()
  const edge = await launchEdge({ profileName: 'profile-extid', port: 9460 })
  const t0 = Date.now()
  let extId = null
  while (Date.now() - t0 < 15000 && !extId) {
    await sleep(500)
    const hit = report.reports.find((r) => r.extId)
    if (hit) extId = hit.extId
  }
  console.log('扩展真实 ID =', extId)
  console.log('报告条数 =', report.reports.length)
  console.log('前 6 条 =', JSON.stringify(report.reports.slice(0, 6), null, 1))
  killEdge(edge.child.pid)
  await report.close()
}

main().catch((e) => {
  console.log('ERR', e.message)
  process.exit(1)
})
