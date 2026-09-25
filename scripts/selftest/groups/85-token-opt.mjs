import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, ROOT, SANDBOX, require } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   Token 优化（2026-09-26）：分层诊断 / 指标口径 / 工具调度 / 模板 / 预算软阈值
   / 压缩版本 / 截断标记 / 结构化失败摘要 / 缓存字段合并

   规范：docs/Token优化实施与测试提示词.md
   这一组盯「口径」——数字对不对、缺数据时会不会装成 0；真机行为另有电池测试。
   ══════════════════════════════════════════════════════════════ */

const contextDiag = require(join(ROOT, 'electron/core/context-diag.cjs'))
const tokenMetrics = require(join(ROOT, 'electron/core/token-metrics.cjs'))
const scheduler = require(join(ROOT, 'electron/core/tool-scheduler.cjs'))
const templates = require(join(ROOT, 'electron/core/templates.cjs'))
const taskHint = require(join(ROOT, 'electron/core/task-hint.cjs'))
const budget = require(join(ROOT, 'electron/core/budget.cjs'))
const compact = require(join(ROOT, 'electron/core/compact.cjs'))
const shared = require(join(ROOT, 'electron/core/tools/_shared.cjs'))
const loopPrompt = require(join(ROOT, 'electron/core/loop-prompt.cjs'))
const loopModel = require(join(ROOT, 'electron/core/loop-model.cjs'))
const paths = require(join(ROOT, 'electron/core/paths.cjs'))

const layer = (id, title, content) => ({ id, title, content })

export async function run() {
  group('Token 优化 / 三层归属与 hash 稳定性')
  check('层归属：identity 稳定、memory 低频、time 动态', (() => {
    return (
      contextDiag.tierOf('coreIdentity') === 'stable' &&
      contextDiag.tierOf('relevantMemory') === 'low' &&
      contextDiag.tierOf('currentTime') === 'dynamic'
    )
  })())
  const layersA = [
    layer('coreIdentity', 'Core Identity', '你是 Agent。'),
    layer('conversationPolicy', 'Conversation Policy', '默认简体中文。'),
    layer('relevantMemory', 'Relevant Memory', '用户喜欢简洁。'),
    layer('currentTime', 'Current Time', '- 当前时间：2026-09-26 10:00:00'),
  ]
  const h1 = contextDiag.hashTiers(layersA)
  const h2 = contextDiag.hashTiers(layersA)
  check('同样内容 → 同样 hash（确定性）', h1.stablePrefixHash === h2.stablePrefixHash)
  const layersB = layersA.map((l) =>
    l.id === 'currentTime' ? { ...l, content: '- 当前时间：2026-09-26 10:00:01' } : l,
  )
  const h3 = contextDiag.hashTiers(layersB)
  check('只改动态层 → 稳定 hash 不变、动态 hash 变', h1.stablePrefixHash === h3.stablePrefixHash && h1.dynamicContextHash !== h3.dynamicContextHash)
  check('token 估算按层给出', (h1.contextTokensByLayer.coreIdentity ?? 0) > 0)
  const emptyDiag = contextDiag.diagnose(layersA, {})
  check('无 sessionId：不写快照、changed=false', emptyDiag.stablePrefixChanged === false)

  group('Token 优化 / 稳定前缀变化定位')
  const sid = 'selftest-tok-diag'
  const snap = join(paths.DIRS.chatCache, 'prompt-diag', `${sid}.json`)
  rmSync(snap, { force: true })
  contextDiag.diagnose(layersA, { sessionId: sid })
  const same = contextDiag.diagnose(layersA, { sessionId: sid })
  check('连续两次同样内容：stablePrefixChanged=false', same.stablePrefixChanged === false)
  const changed = contextDiag.diagnose(
    layersA.map((l) => (l.id === 'conversationPolicy' ? { ...l, content: '默认English。' } : l)),
    { sessionId: sid },
  )
  check(
    '改了稳定层 → 变且能定位到层名',
    changed.stablePrefixChanged === true && changed.stablePrefixChangeReason.includes('conversationPolicy'),
  )
  rmSync(snap, { force: true })

  group('Token 优化 / 缓存字段口径（不伪造）')
  const deepseek = tokenMetrics.cacheFields({ prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 })
  check('DeepSeek 字段：hit/miss 都取到', deepseek.hit === 800 && deepseek.miss === 200 && deepseek.source === 'deepseek-style')
  const openai = tokenMetrics.cacheFields({ prompt_tokens_details: { cached_tokens: 300 } })
  check('OpenAI 字段：只有 cached 也能取到', openai.hit === 300 && openai.miss === null)
  const none = tokenMetrics.cacheFields({ prompt_tokens: 100 })
  check('没有缓存字段 → hit/miss 均为 null（不填 0）', none.hit === null && none.miss === null && none.source === 'unavailable')
  check('hit/(hit+miss) 计算', tokenMetrics.hitRate(800, 200) === 0.8)
  check('缺 miss → 命中率 null（不造分母）', tokenMetrics.hitRate(800, null) === null)

  group('Token 优化 / 工具调度（并行批次 + 部分成功检测）')
  const ro = (name, path) => ({ id: name, name, args: { path } })
  const batches = scheduler.planBatches([
    ro('read_file', 'a.mjs'),
    ro('read_file', 'b.mjs'),
    { id: 'w', name: 'write_file', args: { path: 'c.mjs' } },
    ro('read_file', 'd.mjs'),
  ])
  check(
    '只读且不同目标 → 一批；写操作拆开',
    batches.length === 3 && batches[0].length === 2 && batches[1].length === 1 && batches[2].length === 1,
  )
  const sameTarget = scheduler.planBatches([ro('read_file', 'a.mjs'), ro('read_file', 'a.mjs')])
  check('同目标两次读 → 拆成两批（不并发同一文件）', sameTarget.length === 2)
  check('argsHash 稳定且区分参数', scheduler.argsHash('read_file', { path: 'a' }) === scheduler.argsHash('read_file', { path: 'a' }) && scheduler.argsHash('read_file', { path: 'a' }) !== scheduler.argsHash('read_file', { path: 'b' }))

  const fx = join(SANDBOX, 'tok-partial')
  writeFileSync(fx, 'before', 'utf8')
  const snapMap = scheduler.snapshotTargets([{ id: 'w1', name: 'write_file', args: { path: fx } }], { resolve: (p) => p })
  check('快照拿到修改前 hash', typeof snapMap.w1?.before === 'string' && snapMap.w1.before.length > 0)
  writeFileSync(fx, 'after-modified', 'utf8')
  const partial = scheduler.partialResultOf(snapMap, { id: 'w1', name: 'write_file' })
  check('文件被改动 → changed=true（部分成功）', partial?.changed === true)
  rmSync(fx, { force: true })

  group('Token 优化 / 任务模板（版本化 + 只建议）')
  const hit = templates.match('帮我修一下 calc 里的错误')
  check('命中 fix-bug 且带版本', hit?.id === 'fix-bug' && hit?.version === 1)
  const hint = templates.hintOf(hit)
  check('提示带 template id@version 且声明是建议', hint.includes('fix-bug@1') && hint.includes('建议'))
  check('不命中返回 null', templates.match('今天天气怎么样') === null)
  check('祈使否定不误命中：「改完不要跑测试」', templates.match('改完不要跑测试') === null)
  check('正面命中：「帮我跑一下测试」 → run-tests', templates.match('帮我跑一下测试')?.id === 'run-tests')

  group('Token 优化 / 模板注入守卫（TOK-P2-004：taskState 真机从不为空）')
  check('空 taskState → 视为新活', taskHint.isFreshTaskState('', '帮我跑一下测试') === true)
  check(
    'freshRequest 等值 → 新活（真机首轮就长这样）',
    taskHint.isFreshTaskState(taskHint.freshRequest('帮我跑一下测试'), '帮我跑一下测试') === true,
  )
  check(
    '带台账的 taskState → 不是新活',
    taskHint.isFreshTaskState('▶ [running] 修 bug\n  计划（0/2 完成）：', '帮我跑一下测试') === false,
  )
  const longGoal = `  ${'a'.repeat(260)}`
  check(
    '长文本两种修剪口径都认（chat 侧会先 slice 200）',
    taskHint.isFreshTaskState(taskHint.freshRequest(longGoal), longGoal) === true &&
      taskHint.isFreshTaskState(taskHint.freshRequest(longGoal.slice(0, 200)), longGoal) === true,
  )

  group('Token 优化 / 预算软阈值（80% 只提醒不阻断）')
  const plan = { ...budget.DEFAULTS, maxTokens: 1000, softRatio: 0.8 }
  const under = budget.atTurnBoundary({ plan, startedAt: 0, turn: 1, toolRuns: [], usage: { total_tokens: 500 } })
  check('50%：不软不超', under.exceeded === false && under.soft !== true)
  const over80 = budget.atTurnBoundary({ plan, startedAt: 0, turn: 1, toolRuns: [], usage: { total_tokens: 850 } })
  check('85%：soft=true 且未超过硬上限', over80.soft === true && over80.exceeded === false)
  const hard = budget.atTurnBoundary({ plan, startedAt: 0, turn: 1, toolRuns: [], usage: { total_tokens: 1200 } })
  check('120%：exceeded=true（硬上限照旧）', hard.exceeded === true)
  check('softNote 给出百分比与取舍指引', budget.softNote(over80).includes('85%') && budget.softNote(over80).includes('验证'))

  group('Token 优化 / 冻结摘要版本（不原地重写）')
  const hist = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
  const v1 = compact.rebuild(hist, '第一段摘要')
  check('第一次压缩 → v1', v1.some((m) => String(m.content).startsWith('【之前对话的摘要 v1】')))
  const v2 = compact.rebuild(v1, '第二段摘要')
  check('再压一次 → v2（版本递增、不覆盖 v1 的序号）', v2.some((m) => String(m.content).startsWith('【之前对话的摘要 v2】')))
  const legacy = compact.rebuild([{ role: 'user', content: '【之前对话的摘要】\n旧格式' }], '新一段')
  check('旧格式（无版本号）也计数 → v2', legacy.some((m) => String(m.content).startsWith('【之前对话的摘要 v2】')))

  group('Token 优化 / 截断标记（字段齐全）')
  const long = 'x'.repeat(3000)
  const cut = shared.truncateMiddle(long, 1000, '命令输出超出上限')
  check('标记含 omitted_chars / original_bytes / reason', cut.includes('omitted_chars=2000') && cut.includes('original_bytes=3000') && cut.includes('reason=命令输出超出上限'))
  check('短文本原样返回（不打扰）', shared.truncateMiddle('短', 100) === '短')
  const withLog = shared.truncateWithLog(long, 500, '测试截断')
  const m = withLog.match(/完整输出：([^）]+)/)
  check('超限时完整输出落盘且路径可见', m !== null && existsSync(m[1].trim()))
  if (m) rmSync(m[1].trim(), { force: true })

  group('Token 优化 / 结构化失败摘要（不重注全文）')
  const note = loopPrompt.buildFailureNote({
    done: ['read_file'],
    failed: [
      { name: 'edit_file', hint: '找不到这段原文', kind: 'file_changed', target: 'a.mjs', retryCount: 1, partial: { changed: true, created: false, path: 'C:/x/a.mjs' } },
    ],
  })
  check('含 error_kind / 目标 / retry_count', note.includes('error_kind=file_changed') && note.includes('目标=a.mjs') && note.includes('retry_count=1'))
  check('含部分成功警告', note.includes('部分修改') || note.includes('已被'))
  check('含「已完成的不必重做」', note.includes('不必重做'))

  group('Token 优化 / usage 合并保留缓存字段')
  const merged = loopModel.mergeUsage(
    { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
    { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 },
  )
  check('缓存命中/未命中跟着累计', merged.prompt_cache_hit_tokens === 210 && merged.prompt_cache_miss_tokens === 90)
  check('三个总数照旧', merged.prompt_tokens === 300 && merged.total_tokens === 330)
  const mergedPlain = loopModel.mergeUsage({ prompt_tokens: 1 }, { prompt_tokens: 2 })
  check('没有缓存字段时不凭空造字段', mergedPlain.prompt_cache_hit_tokens === undefined)

  group('Token 优化 / 预热默认关')
  const prewarm = require(join(ROOT, 'electron/core/prewarm.cjs'))
  const skipped = await prewarm.maybeRun()
  check('仓库默认配置：预热不发请求（skipped）', typeof skipped?.skipped === 'string')
}
