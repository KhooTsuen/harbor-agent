/**
 * 渲染：把扫描结果打成「人看得懂」的文本，或 Markdown 报告。
 * 单独一个文件的原因：排版规则（分组、缩进、摘要）和「怎么扫」是两件事。
 */
const SEV_ORDER = ['P0', 'P1', 'P2', 'P3']
const SEV_LABEL = { P0: 'P0 阻塞（必须人处理）', P1: 'P1 严重', P2: 'P2 一般（系统会自己重试）', P3: 'P3 轻微 / 非故障' }

const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

const kv = (obj, keys) =>
  keys
    .filter((k) => obj?.[k] !== undefined && obj[k] !== null && obj[k] !== '')
    .map((k) => `${k}=${typeof obj[k] === 'string' ? obj[k] : JSON.stringify(obj[k])}`)
    .join(' ')

export function renderText(result, { limit = 20 } = {}) {
  const out = []
  if (!result.ok) return `✗ ${result.reason}`

  const { stats } = result
  out.push(`发现 ${stats.real} 条错误（去重后 ${stats.unique} 条）· 窗口从 ${fmtTime(result.since)} 起`)
  out.push(
    `扫描：${stats.raw} 条原始记录 → 过滤噪音 ${result.noise.count} 条 / 按设计拒绝 ${stats.denied} 条 / 真错误 ${stats.real} 条` +
      `（耗时 ${stats.elapsedMs} ms）`,
  )
  if (!result.classifierAvailable) out.push('⚠ 内核分类器不可用（electron/core/errors.cjs 读不到）—— 分类全部退化成了 unknown')
  if (stats.warnCount) out.push(`（另有 ${stats.warnCount} 条 WARN、${stats.retries ?? 0} 次重试未计入「错误」——见下）`)

  if (result.retries?.length) {
    out.push(`\n重试记录（不是错误，是系统自己恢复过）：共 ${stats.retries} 次 / ${result.retries.length} 种`)
    for (const e of result.retries.slice(0, 5)) {
      out.push(`  ×${e.count}　${e.message.slice(0, 120)}　← ${e.location}`)
    }
  }

  for (const sev of SEV_ORDER) {
    const list = result.entries.filter((e) => e.severity === sev)
    if (!list.length) continue
    const total = list.reduce((n, e) => n + e.count, 0)
    out.push(`\n${SEV_LABEL[sev]}　${total} 条 / ${list.length} 种`)
    for (const e of list.slice(0, limit)) {
      out.push(`  [${fmtTime(e.lastSeen)}] ${e.kind}${e.count > 1 ? ` ×${e.count}` : ''}`)
      out.push(`    ${e.message.replace(/\s+/g, ' ').slice(0, 180)}`)
      const ctx = kv(e.context, ['taskId', 'sessionId', 'tool', 'eventType', 'step', 'status'])
      out.push(`    来源：${e.source} · 位置：${e.location}${ctx ? ` · ${ctx}` : ''}`)
      if (e.hint) out.push(`    建议：${e.hint}`)
      if (e.lowTrust) out.push(`    ⚠ 可信度低：${e.lowTrust}`)
      /* 只有非 unknown 才说「需要人处理」：unknown 的意思是「分类器认不出」，
         内核分类器对它保守地返回 needsUser=true，照抄就会把「认不出」说成「阻塞」 */
      if (e.needsUser && e.kind !== 'unknown') out.push('    ⚠ 需要人处理（系统不会自己恢复）')
      if (e.kind === 'unknown') out.push('    · 分类器认不出这条 —— 用 --json 或 --noise 看原文再判断')
    }
    if (list.length > limit) out.push(`  …还有 ${list.length - limit} 种（用 --limit 调大）`)
  }

  if (result.denied.length) {
    out.push(`\n（以下 ${stats.denied} 条是**按设计拒绝**，不是故障 —— 安全机制在正常工作）`)
    for (const e of result.denied.slice(0, 5)) out.push(`  ${e.message.slice(0, 120)}　← ${e.location}`)
  }

  if (result.noise.count) {
    out.push(`\n被当作噪音过滤掉的 ${result.noise.count} 条（原因分布，用 --noise 看明细）：`)
    for (const [reason, n] of Object.entries(result.noise.byReason).sort((a, b) => b[1] - a[1])) {
      out.push(`  ${n}×  ${reason}`)
    }
  }

  const top = [...result.entries].sort((a, b) => b.count - a.count).slice(0, 5).filter((e) => e.count > 1)
  if (top.length) {
    out.push('\n出现最频繁：')
    for (const e of top) {
      /* 带上位置：不带的话两条不同位置的同类消息看起来完全一样（像重复条目） */
      out.push(`  ${e.count}×  [${e.kind}] ${e.message.replace(/\s+/g, ' ').slice(0, 100)}　← ${e.location}`)
    }
  }
  return out.join('\n')
}

export function renderMarkdown(result, { limit = 50 } = {}) {
  const { stats } = result
  const out = []
  out.push('# Harbor 错误报告', '')
  out.push(`- 生成时间：${fmtTime(Date.now())}`)
  out.push(`- 统计窗口：${fmtTime(result.since)} 起`)
  out.push(`- 数据目录：\`${result.dataDir}\``)
  out.push(`- 内核分类器：${result.classifierAvailable ? '可用' : '**不可用**（分类退化为 unknown）'}`, '')
  out.push('## 总览', '')
  out.push('| 指标 | 数值 |', '|---|---|')
  out.push(`| 原始记录 | ${stats.raw} |`)
  out.push(`| 真错误（含重复） | ${stats.real} |`)
  out.push(`| 真错误（去重后） | ${stats.unique} |`)
  out.push(`| 过滤掉的噪音 | ${result.noise.count} |`)
  out.push(`| 按设计拒绝（非故障） | ${stats.denied} |`)
  out.push(`| 扫描耗时 | ${stats.elapsedMs} ms |`, '')

  out.push('## 按严重性', '')
  out.push('| 严重性 | 条数 |', '|---|---|')
  for (const sev of SEV_ORDER) out.push(`| ${SEV_LABEL[sev]} | ${stats.bySeverity[sev] ?? 0} |`)
  out.push('')

  out.push('## 按分类', '')
  out.push('| 分类 | 条数 |', '|---|---|')
  for (const [kind, n] of Object.entries(stats.byKind).sort((a, b) => b[1] - a[1])) out.push(`| ${kind} | ${n} |`)
  out.push('')

  out.push('## 按来源', '')
  out.push('| 来源 | 条数 |', '|---|---|')
  for (const [src, n] of Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])) out.push(`| ${src} | ${n} |`)
  out.push('')

  const top = [...result.entries].sort((a, b) => b.count - a.count).slice(0, 5)
  out.push('## TOP 5 高频错误', '')
  if (!top.length) out.push('（窗口内没有错误）')
  for (const [i, e] of top.entries()) {
    out.push(`${i + 1}. **${e.count}×** \`${e.kind}\` ${e.message.replace(/\s+/g, ' ').slice(0, 160)}`)
    out.push(`   - 位置：\`${e.location}\` · 最近：${fmtTime(e.lastSeen)}`)
  }
  out.push('')

  out.push('## 明细', '')
  for (const sev of SEV_ORDER) {
    const list = result.entries.filter((e) => e.severity === sev)
    if (!list.length) continue
    out.push(`### ${SEV_LABEL[sev]}`, '')
    for (const e of list.slice(0, limit)) {
      out.push(`- **${e.kind}**${e.count > 1 ? ` ×${e.count}` : ''}　${e.message.replace(/\s+/g, ' ').slice(0, 200)}`)
      out.push(`  - 来源 \`${e.source}\` · 位置 \`${e.location}\` · 最近 ${fmtTime(e.lastSeen)}`)
      if (e.lowTrust) out.push(`  - ⚠ ${e.lowTrust}`)
    }
    out.push('')
  }

  if (result.noise.count) {
    out.push('## 被过滤的噪音（原因分布）', '')
    for (const [reason, n] of Object.entries(result.noise.byReason).sort((a, b) => b[1] - a[1])) out.push(`- ${n}× ${reason}`)
    out.push('')
  }
  if (stats.denied) {
    out.push('## 按设计拒绝（不是故障）', '')
    for (const e of result.denied.slice(0, 20)) out.push(`- ${e.message.replace(/\s+/g, ' ').slice(0, 160)}　\`${e.location}\``)
    out.push('')
  }
  return out.join('\n')
}
