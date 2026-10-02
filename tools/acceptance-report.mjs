/**
 * 真机验收：**前置检查 + 汇总报告**
 *
 * 从 `acceptance.mjs` 拆出来的（那边到 378 行，硬约束 #2 = 300）：驱动只管
 * 「起应用、发消息、等结束」，这里管两件独立的事 —— 开跑之前的前置检查、跑完的汇总与退出码。
 *
 * 为什么要前置检查（2026-10-02 用户批准的「假红/假绿」方案第 ④ 条）：
 * 前置不成立时，整轮会白跑，或者更糟 —— **只读类用例照样判 ✅**（模型根本没跑起来）。
 * 那次「假绿」就是这么来的。所以宁可直接拒绝开始。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tally } from './acceptance-verdict.mjs'

/**
 * 启动应用**之前**能查的三条前置，返回「哪几条不成立」（空数组 = 可以开跑）。
 *
 * @param {{ data: string, sandbox: string }} ctx
 */
export function preflightBad({ data, sandbox }) {
  const bad = []
  try {
    const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
    const workdir = String(cfg?.general?.workdir ?? '')
    if (!workdir) bad.push('config.json 的 general.workdir 是空的（新建对话会弹原生选择框）')
    else if (resolve(workdir) !== resolve(sandbox)) bad.push(`general.workdir=${workdir} 不等于沙箱 ${sandbox}`)
  } catch (error) {
    bad.push(`读不到 config.json：${String(error.message).slice(0, 60)}`)
  }
  try {
    const cred = JSON.parse(readFileSync(join(data, 'credentials.json'), 'utf8'))
    if (cred?.backend !== 'safeStorage') bad.push(`credentials.json 的 backend=${cred?.backend}（不是 safeStorage）`)
    if (!Object.keys(cred?.entries ?? {}).length) bad.push('credentials.json 里没有任何凭证条目')
  } catch (error) {
    bad.push(`读不到 credentials.json：${String(error.message).slice(0, 60)}`)
  }
  if (!existsSync(join(data, 'chromium', 'Local State')))
    bad.push('缺 data/chromium/Local State（safeStorage 的密钥在里面）')
  return bad
}

/**
 * 打印汇总、落盘两份产物，返回退出码。
 *
 * 退出码规矩（方案第 ② 条）：**有 fail 或 unknown 都不是 0** ——
 * `unknown` 不代表被测对象错了，但绝不能拿它当一个 ✅ 用（假绿就是这么发生的）。
 *
 * @param {{ report: object[], root: string }} ctx
 */
export function summarize({ report, root }) {
  writeFileSync(join(root, 'acc-report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log('\n════════ 汇总 ════════')
  const by = {}
  for (const r of report) {
    by[r.任务] ??= { ok: 0, n: 0, u: 0, s: [] }
    by[r.任务].n += 1
    if (r.结局 === 'pass') by[r.任务].ok += 1
    if (r.结局 === 'unknown') by[r.任务].u += 1
    by[r.任务].s.push(r.耗时秒)
  }
  for (const [k, v] of Object.entries(by)) {
    const mark = v.ok === v.n ? '✅' : v.u > 0 ? '⚠️' : '❌'
    console.log(
      `${mark} ${k.padEnd(16)} ${v.ok}/${v.n}${v.u ? `（观测不到 ${v.u}）` : ''} · 平均 ${(v.s.reduce((a, b) => a + b, 0) / v.s.length).toFixed(1)}s`,
    )
  }

  /*
   * AG-053：含糊需求有没有触发澄清。
   * 判据是「≥ 2/3」，**不拿去改退出码** —— 这是模型的判断质量，不是硬闸：
   * 不到就回去改提示词（`CLARIFY_RULE`），而不是把澄清变成必走流程（那会卡住正常任务）。
   */
  const vague = report.filter((r) => r.含糊需求)
  if (vague.length > 0) {
    const hit = vague.filter((r) => r.澄清卡 > 0).length
    const ok = hit / vague.length >= 2 / 3
    console.log(
      `\n${ok ? '✅' : '⚠️'} 含糊需求触发澄清：${hit}/${vague.length}（判据 ≥ 2/3${ok ? '' : ' —— 没到，该去调 CLARIFY_RULE，别加硬闸'}）`,
    )
    for (const r of vague) console.log(`   ${r.澄清卡 > 0 ? '有卡' : '没问'} · ${r.任务} #${r.轮次} · ${r.验收}`)
    writeFileSync(
      join(root, 'acc-clarify.json'),
      JSON.stringify({ hit, total: vague.length, pass: ok, rows: vague }, null, 2),
      'utf8',
    )
  }

  const t = tally(report, '结局')
  console.log(`\n结局：过 ${t.pass} · 不过 ${t.fail} · 观测不到 ${t.unknown}（共 ${report.length} 轮）`)
  if (t.unknown > 0) {
    console.log(`⚠️ 有 ${t.unknown} 轮**判据没能观测到**（unknown）—— 既不算过也不算不过，退出码按非 0 处。`)
  }
  console.log(`总成功率 ${t.pass}/${report.length} = ${((t.pass / Math.max(1, report.length)) * 100).toFixed(0)}%`)
  return report.length > 0 && t.fail === 0 && t.unknown === 0 ? 0 : 1
}
