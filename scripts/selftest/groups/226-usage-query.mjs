import { join, mkdirSync, require, ROOT, SANDBOX, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync, rmSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   统一用量查询（2026-11-08）

   钉的是**查询层**的口径与可靠性，不是采集层（那是 225 组的活）。

   三条底线，每条都对应一种「数字看着正常但是错的」：
     ① 未知 ≠ 零：没有 usage 的请求不进任何 token 合计。
     ② 缺字段 ≠ 0：某家不给 reasoning，就记 fieldUnavailable，不补零。
     ③ 旧格式 ≠ 新口径：老行计入 legacy，数值保留但单独标出。

   还有一条是缓存正确性：账本变了必须能看出来，否则会返回过期结果。

   ⚠️ 全部在隔离数据根里造合成账本，不碰用户真数据。
   ══════════════════════════════════════════════════════════════ */

const D = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime()

export async function run() {
  const metrics = require(join(ROOT, 'electron/core/token-metrics.cjs'))
  const ledger = require(join(ROOT, 'electron/core/usage-ledger.cjs'))
  const q = require(join(ROOT, 'electron/core/usage-query.cjs'))
  const file = metrics.file()
  const backup = (() => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  })()

  const seed = (rows) => {
    mkdirSync(join(SANDBOX, 'logs'), { recursive: true })
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    ledger.reset()
  }

  try {
    /* ══ ① 同名模型分属两家 ══ */
    group('用量查询 / ① 同名模型按供应商分开')
    seed([
      { at: D(2026, 11, 1), providerId: 'p-deepseek', model: 'shared-m', known: true, ok: true, outcome: 'ok', prompt: 100, completion: 10, total: 110 },
      { at: D(2026, 11, 2), providerId: 'p-openai', model: 'shared-m', known: true, ok: true, outcome: 'ok', prompt: 200, completion: 20, total: 220 },
    ])
    let r = await q.query({})
    check('byModel 合并同名（这是这个维度的语义）', r.byModel['shared-m'].requests === 2, String(r.byModel['shared-m'].requests))
    check(
      '★★ byProviderModel 把它们分开（同名不混成一家）',
      Object.keys(r.byProviderModel).length === 2 &&
        r.byProviderModel['p-deepseek\u0000shared-m'].total === 110 &&
        r.byProviderModel['p-openai\u0000shared-m'].total === 220,
      JSON.stringify(Object.keys(r.byProviderModel)),
    )
    check('★ 按供应商筛只拿到那一家', (await q.query({ providerId: 'p-deepseek' })).totals.total === 110)

    /* ══ ② API / CLI ══ */
    group('用量查询 / ② API 与 CLI 分开与合并')
    seed([
      { at: D(2026, 11, 1), providerId: 'p-api', model: 'm', entry: 'api', known: true, ok: true, outcome: 'ok', prompt: 50, completion: 5, total: 55 },
      { at: D(2026, 11, 1), providerId: 'p-cli', model: 'm', entry: 'cli', known: true, ok: true, outcome: 'ok', prompt: 70, completion: 7, total: 77 },
    ])
    r = await q.query({})
    check('合并 = 两者之和', r.totals.total === 132, String(r.totals.total))
    check('★ api 只 55', (await q.query({ entry: 'api' })).totals.total === 55)
    check('★ cli 只 77', (await q.query({ entry: 'cli' })).totals.total === 77)
    check('两个入口都在 byEntry 里', Object.keys(r.byEntry).sort().join(',') === 'api,cli')

    /* ══ ③ 按任务汇总 ══ */
    group('用量查询 / ③ 一个任务的多次请求')
    seed([
      { at: D(2026, 11, 3), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', prompt: 10, completion: 1, total: 11, taskId: 'task_x', retryIndex: 0 },
      { at: D(2026, 11, 3), providerId: 'p', model: 'm', known: false, ok: false, outcome: 'failed', taskId: 'task_x', retryIndex: 1 },
      { at: D(2026, 11, 3), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', prompt: 20, completion: 2, total: 22, taskId: 'task_x', retryIndex: 2 },
    ])
    r = await q.query({ taskId: 'task_x' })
    check('★★ 3 次请求都算进来（含失败那次）', r.totals.requests === 3, String(r.totals.requests))
    check('★ 已知 2 / 未知 1', r.totals.known === 2 && r.totals.unknown === 1)
    check('★★ 只累已知的 token（11+22，失败那次不补造）', r.totals.total === 33, String(r.totals.total))
    check('★ 覆盖率 = 2/3', r.totals.coverage === 0.6667, String(r.totals.coverage))

    /* ══ ④ 调用类别 ══ */
    group('用量查询 / ④ 调用类别（不重不漏）')
    seed([
      { at: D(2026, 11, 4), providerId: 'p', model: 'm', purpose: 'chat', known: true, ok: true, outcome: 'ok', total: 110, prompt: 100, completion: 10 },
      { at: D(2026, 11, 4), providerId: 'p', model: 'm', purpose: 'compact', known: true, ok: true, outcome: 'ok', total: 33, prompt: 30, completion: 3 },
      { at: D(2026, 11, 4), providerId: 'p', model: 'm', purpose: 'scene', known: true, ok: true, outcome: 'ok', total: 6, prompt: 5, completion: 1 },
      { at: D(2026, 11, 4), providerId: 'p', model: 'm', purpose: 'vision', known: true, ok: true, outcome: 'ok', total: 10, prompt: 8, completion: 2 },
      { at: D(2026, 11, 4), providerId: 'p', model: 'm', purpose: 'prewarm', known: true, ok: true, outcome: 'ok', total: 2, prompt: 2, completion: 0 },
      { at: D(2026, 11, 4), providerId: 'p', model: 'm', purpose: 'collab', entry: 'cli', known: true, ok: true, outcome: 'ok', total: 44, prompt: 40, completion: 4 },
    ])
    r = await q.query({})
    check('★★ 六个类别各一格', Object.keys(r.byPurpose).sort().join(',') === 'chat,collab,compact,prewarm,scene,vision', Object.keys(r.byPurpose).join(','))
    check('★★ 各格相加 = 总量（不重不漏）', Object.values(r.byPurpose).reduce((s, b) => s + b.total, 0) === r.totals.total)
    check('★ 只看主对话 → 110', (await q.query({ purpose: 'chat' })).totals.total === 110)

    /* ══ ⑤ 未标注 ══ */
    group('用量查询 / ⑤ 没标类别的记录不冒充 chat')
    seed([{ at: D(2026, 11, 4), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 2, prompt: 1, completion: 1 }])
    r = await q.query({})
    check('★★ 没 purpose → 归「未标注」', Object.keys(r.byPurpose).join(',') === q.UNSET, Object.keys(r.byPurpose).join(','))
    check('★ 而且能按这个名字查回来（不会点了查不到）', (await q.query({ purpose: q.UNSET })).totals.requests === 1)

    /* ══ ⑥ 已知零 vs 未知 ══ */
    group('用量查询 / ⑥ 已知 0 与未知分得开')
    seed([
      { at: D(2026, 11, 5), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', prompt: 0, completion: 0, total: 0 },
      { at: D(2026, 11, 5), providerId: 'p', model: 'm', known: false, ok: false, outcome: 'failed' },
    ])
    r = await q.query({})
    check('★★ known=1 / unknown=1', r.totals.known === 1 && r.totals.unknown === 1, `${r.totals.known}/${r.totals.unknown}`)
    check('★★ 总量是 0（未知那次没被补成别的数）', r.totals.total === 0, String(r.totals.total))

    /* ══ ⑦ 字段缺失不补零 ══ */
    group('用量查询 / ⑦ 缺字段记不可用，不补 0')
    seed([
      { at: D(2026, 11, 6), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', prompt: 10, completion: 2, total: 12 },
      { at: D(2026, 11, 6), providerId: 'q', model: 'm', known: true, ok: true, outcome: 'ok', prompt: 20, completion: 4, total: 24, reasoning: 3, cacheHit: 5 },
    ])
    r = await q.query({})
    check('★★ reasoning 只累给了数的那条', r.totals.reasoning === 3, String(r.totals.reasoning))
    check('★★ 缺的那条进 fieldUnavailable（不是当成 0）', r.totals.fieldUnavailable.reasoning === 1, String(r.totals.fieldUnavailable.reasoning))

    /* ══ ⑧ 缓存与思考不重复 ══ */
    group('用量查询 / ⑧ 缓存与思考不重复累计')
    seed([{ at: D(2026, 11, 7), providerId: 'deepseek', model: 'm', known: true, ok: true, outcome: 'ok', prompt: 1000, completion: 100, total: 1100, cacheHit: 800, cacheMiss: 200, reasoning: 40 }])
    r = await q.query({})
    check('★★ prompt 就是 1000（没把缓存再加一遍）', r.totals.prompt === 1000, String(r.totals.prompt))
    check('★★ hit + miss == prompt（口径自洽）', r.totals.cacheHit + r.totals.cacheMiss === r.totals.prompt)
    check('★★ 语义标志写明了「缓存含在输入里」', r.semantics.promptIncludesCache === true && r.semantics.completionIncludesReasoning === true)

    /* ══ ⑨ 跨月跨年 ══ */
    group('用量查询 / ⑨ 按天 + 跨月跨年')
    seed([
      { at: D(2026, 12, 31, 23), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 1, prompt: 1, completion: 0 },
      { at: D(2027, 1, 1, 0), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 2, prompt: 2, completion: 0 },
      { at: D(2027, 1, 1, 23), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 4, prompt: 4, completion: 0 },
    ])
    r = await q.query({})
    check('★★ 跨年分成两天', r.days.length === 2 && r.days[0].day === '2026-12-31' && r.days[1].day === '2027-01-01', r.days.map((d) => d.day).join(','))
    check('★ 同一天累加', r.days[1].total === 6, String(r.days[1].total))
    check('★ 升序', r.days[0].day < r.days[1].day)

    /* ══ ⑩ 热力图：无调用 vs 未知 ══ */
    group('用量查询 / ⑩ 热力图能区分「没调」和「未知」')
    seed([
      { at: D(2026, 11, 1), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 11, prompt: 10, completion: 1 },
      { at: D(2026, 11, 3), providerId: 'p', model: 'm', known: false, ok: false, outcome: 'failed' },
    ])
    r = await q.query({ from: D(2026, 11, 1, 0), to: D(2026, 11, 3, 23), includeEmptyDays: true })
    check('★★ 补齐 3 天', r.days.length === 3, r.days.map((d) => d.day).join(','))
    check('★★ 11-02 是空白（requests=0 + empty）', r.days[1].requests === 0 && r.days[1].empty === true, JSON.stringify({ r: r.days[1].requests, e: r.days[1].empty }))
    check('★★ 11-03 有调用但未知（requests=1 但 known=0，且不是 empty）', r.days[2].requests === 1 && r.days[2].known === 0 && !r.days[2].empty, JSON.stringify({ r: r.days[2].requests, k: r.days[2].known }))
    check('★ 空白那天的 token 是 0 而不是 undefined', r.days[1].total === 0 && r.days[1].coverage === null)
    check('★ 只按时间筛也返回完整结构（totals 等在）', typeof r.totals === 'object' && r.byProvider !== undefined)

    /* ══ ⑪ 旧格式 ══ */
    group('用量查询 / ⑪ 旧格式单独标出，不冒充新口径')
    seed([
      { at: D(2026, 11, 2), kind: 'llm', ok: true, prompt: 300, completion: 30, total: 330 },
      { at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 10, prompt: 7, completion: 3 },
    ])
    r = await q.query({})
    check('★★ 无 known 的老行计入 legacy', r.totals.legacy === 1, String(r.totals.legacy))
    check('★ 老行的数字仍然计入（历史不能丢）', r.totals.total === 340, String(r.totals.total))
    check('★ 老行没有供应商 → 归未标注，不冒充某一家', Object.keys(r.byProvider).includes(q.UNSET), Object.keys(r.byProvider).join(','))

    /* ══ ⑫ 费用 ══ */
    group('用量查询 / ⑫ 没有真金额就不生成费用')
    seed([
      { at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 11, prompt: 10, completion: 1, cost: null },
      { at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 11, prompt: 10, completion: 1 },
    ])
    check('★★ 全没给金额 → cost 是 null（不是 0 元）', (await q.query({})).totals.cost === null)
    seed([{ at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 11, prompt: 10, completion: 1, cost: 0.25 }])
    check('★ 真给了才记', (await q.query({})).totals.cost === 0.25)

    /* ══ ⑬ 重复查询 / 增量 / 换文件 ══ */
    group('用量查询 / ⑬ 缓存不会返回过期或重复的数字')
    seed([{ at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 11, prompt: 10, completion: 1 }])
    check('★★ 连查两次结果一样（不重复累计）', (await q.query({})).totals.total === 11 && (await q.query({})).totals.total === 11)
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 22, prompt: 20, completion: 2 }) + '\n', 'utf8')
    check('★★ 增量追加后能看到新行', (await q.query({})).totals.total === 33, String((await q.query({})).totals.total))
    check('★★ 再查一次不翻倍', (await q.query({})).totals.total === 33)
    check('★ 偏移只往前走', ledger.info().offset > 0 && ledger.info().rows === 2, JSON.stringify(ledger.info()))
    /* 换成更短的文件（模拟轮转） */
    writeFileSync(file, JSON.stringify({ at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 9, prompt: 9, completion: 0 }) + '\n', 'utf8')
    r = await q.query({})
    check('★★ 文件变短 → 重建（1 行 9 token，不是 2 行 15）', r.totals.requests === 1 && r.totals.total === 9, `${r.totals.requests}/${r.totals.total}`)
    /* 等长覆写（Windows 上 ino 不变，靠 size+mtime 判） */
    const sameLen = JSON.stringify({ at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 7, prompt: 7, completion: 0 }) + '\n'
    writeFileSync(file, sameLen, 'utf8')
    r = await q.query({})
    check('★★ 等长覆写也能发现（不会返回旧内容）', r.totals.total === 7, String(r.totals.total))

    /* ══ ⑭ 并发 ══ */
    group('用量查询 / ⑭ 并发查询不重复累计')
    seed(Array.from({ length: 60 }, (_, i) => ({ at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 1, prompt: 1, completion: 0, taskId: `t${i % 6}` })))
    const many = await Promise.all([q.query({}), q.query({}), q.query({}), q.query({})])
    check('★★ 4 个并发都是 60 行', many.every((x) => x.totals.requests === 60), many.map((x) => x.totals.requests).join(','))
    check('★ 任务维度一致', many.every((x) => Object.keys(x.byTask).length === 6))

    /* ══ ⑮ 组合筛选 ══ */
    group('用量查询 / ⑮ 供应商 + 模型 + 时间 + 任务 组合')
    seed([
      { at: D(2026, 10, 30), providerId: 'A', model: 'm1', known: true, ok: true, outcome: 'ok', total: 1, prompt: 1, completion: 0, taskId: 'T1' },
      { at: D(2026, 11, 1), providerId: 'A', model: 'm1', known: true, ok: true, outcome: 'ok', total: 2, prompt: 2, completion: 0, taskId: 'T1' },
      { at: D(2026, 11, 2), providerId: 'A', model: 'm2', known: true, ok: true, outcome: 'ok', total: 4, prompt: 4, completion: 0, taskId: 'T1' },
      { at: D(2026, 11, 2), providerId: 'B', model: 'm1', entry: 'cli', purpose: 'collab', known: true, ok: true, outcome: 'ok', total: 8, prompt: 8, completion: 0, taskId: 'T2' },
    ])
    check('A + m1 + 时间窗 → 2', (await q.query({ providerId: 'A', model: 'm1', from: D(2026, 11, 1, 0), to: D(2026, 11, 2, 23) })).totals.total === 2)
    check('A + T1 → 7', (await q.query({ providerId: 'A', taskId: 'T1' })).totals.total === 7)
    check('B + collab → 8', (await q.query({ providerId: 'B', purpose: 'collab' })).totals.total === 8)
    check('★ 什么都对不上 → 0 请求（不是报错）', (await q.query({ providerId: 'NOPE' })).totals.requests === 0)

    /* ══ ⑯ 返回的不能是缓存里的同一份对象 ══ */
    group('用量查询 / ⑯ 调用方改返回值不会污染下一次查询')
    seed([{ at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 5, prompt: 5, completion: 0 }])
    const one = await q.query({})
    one.totals.total = 999999
    one.byProvider.p.hacked = true
    r = await q.query({})
    check('★★ 改了返回值，再查还是 5', r.totals.total === 5, String(r.totals.total))
    check('★★ 供应商里没被塞进外来字段', r.byProvider.p.hacked === undefined)

    /* ══ ⑰ 读盘是分块异步的（不阻塞事件循环）══ */
    group('用量查询 / ⑰ 读大账本是分块异步（不卡主进程）')
    /* 9MB ≈ 9 个 1MB 块：块与块之间必须让出事件循环，定时器才有机会跑 */
    const rows = Array.from({ length: 40000 }, (_, i) => ({ at: D(2026, 11, 2) + i, providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', total: 1, prompt: 1, completion: 0 }))
    seed(rows)
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 1)
    await q.query({})
    clearInterval(timer)
    check('★★ 读 40000 行（9MB）期间定时器能跑（说明块之间让出了事件循环）', ticks >= 5, `触发 ${ticks} 次`)
    check('★ 源码里用的是 fsp.open 分块读，不是 readFileSync 整份', (() => {
      /* 只看代码行：注释里的 readFileSync（解释「为什么不那么做」）不算违规 */
      const code = readFileSync(join(ROOT, 'electron/core/usage-ledger.cjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      return /fsp\.open/.test(code) && !/readFileSync/.test(code)
    })())

    /* ══ ⑱ 与老口径对账（同一批数据，数字必须一致）══ */
    group('用量查询 / ⑱ 和老 summarize 的数字对得上')
    seed([
      { at: D(2026, 11, 2), providerId: 'p', model: 'm', known: true, ok: true, outcome: 'ok', prompt: 100, completion: 10, total: 110, cacheHit: 40, cacheMiss: 60, reasoning: 5 },
      { at: D(2026, 11, 2), providerId: 'q', model: 'n', known: false, ok: false, outcome: 'failed' },
      { at: D(2026, 11, 3), kind: 'llm', ok: true, prompt: 200, completion: 20, total: 220 },
    ])
    const oldOne = metrics.summarize({})
    const newOne = (await q.query({})).totals
    const pairs = [
      ['requests', oldOne.requests, newOne.requests],
      ['known', oldOne.known, newOne.known],
      ['unknown', oldOne.unknown, newOne.unknown],
      ['legacy', oldOne.legacy, newOne.legacy],
      ['prompt', oldOne.prompt, newOne.prompt],
      ['completion', oldOne.completion, newOne.completion],
      ['total', oldOne.total, newOne.total],
      ['cacheHit', oldOne.cacheHit, newOne.cacheHit],
      ['reasoning', oldOne.reasoning, newOne.reasoning],
      ['errors', oldOne.errors, newOne.errors],
    ]
    const bad = pairs.filter(([, a, b]) => a !== b)
    check('★★ 十个指标逐项一致（两套口径没漂）', bad.length === 0, JSON.stringify(bad))
  } finally {
    /* 还原账本：原来有就写回去，没有就删掉 */
    try {
      if (backup !== null) writeFileSync(file, backup, 'utf8')
      else rmSync(file, { force: true })
    } catch {
      /* 还原失败不影响测试结论（这是隔离目录） */
    }
    ledger.reset()
  }
}
