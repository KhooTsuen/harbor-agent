import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '../../electron/core/redact.cjs'
import { DATA, saveJson } from './run.mjs'

const safe = (value) => redact(String(value ?? ''))
const row = (cells) => `| ${cells.map((x) => safe(x).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ')} |`

export function compare(run, previous) {
  if (!previous) return { available: false, regressions: [], gaps: [], slow: [] }
  const comparable = new Set(run.stages.filter((s) => {
    const p = previous.stages.find((x) => x.id === s.id)
    return p && (!p.sourceHash || !s.sourceHash || p.sourceHash === s.sourceHash)
  }).map((s) => s.id))
  const keyed = (stages) => stages.flatMap((s) => {
    const counts = new Map()
    return (s.items ?? []).map((x) => {
      const base = `${s.id}|${x.group}|${x.name}`
      const ordinal = counts.get(base) ?? 0
      counts.set(base, ordinal + 1)
      return [`${base}|${ordinal}`, x]
    })
  })
  const old = new Map(keyed(previous.stages))
  const now = new Map(keyed(run.stages))
  const regressions = [], gaps = [], slow = []
  for (const [key, item] of old) {
    if (item.status !== 'pass') continue
    if (!comparable.has(key.split('|')[0])) continue
    const next = now.get(key)
    if (next?.status === 'fail') regressions.push(key)
    else if (!next) gaps.push(key)
  }
  for (const s of run.stages) {
    if (!comparable.has(s.id)) continue
    const p = previous.stages.find((x) => x.id === s.id)
    if (p?.durationMs > 0 && s.durationMs >= 3 * p.durationMs && s.durationMs - p.durationMs >= 10_000) {
      slow.push({ id: s.id, before: p.durationMs, now: s.durationMs, factor: +(s.durationMs / p.durationMs).toFixed(1) })
    }
  }
  return { available: true, regressions, gaps, slow }
}

export function narrative(run, diff) {
  const fail = run.stages.filter((x) => x.status === 'FAIL_ASSERTION')
  const infra = run.stages.filter((x) => x.status === 'FAIL_INFRA')
  const suspect = run.stages.filter((x) => x.status === 'SUSPECT')
  const flaky = run.stages.filter((x) => x.status === 'FLAKY')
  const pending = run.stages.filter((x) => ['NEEDS_HUMAN', 'BLOCKED_ENV', 'NOT_RUN', 'NOT_APPLICABLE'].includes(x.status))
  const warnings = run.stages.filter((x) => x.warnings?.length)
  const complete = run.stages.length > 0 && !fail.length && !infra.length && !suspect.length && !flaky.length && !pending.length && !warnings.length
  const installedPartial = run.target.kind === 'installed' && run.stages.some((x) => x.id === 'installed-self-test' && x.status === 'PASS')
  const first = complete ? run.scope === 'all' ? '本次计划内检查全绿，可以继续使用当前被测版本。' : '本次选定的检查通过；整体可用性仍需结合全链和人工验收。' :
    fail.length ? `这次有 ${fail.length} 个阶段的判据失败，当前不能当作全绿。` :
      infra.length ? `这次有 ${infra.length} 个阶段没有正常测成，暂不能判断目标是否可用。` :
        flaky.length ? `这次有 ${flaky.length} 个真机脚本首次失败、复测通过；可以继续使用，但建议留意稳定性。` :
        installedPartial ? '安装版隔离自检通过；源码单测和 Edge 验收尚未覆盖这个安装包。' :
        '这次仍有未完成或结果可疑的检查，不能当作全绿。'
  return [
    first,
    `目标是 ${run.target.kind === 'source' ? '源码版' : '安装版隔离副本'}（${safe(run.target.path)}）。`,
    diff.available ? diff.regressions.length ? `与上次相比，${diff.regressions.length} 项确认退步。` : '与上次相比，没有可确认的退步。' : '还没有可比较的上次结果。',
    pending.length ? `另有 ${pending.length} 项未跑完或需要人操作。` : '计划中的阶段均已有结果。',
  ]
}

export function markdown(run, diff) {
  const lines = ['# Harbor 测试报告', '', ...narrative(run, diff).map((x) => `${x}  `), '']
  lines.push('## 1. 总体状态', '', '这次各部分的实际状态如下。', '', row(['阶段', '状态', '说明']), row(['---', '---', '---']))
  for (const s of run.stages) lines.push(row([s.id, s.status, s.reason || (s.passed === null ? '已执行，命令退出成功' : `${s.passed} 通过 / ${s.failed ?? '?'} 失败`)]))
  lines.push('', '## 2. 退步清单', '', diff.available ? diff.regressions.length ? '这些项目上次通过，这次失败。' : '没有可确认的退步。' : '没有可比较的上次结果。')
  for (const x of diff.regressions) lines.push(`- ${safe(x)}`)
  if (diff.gaps.length) lines.push('', `上次通过但本次没有运行到的项目：${diff.gaps.length} 项。`)
  const flaky = run.stages.filter((x) => x.status === 'FLAKY')
  lines.push('', '## 3. 真红与环境抖动', '', flaky.length ? `${flaky.length} 个脚本首次失败、复测通过，标为环境抖动；首次失败证据已保留。` : '没有发现复测后通过的环境抖动。')
  const fails = run.stages.filter((x) => x.status.startsWith('FAIL'))
  for (const s of fails) lines.push(`- ${safe(s.id)}：${s.status === 'FAIL_INFRA' ? '执行环境或脚本启动异常，这次没测成' : s.attempts?.length === 2 ? '两次判据都失败，确认为真红' : '判据失败，未完成复测'}；${safe(s.reason || '详见证据目录')}。`)
  if (!fails.length) lines.push('- 本次没有失败阶段。')
  if (flaky.length) lines.push(`- 环境抖动：${flaky.length} 个。`)
  lines.push('', '## 4. 可疑信号', '', '判据可能已经通过，但这些信号会降低结果或历史比较的可信度。')
  const sus = run.stages.filter((x) => x.status === 'SUSPECT' || x.warnings?.length)
  if (!sus.length) lines.push('- 未检测到可疑信号；包装器无法证明既有判据不存在硬编码真值。')
  for (const s of sus) lines.push(`- ${safe(s.id)}：${safe([...new Set([s.reason, ...(s.warnings ?? [])].filter(Boolean))].join('；'))}`)
  lines.push('', '## 5. 需要你手动做的事', '', '以下事项本次没有自动完成。')
  const manual = run.stages.filter((x) => ['NEEDS_HUMAN', 'BLOCKED_ENV', 'NOT_APPLICABLE'].includes(x.status))
  if (!manual.length) lines.push('- 无。')
  for (const s of manual) lines.push(`- ${safe(s.id)}：${safe(s.reason)}`)
  lines.push('', '## 6. 耗时异常', '', diff.available ? '已将本次耗时与上次可比运行作了对照。' : '没有可比较的上次耗时。')
  if (diff.available && !diff.slow.length) lines.push('- 未发现达到阈值的耗时异常。')
  for (const s of diff.slow) lines.push(`- ${safe(s.id)}：${Math.round(s.before / 1000)} 秒 → ${Math.round(s.now / 1000)} 秒，约 ${s.factor} 倍。`)
  lines.push('', run.stages.some((x) => x.status !== 'PASS' || x.warnings?.length) ? '接下来先核对失败、可疑和未跑的阶段，再判断能否使用该版本。' : '接下来可以按原计划继续开发；发布前仍需完成真实使用验收。', '')
  return lines.join('\n')
}

export function readBaseline(target) {
  const file = join(DATA, 'history', `${target.kind}-${target.scope}.json`)
  try { const x = JSON.parse(readFileSync(file, 'utf8')); return x.target.id === target.id && x.scope === target.scope ? x : null } catch { return null }
}

export function readPrevious(target) {
  const file = join(DATA, 'history', `${target.kind}-${target.scope}-previous.json`)
  try { const x = JSON.parse(readFileSync(file, 'utf8')); return x.target.id === target.id && x.scope === target.scope ? x : null } catch { return null }
}

export function writeReport(run, html = false) {
  const prior = readBaseline({ ...run.target, scope: run.scope })
  const diff = compare(run, prior)
  const md = markdown(run, diff)
  saveJson(join(run.dir, 'run.json'), { ...run, diff })
  writeFileSync(join(run.dir, 'report.md'), md, 'utf8')
  if (html) {
    const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    writeFileSync(join(run.dir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Harbor 测试报告</title><style>body{max-width:70rem;margin:2rem auto;font:16px/1.6 system-ui;color:#e8edf4;background:#101720}pre{white-space:pre-wrap}</style><pre>${escape(md)}</pre>`, 'utf8')
  }
  if (prior) saveJson(join(DATA, 'history', `${run.target.kind}-${run.scope}-previous.json`), prior)
  saveJson(join(DATA, 'history', `${run.target.kind}-${run.scope}.json`), run)
  return { md, diff }
}
