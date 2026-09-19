import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-037：性能 Profiler

   文档要的数：TTFT / LLM Latency / Tool Latency / Search Latency /
   Context Build Time / Render Time / Total Task Time。

   审计下来，六个时刻里 TTFT 与 Total **早就有**（AG-003 的 `metrics.cjs`），
   缺的是「中间那段花在哪」—— 所以这一组盯三件事：

     · 分段计时攒得对（按 traceId 归桶，取走即清、只算一次）
     · 工具/搜索**从现成的事件里收**（`agent.tool.completed` 的 `ms`）——
       不用再去工具里插一遍埋点，少一处就少一处漏
     · 收尾时拼进同一条时间线，并且留得住「最近几次」（界面要对比）

   Render Time 在渲染层测（主进程根本测不到「画上去没有」），
   那一半在前端测试里。
   ══════════════════════════════════════════════════════════════ */

const perf = require(join(ROOT, 'electron/core/perf-marks.cjs'))
const metrics = require(join(ROOT, 'electron/core/metrics.cjs'))

export async function run() {
  /* ── ① 分段计时 ─────────────────────────────────────── */
  group('AG-037 / 分段计时')
  const t = 'trace_ag037'
  perf.mark(t, 'context', 120)
  perf.mark(t, 'llm', 1000)
  perf.mark(t, 'llm', 2000)
  perf.markTool(t, 'read_file', 300)
  perf.markTool(t, 'search_web', 800)
  perf.markTool(t, 'run_shell', 200)

  const taken = perf.take(t)
  check('上下文耗时累加', taken.contextMs === 120, String(taken.contextMs))
  check('模型耗时是各次之和', taken.llmMs === 3000, String(taken.llmMs))
  check('模型调用次数', taken.llmCalls === 2)
  check('★ 单次最慢（重试/降级那种要看得出来）', taken.llmMaxMs === 2000, String(taken.llmMaxMs))
  check('★ 搜索单独一桶，不混进工具', taken.toolMs === 500 && taken.toolCalls === 2)
  check('搜索次数与耗时', taken.searchMs === 800 && taken.searchCalls === 1)
  check('★ 取走即清（同一轮不会算两遍）', perf.take(t).llmMs === 0)
  check('没记过的 traceId 也给一份零值', perf.take('没记过').contextMs === 0)
  check(
    '非法值不进桶（NaN / 负数）',
    (() => {
      perf.mark('t2', 'llm', Number.NaN)
      perf.mark('t2', 'llm', -5)
      return perf.take('t2').llmCalls === 0
    })(),
  )
  check(
    '哪个工具算搜索是内核定的',
    perf.isSearchTool('search_web') && !perf.isSearchTool('read_file'),
  )

  /* ── ② 拼进时间线 ───────────────────────────────────── */
  group('AG-037 / 拼进时间线')
  const trace = 'trace_ag037_report'
  metrics.begin(trace, { requestTime: Date.now() - 5000, at: Date.now() - 5000 })
  metrics.observe(trace, { type: 'task' })
  metrics.observe(trace, { type: 'content', text: '第一个字' })
  metrics.observe(trace, { type: 'agent.tool.started', name: 'read_file' })
  metrics.observe(trace, { type: 'agent.tool.completed', name: 'read_file', ms: 250 })
  metrics.observe(trace, { type: 'agent.tool.completed', name: 'search_web', ms: 700 })
  perf.mark(trace, 'context', 90)
  perf.mark(trace, 'llm', 1500)

  const report = metrics.finish(trace)
  check(
    '时间线里有 TTFT（AG-003 原有的）',
    typeof report.ttftMs === 'number',
    String(report.ttftMs),
  )
  check('时间线里有总时长', typeof report.totalMs === 'number' && report.totalMs >= 0)
  check(
    '★ 分段耗时被拼了进来',
    report.contextMs === 90 && report.llmMs === 1500,
    JSON.stringify(report.llmMs),
  )
  check('★ 工具耗时从事件里收（工具那次 250）', report.toolMs === 250, String(report.toolMs))
  check(
    '★ 搜索单独一段（那次 700）',
    report.searchMs === 700 && report.searchCalls === 1,
    String(report.searchMs),
  )
  check('工具不含搜索那次', report.toolCalls === 1, String(report.toolCalls))
  check(
    '没有分段数据时给 0 而不是 undefined（界面少写一堆判空）',
    metrics.begin('trace_empty', { at: Date.now() }) &&
      (() => {
        metrics.observe('trace_empty', { type: 'agent.completed' })
        const empty = metrics.finish('trace_empty')
        return empty.contextMs === 0 && empty.llmCalls === 0 && empty.searchMs === 0
      })(),
  )

  /* ── ③ 最近几次 ─────────────────────────────────────── */
  group('AG-037 / 最近几次')
  metrics.clear()
  for (let i = 0; i < 3; i += 1) {
    const id = `trace_r${i}`
    metrics.begin(id, { at: Date.now() })
    metrics.observe(id, { type: 'agent.completed' })
    metrics.finish(id)
  }
  const list = metrics.list({ limit: 2 })
  check('取最近 2 条', list.length === 2, String(list.length))
  check(
    '★ 新的在前（界面直接显示第一条）',
    list[0]?.traceId === 'trace_r2',
    String(list[0]?.traceId),
  )
  check('上限截得住', metrics.list({ limit: 999 }).length === 3)
  metrics.clear()
  check('clear 之后干净（自检之间不互相影响）', metrics.list().length === 0)

  /* ── ④ 接线 ─────────────────────────────────────────── */
  group('AG-037 / 接线（埋点真的埋了）')
  /*
   * 埋点放在**干活的模块自己**里（上下文构建在 loop-prompt、模型调用在 loop-model）——
   * loop.cjs 贴 300 行上限，而且「谁干活谁计时」本来就更顺。
   */
  const promptSrc = readFileSync(join(ROOT, 'electron/core/loop-prompt.cjs'), 'utf8')
  check('★ 上下文构建处有埋点', promptSrc.includes("perfMarks.mark(traceId, 'context'"))
  const modelSrc = readFileSync(join(ROOT, 'electron/core/loop-model.cjs'), 'utf8')
  check('★ 模型调用处有埋点', modelSrc.includes("perfMarks.mark(traceId, 'llm'"))
  check('★ 模型埋点在 finally 里（重试/报错那条路也要记上）', modelSrc.includes('} finally {'))
  /*
   * ★ 埋点时顺手逮到的一条真 bug：callModel 里一直写着 `emit?.({type:'retry'…})`、
   *   降级提示、上下文超限提示 —— 而**调用方从来没把 emit 传进去**，那些提示在
   *   界面上从未出现过（AG-016 明说「不能默默换模型继续」）。
   *   修法是把 emit 传下去；这条断言钉住「传了」。
   */
  const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
  check(
    '★ 调模型时把 emit 传下去了（重试/降级界面才看得见）',
    loopSrc.includes('traceId: traceKey(options),') && loopSrc.includes('      emit,'),
  )
  const metricsSrc = readFileSync(join(ROOT, 'electron/core/metrics.cjs'), 'utf8')
  check('★ 工具耗时从事件里收（不用改工具层）', metricsSrc.includes('perfMarks.markTool('))
  check('收尾时把分段拼进报告', metricsSrc.includes('perfMarks.take(key)'))
  const channels = readFileSync(join(ROOT, 'electron/ipc-channels.cjs'), 'utf8')
  check('通道清单里有 metrics:recent', channels.includes("'metrics:recent'"))
  const handlers = readFileSync(join(ROOT, 'electron/handlers/safety.cjs'), 'utf8')
  check('handler 注册了', handlers.includes("ipcMain.handle('metrics:recent'"))
  const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8')
  check('preload 暴露了 metricsRecent', preload.includes('metricsRecent:'))
}
