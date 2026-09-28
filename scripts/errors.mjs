#!/usr/bin/env node
/**
 * Harbor 错误观测工具（CLI）—— **只识别、只分类、只展示**。
 *
 * 它不修任何东西、不改任何现有行为，也**不往 data/ 里写东西**（`--export` 拒绝写进 data/）。
 *
 * 用法：
 *   node scripts/errors.mjs                      最近 24 小时
 *   node scripts/errors.mjs --since=7d           最近 7 天
 *   node scripts/errors.mjs --severity=P0,P1     只看严重
 *   node scripts/errors.mjs --category=network   只看某类（内核分类器的 kind）
 *   node scripts/errors.mjs --source=audit       只看某个来源
 *   node scripts/errors.mjs --json               给程序读
 *   node scripts/errors.mjs --export=report.md   导出 Markdown
 *   node scripts/errors.mjs --noise              连噪音一起看（排查过滤规则时用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { scan, parseSince } from './scan-errors.mjs'
import { renderText, renderMarkdown } from './errors/render.mjs'

const arg = (name, fallback = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`)
const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null)

const ROOT = path.resolve(import.meta.dirname, '..')
const dataDir = path.resolve(arg('data', path.join(ROOT, 'data')))

function main() {
  let since
  try {
    since = parseSince(arg('since'))
  } catch (e) {
    console.error(`✗ ${e.message}`)
    return 2
  }

  const result = scan({ dataDir, since })
  if (!result.ok) {
    console.error(`✗ ${result.reason}`)
    console.error('  （这个工具只读 data/；如果你的数据在别处，用 --data=<路径> 指过去）')
    return 1
  }

  /* 筛选 */
  const sev = csv(arg('severity'))
  const cat = csv(arg('category'))
  const src = csv(arg('source'))
  const limit = Number(arg('limit', '20'))
  let entries = result.entries
  if (sev) entries = entries.filter((e) => sev.includes(e.severity))
  if (cat) entries = entries.filter((e) => cat.includes(e.kind))
  if (src) entries = entries.filter((e) => src.includes(e.source))
  const filtered = { ...result, entries }

  if (flag('json')) {
    /* --json：只给结构化数据，不再夹人类的排版 */
    const payload = {
      generatedAt: new Date().toISOString(),
      dataDir,
      since: new Date(since).toISOString(),
      classifierAvailable: result.classifierAvailable,
      stats: result.stats,
      noise: result.noise,
      denied: result.denied,
      errors: entries.map((e) => ({
        severity: e.severity,
        kind: e.kind,
        source: e.source,
        count: e.count,
        firstSeen: new Date(e.firstSeen).toISOString(),
        lastSeen: new Date(e.lastSeen).toISOString(),
        message: e.message,
        location: e.location,
        context: e.context,
        recoverable: e.retryable,
        needsUser: e.needsUser,
        lowTrust: e.lowTrust,
      })),
    }
    console.log(JSON.stringify(payload, null, 2))
    return 0
  }

  if (flag('noise')) {
    console.log(`噪音明细（前 ${Math.min(limit, result.noise.samples.length)} 条样本）：`)
    for (const n of result.noise.samples) console.log(`  [${n.source}] ${n.reason}　${String(n.message).slice(0, 120)}`)
    console.log('')
  }

  const text = renderText(filtered, { limit })
  console.log(text)

  const exportTo = arg('export')
  if (exportTo) {
    const target = path.resolve(exportTo)
    /* 铁律：不往 data/ 里写东西（那是用户的数据目录，只读） */
    if (target.startsWith(path.resolve(dataDir) + path.sep)) {
      console.error(`\n✗ 拒绝写入 data/ 目录（${target}）—— 这个工具只读数据目录。换个路径，比如 docs/ 或 tmp/`)
      return 2
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, renderMarkdown(filtered, { limit: 50 }), 'utf8')
    console.log(`\n✓ 已导出 Markdown：${target}`)
  }
  return 0
}

process.exitCode = main()
