import { join, readFileSync, require, ROOT, rmSync } from '../env.mjs'
import { check, group } from '../harness.mjs'
import fs from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   真实用量采集（2026-11-07 · 第 6 项第一阶段）

   钉的是「账上那个数字到底从哪来」，四条底线：
     ① **只认上游报的**：没给就是 null + known:false，不许用本地估算补。
     ② **每次真发都记**：重试的中间几次也在账上，漏记会让消耗比真实少。
     ③ **三类分得开**：known+数字 / known+0 / unknown+null。
        以前统一 `Number(x) || 0`，第三种被写成 0，冒充「确认消耗 0」。
     ④ **没有真金额就不生成费用**：定价表算的是「预估」，永不写进这一层。
   ⚠️ 全部在隔离数据根里造合成数据，跑完把本组写的行撤回。
   ══════════════════════════════════════════════════════════════ */

const metrics = require(join(ROOT, 'electron/core/token-metrics.cjs'))
const LM = join(ROOT, 'electron/core/loop-model.cjs')

const countRows = () => {
  try {
    return readFileSync(metrics.file(), 'utf8').trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}
/** 只读这一次新增的行（别让历史记录影响判据） */
const rowsSince = (offset) => {
  try {
    return readFileSync(metrics.file(), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(offset)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

export async function run() {
  const before = countRows()

  try {
    /* ══ ① 上游给了 usage：原样入账 ══════════════════════════════ */
    group('真实用量 / ① 上游给了什么就记什么')
    let mark = countRows()
    metrics.logAttempt({
      entry: 'api', providerId: 'deepseek', model: 'deepseek-chat', sessionId: 'sess_a',
      trace: 'req_a', taskId: 'task_a', outcome: 'ok', ttftMs: 210, latencyMs: 900,
      usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 },
    })
    let rows = rowsSince(mark)
    check('★★ 一次调用 → 一行账', rows.length === 1, `${rows.length} 行`)
    check(
      '★★ 三个数字与上游一致（不加工、不四舍五入）',
      rows[0]?.prompt === 1200 && rows[0]?.completion === 340 && rows[0]?.total === 1540,
      JSON.stringify({ p: rows[0]?.prompt, c: rows[0]?.completion, t: rows[0]?.total }),
    )
    check('★ known=true（这行数字可信）', rows[0]?.known === true)
    check(
      '★ provider / model / 入口类型都记了（界面按这三样分组）',
      rows[0]?.providerId === 'deepseek' && rows[0]?.model === 'deepseek-chat' && rows[0]?.entry === 'api',
      `${rows[0]?.providerId} / ${rows[0]?.model} / ${rows[0]?.entry}`,
    )
    check(
      '★ 会话 / 任务 / 运行实例三个 id 都记、互不替代',
      rows[0]?.sessionId === 'sess_a' && rows[0]?.taskId === 'task_a' && rows[0]?.trace === 'req_a',
    )
    check('★ 记了时间（能按天聚合）+ 延迟', Number(rows[0]?.at) > 0 && rows[0]?.latencyMs === 900)

    /* ══ ② 没给 usage：标未知，绝不补造 ══════════════════════════ */
    group('真实用量 / ② 没上报就是未知，不许拿估算顶上')
    mark = countRows()
    metrics.logAttempt({ entry: 'api', providerId: 'relay-x', model: 'm', trace: 'req_b', outcome: 'ok', usage: null })
    rows = rowsSince(mark)
    check('★★ 仍然落一行（发出去过就得有账，否则消耗会少算）', rows.length === 1)
    check('★★ known=false', rows[0]?.known === false)
    check(
      '★★ 三个数字都是 null（0 会被当成「确认消耗 0」）',
      rows[0]?.prompt === null && rows[0]?.completion === null && rows[0]?.total === null,
      JSON.stringify({ p: rows[0]?.prompt, t: rows[0]?.total }),
    )
    check('★ 写了拿不到的原因（事后能诊断）', String(rows[0]?.missing ?? '').length > 0, rows[0]?.missing)

    /* ══ ③ 真给 0 / 空对象：两件事必须分开 ══════════════════════ */
    group('真实用量 / ③ 「确实报了 0」与「根本没数据」是两件事')
    mark = countRows()
    metrics.logAttempt({ entry: 'api', providerId: 'zero-x', model: 'm', trace: 'req_c', outcome: 'ok', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
    metrics.logAttempt({ entry: 'api', providerId: 'empty-x', model: 'm', trace: 'req_d', outcome: 'ok', usage: {} })
    rows = rowsSince(mark)
    check('★★ 上报了全 0 → known=true 且数字是 0', rows[0]?.known === true && rows[0]?.total === 0, JSON.stringify({ k: rows[0]?.known, t: rows[0]?.total }))
    check('★★ usage 是空对象 → 算「没拿到」（known=false、数字 null）', rows[1]?.known === false && rows[1]?.total === null, JSON.stringify({ k: rows[1]?.known, t: rows[1]?.total }))

    /* ══ ④ 缓存字段按各家真实语义 ════════════════════════════════ */
    group('真实用量 / ④ 缓存 token 按各家真实字段记，缺了不造分母')
    mark = countRows()
    metrics.logAttempt({ entry: 'api', providerId: 'deepseek', model: 'm', trace: 'req_e1', outcome: 'ok',
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 } })
    metrics.logAttempt({ entry: 'api', providerId: 'openai', model: 'm', trace: 'req_e2', outcome: 'ok',
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, prompt_tokens_details: { cached_tokens: 80 } } })
    metrics.logAttempt({ entry: 'api', providerId: 'plain', model: 'm', trace: 'req_e3', outcome: 'ok',
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })
    rows = rowsSince(mark)
    check('★ DeepSeek 形状 → hit/miss 都记，能算命中率', rows[0]?.cacheHit === 150 && rows[0]?.cacheMiss === 50 && rows[0]?.hitRate === 0.75, JSON.stringify({ h: rows[0]?.cacheHit, m: rows[0]?.cacheMiss, r: rows[0]?.hitRate }))
    check('★ OpenAI 形状 → miss 是 null、命中率 null（不拿假分母算）', rows[1]?.cacheHit === 80 && rows[1]?.cacheMiss === null && rows[1]?.hitRate === null, JSON.stringify({ h: rows[1]?.cacheHit, m: rows[1]?.cacheMiss, r: rows[1]?.hitRate }))
    check('★★ 这家不给缓存字段 → 两个 null，来源标 unavailable（不是「0 命中」）', rows[2]?.cacheHit === null && rows[2]?.cacheMiss === null && rows[2]?.cacheSource === 'unavailable', rows[2]?.cacheSource)

    /* ══ ⑤ 失败 / 中止：有账、有状态、不补造 ══════════════════════ */
    group('真实用量 / ⑤ 失败与中止：有账、有状态、不补造数字')
    mark = countRows()
    metrics.logAttempt({ entry: 'api', providerId: 'p', model: 'm', trace: 'req_f', outcome: 'failed', retryIndex: 1, reason: '上游返回 500' })
    metrics.logAttempt({ entry: 'api', providerId: 'p', model: 'm', trace: 'req_g', outcome: 'aborted', reason: '用户中止' })
    rows = rowsSince(mark)
    check('★ 失败与中止各一行', rows.length === 2, `${rows.length} 行`)
    check('★ 失败标 failed（ok=false）', rows[0]?.ok === false && rows[0]?.outcome === 'failed')
    check('★ 中止标 aborted，与「失败」分开', rows[1]?.outcome === 'aborted' && rows[1]?.ok === false)
    check('★★ 两者都没有数字（用户点停不该产生虚构用量）', rows[0]?.prompt === null && rows[1]?.prompt === null)
    check('★ 记了第几次尝试', rows[0]?.retryIndex === 1)

    /* ══ ⑥ 费用只认服务商给的金额 ════════════════════════════════ */
    group('真实用量 / ⑥ 费用只认服务商给的金额')
    mark = countRows()
    metrics.logAttempt({ entry: 'api', providerId: 'p', model: 'm', trace: 'req_h', outcome: 'ok', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })
    metrics.logAttempt({ entry: 'api', providerId: 'billed', model: 'm', trace: 'req_i', outcome: 'ok', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.0123 } })
    rows = rowsSince(mark)
    check('★★ 没给金额 → cost 是 null、来源 unavailable（不是 0 元）', rows[0]?.cost === null && rows[0]?.costSource === 'unavailable', JSON.stringify({ c: rows[0]?.cost, s: rows[0]?.costSource }))
    check('★ 真给了金额 → 记下来，来源标 provider', rows[1]?.cost === 0.0123 && rows[1]?.costSource === 'provider')

    /* ══ ⑦ 汇总口径：已知 / 未知 / 老记录分开数 ══════════════════ */
    group('真实用量 / ⑦ 汇总把「已知」「未知」「老记录」分开数')
    mark = countRows()
    metrics.logAttempt({ entry: 'api', providerId: 'sum-x', model: 'm', trace: 'req_j', outcome: 'ok', usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } })
    metrics.logAttempt({ entry: 'api', providerId: 'sum-x', model: 'm', trace: 'req_k', outcome: 'failed', reason: '没拿到' })
    const sum = metrics.summarize()
    check('★★ 汇总里有 known / unknown 两个计数', typeof sum.known === 'number' && typeof sum.unknown === 'number', `known=${sum.known} unknown=${sum.unknown}`)
    check('★★ 按供应商分开汇总（界面按家看消耗）', sum.byProvider?.['sum-x']?.requests === 2, JSON.stringify(sum.byProvider?.['sum-x']))
    check('★★ 那家 2 次里只有 1 次有真实用量（未知那次不计 token）', (() => {
      const one = sum.byProvider?.['sum-x']
      return one?.known === 1 && one?.unknown === 1 && one?.total === 50
    })(), JSON.stringify(sum.byProvider?.['sum-x']))
    check('★ 能按入口分开汇总（api / cli 不串）', typeof sum.byEntry === 'object' && sum.byEntry !== null, JSON.stringify(Object.keys(sum.byEntry ?? {}).slice(0, 4)))
    check('★ legacy 计数存在（新旧口径不混着标成「实际消耗」）', typeof sum.legacy === 'number', String(sum.legacy))

    /* ══ ⑧ 老记录（没有 known 字段）怎么处理 ══════════════════════ */
    group('真实用量 / ⑧ 老记录单独标出来，不假装新口径采到的')
    mark = countRows()
    const legacyBefore = metrics.summarize().legacy
    fs.appendFileSync(metrics.file(), `${JSON.stringify({ at: Date.now(), kind: 'llm', ok: true, prompt: 111, completion: 22, total: 133 })}\n`, 'utf8')
    metrics.logAttempt({ entry: 'api', providerId: 'new-x', model: 'm', trace: 'req_l', outcome: 'ok', usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })
    const after = metrics.summarize()
    check('★★ 没有 known 字段的老行 → legacy +1', after.legacy === legacyBefore + 1, `${legacyBefore} → ${after.legacy}`)
    check('★★ 老行有数字 → 仍计入已知消耗（不能因为老格式就丢掉历史）', after.known >= 1, String(after.known))
    check('★ 新行按新口径计入', after.total >= 10, String(after.total))
    /* 撤掉刚写的两行，别影响后面的组 */
    const keepAfterLegacy = fs.readFileSync(metrics.file(), 'utf8').trim().split('\n').filter(Boolean).slice(0, mark)
    fs.writeFileSync(metrics.file(), keepAfterLegacy.length ? `${keepAfterLegacy.join('\n')}\n` : '', 'utf8')

    /* ══ ⑨ 记账点收敛：只有一处，且成功失败都记 ══════════════════ */
    group('真实用量 / ⑨ 记账点收敛（两处各记一份就会重复计数）')
    check('★★ llm.cjs 不再自己记账（记那里会让重试的中间几次永久丢失）', !/metrics\.logLlm|token-metrics/.test(readFileSync(join(ROOT, 'electron/core/llm.cjs'), 'utf8')))
    const lmSrc = readFileSync(LM, 'utf8')
    check('★★ 记账在重试循环里（它才知道第几次、发给谁）', /logAttempt\(target, options, model/.test(lmSrc))
    check('★ 成功与失败两条路都记', /outcome: 'ok'/.test(lmSrc) && /'aborted' : 'failed'/.test(lmSrc))
    check('★ 记账包了 try（写不进也不许拦住调用）', (() => {
      /* 按函数体范围判断，不数固定字符数（那会随改写失效） */
      const start = lmSrc.indexOf('function logAttempt')
      if (start < 0) return false
      const body = lmSrc.slice(start, start + lmSrc.slice(start).indexOf('\n}'))
      return /\btry\s*\{/.test(body) && /\bcatch\b/.test(body)
    })())

    /* ══ ⑩ CLI 也走同一本账 ══════════════════════════════════════ */
    group('真实用量 / ⑩ Codex CLI 也走同一本账')
    const jsonl = require(join(ROOT, 'electron/core/codex-jsonl.cjs'))
    check('★★ CLI 没报 usage → mapUsage 回 null（不是全 0 对象）', jsonl.mapUsage(null) === null && jsonl.mapUsage({}) === null, JSON.stringify([jsonl.mapUsage(null), jsonl.mapUsage({})]))
    check('★ CLI 报了 usage → 映射成 OpenAI 原字段（下游只认这种形状）', (() => {
      const u = jsonl.mapUsage({ input_tokens: 300, output_tokens: 40, cached_input_tokens: 120, reasoning_output_tokens: 8 })
      return u.prompt_tokens === 300 && u.completion_tokens === 40 && u.total_tokens === 340 && u.prompt_tokens_details.cached_tokens === 120
    })())
    check('★ 真给 0 的 CLI usage 仍是对象（确实上报了，只是 0）', (() => {
      const u = jsonl.mapUsage({ input_tokens: 0, output_tokens: 0 })
      return u !== null && u.total_tokens === 0
    })())
    check('★ 入口类型按后端种类判定（cli / api 分得开）', /isCodexCli\(target\) \? 'cli' : 'api'/.test(lmSrc))

    /* ══ ⑪ 估算不许混进真实用量 ══════════════════════════════════ */
    group('真实用量 / ⑪ 本地估算只服务裁剪与预算，不进这本账')
    const tmSrc = readFileSync(join(ROOT, 'electron/core/token-metrics.cjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    check('★★ token-metrics 里没有任何估算函数', !/estimate|估算/i.test(tmSrc))
    check('★ 上下文估算仍在原来那处（这次没动它）', /estimates/.test(readFileSync(join(ROOT, 'electron/core/context-builder.cjs'), 'utf8')))
  } finally {
    /* 把本组写进去的行撤回，别污染后续组的读数 */
    try {
      const all = fs.readFileSync(metrics.file(), 'utf8').trim().split('\n').filter(Boolean).slice(0, before)
      rmSync(metrics.file(), { force: true })
      if (all.length > 0) fs.writeFileSync(metrics.file(), `${all.join('\n')}\n`, 'utf8')
    } catch {
      /* 清理失败不改变结论 */
    }
  }
}
