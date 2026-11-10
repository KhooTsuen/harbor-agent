const { scrubStorage } = require('./redact.cjs')
const { fingerprint } = require('./history-fold.cjs')
const { replayToolRuns } = require('./session-replay.cjs')

/** The kernel supplies this closure; models cannot select a session or execution. */
function readLive(args, context) {
  if (typeof context?.recallEvidence !== 'function') return null
  const scope = context.recallEvidence()
  if (!scope) return { text: '当前执行的证据上下文已结束，不能回取其他执行的记录。', ok: false }
  for (const key of ['n', 'offset', 'limit'])
    if (args?.[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < (key === 'n' ? 1 : 0)))
      return { ok: false, text: '回取序号、偏移和数量必须是有效整数。' }
  const runs = scrubStorage(scope.runs ?? [])
  const fpOf = run => fingerprint(String(replayToolRuns({ content: '' }, [run], 'recall')[1]?.content ?? ''))
  const matching = runs.filter(run => (!args?.tool || run.name === args.tool) &&
    (!args?.query || String(run.output ?? '').includes(String(args.query))))
  if (args?.callId || args?.fp || args?.n) {
    const hits = args.callId ? runs.filter(run => run.id === args.callId)
      : args.fp ? runs.filter(run => fpOf(run) === String(args.fp).trim().toLowerCase()) : [runs.at(-Number(args.n))].filter(Boolean)
    if (hits.length !== 1) return { ok: false, text: '未找到唯一工具记录，请按当前执行目录中的 callId 回取；不能据此认定工具没有执行。' }
    const run = hits[0]
    if (run.pending) return { ok: false, text: `工具 ${run.id} 尚未结束，正文待确认。` }
    const raw = String(run.output ?? '')
    const offset = Math.min(raw.length, Math.max(0, Math.floor(Number(args.offset) || 0)))
    const limit = Math.min(12000, Math.max(200, Math.floor(Number(args.limit) || 4000)))
    const end = Math.min(raw.length, offset + limit)
    return { ok: true, text: `来源：当前执行 ${scope.executionId} · callId=${run.id} · ${run.name} · ${run.ok ? '执行成功' : '执行失败'}\n` +
      `本次返回：偏移 ${offset}-${end} / 共 ${raw.length} 字\n工具参数：${JSON.stringify(run.args ?? {}).slice(0, 1600)}\n\n` +
      raw.slice(offset, end) + (end < raw.length ? `\n\n继续：recall({"callId":${JSON.stringify(run.id)},"offset":${end}})` : '') }
  }
  const limit = Math.min(60, Math.max(1, Math.floor(Number(args?.limit) || 20)))
  const recent = matching.slice(-limit)
  return { ok: true, text: `当前执行 ${scope.executionId}：${runs.length} 个独立工具调用，匹配 ${matching.length} 个。以下为实时证据，不依赖会话落盘。\n` +
    recent.map(run => `callId=${run.id} · ${run.name} · ${run.pending ? '待确认' : run.ok ? '执行成功' : '执行失败'} · ${String(run.output ?? '').length} 字`).join('\n') +
    (recent.length ? '\n按 callId 分页回取完整正文；目录与摘要未显示的内容不等于不存在。' : '\n当前范围未命中；不能据此认定历史记录或未检索范围内没有证据。') }
}

module.exports = { readLive }
