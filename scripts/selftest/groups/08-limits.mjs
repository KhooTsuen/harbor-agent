import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, disposeTasks, join, require, taskCore } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   用量闸（预算）

   之前只有「用量统计」——**能看，但拦不住**。这一组盯三件事：
     ① 关着的时候绝不能拦（保护装置不该在用户没要求时碍事）
     ② 到上限要拦，而且**报的话要能看懂**
     ③ 天数/月数的口径要和 stats.cjs 对得上

   全部不联网：直接改配置 + 往统计里塞数字。
   ══════════════════════════════════════════════════════════════ */

/** 这一组跑 loop 时用的 sessionId —— 专用是为了兜底清理，别再改回空串 */
const LIMITS_SESSION = 'selftest-limits'

export async function run() {
  const limits = require(join(ROOT, 'electron/core/limits.cjs'))
  const statsCore = require(join(ROOT, 'electron/core/stats.cjs'))
  const configCore = require(join(ROOT, 'electron/core/config.cjs'))
  const credentialsCore = require(join(ROOT, 'electron/core/credentials.cjs'))

  group('用量闸')

  /* 用户真实数据不能动：备份统计和配置，跑完还回去 */
  const statsBackup = statsCore.load()
  const configBackup = configCore.get().limits

  function setLimits(next) {
    configCore.patch({ limits: { ...configCore.get().limits, ...next } })
  }

  /** 往统计里塞「今天用了 n 个 token」 */
  function seedToday(tokens) {
    statsCore.reset()
    statsCore.record({ prompt_tokens: tokens, completion_tokens: 0 }, 'selftest-model')
  }

  try {
    /* ── ① 关着的时候不能拦 ── */
    statsCore.reset()
    setLimits({ enabled: false, dailyTokens: 10, monthlyTokens: 10, onExceed: 'block' })
    seedToday(999999)
    const off = limits.check()
    check('★ 没开启时即使超了也不拦', off.exceeded === false && off.limited === false)
    check('没开启时 guard 不 block', limits.guard().blocked === false)
    /* 而且不能误伤：emit 一次都不该发生（用 guard 的返回值判断） */

    /* ── ② 日限 ── */
    setLimits({ enabled: true, dailyTokens: 100, monthlyTokens: 0, onExceed: 'block' })
    seedToday(50)
    const under = limits.check()
    check('没到上限不拦', under.exceeded === false, JSON.stringify(under))
    check('没到上限时 limited=true（开着但没超）', under.limited === true)

    seedToday(100)
    const at = limits.check()
    check('★ 正好到上限就拦（不是「超过」才拦）', at.exceeded === true)
    check('★ 报的是日限', at.level === 'day', String(at.level))
    check('★ 带上了用量和上限', at.used === 100 && at.limit === 100, `${at.used}/${at.limit}`)
    check('★ 报的话说清了「不是故障」', at.message.includes('不是故障'), at.message)
    check('★ 报的话告诉了去哪改', at.message.includes('设置 → 用量'), at.message)
    check('block 模式真的拦', limits.guard().blocked === true)

    /* ── ③ warn 模式只提示 ── */
    setLimits({ onExceed: 'warn' })
    const warned = limits.guard()
    check('★ warn 模式：超了但不 block', warned.info.exceeded === true && warned.blocked === false)

    /* ── ④ 月限：日限不限时看月 ── */
    setLimits({ enabled: true, dailyTokens: 0, monthlyTokens: 1, onExceed: 'block' })
    seedToday(5)
    const month = limits.check()
    check(
      '★ 日限为 0 时看月限',
      month.level === 'month' && month.exceeded === true,
      JSON.stringify(month),
    )
    check('月限报的话说的是「本月」', month.message.includes('本月'), month.message)

    /* ── ⑤ 两个都不限（都填 0）时不该拦 ── */
    setLimits({ enabled: true, dailyTokens: 0, monthlyTokens: 0 })
    seedToday(999999)
    check('★ 开着但两个上限都是 0 → 不拦（0 表示不限）', limits.check().exceeded === false)

    /* ── ⑥ 口径要和 stats 对得上 ── */
    statsCore.reset()
    seedToday(1234)
    check(
      '今天用量的口径和 stats 一致',
      limits.usage().today === 1234,
      String(limits.usage().today),
    )
    check('本月的口径 ≥ 今天', limits.usage().month >= limits.usage().today)

    /* ── ⑦ 日期键的格式（和 stats 的 byDay 必须一致） ── */
    check('dayKey 是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(limits.dayKey()))
    check('monthKey 是 YYYY-MM', /^\d{4}-\d{2}$/.test(limits.monthKey()))
    const seeded = Object.keys(statsCore.load().byDay ?? {})[0]
    check(
      '★ 统计里的日期键和 dayKey 同格式（不同的话预算永远算成 0）',
      seeded === limits.dayKey(),
      `${seeded} vs ${limits.dayKey()}`,
    )

    /* ── ⑧ 真的会拦住 agent 循环 ── */
    const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
    const llmModule = require(join(ROOT, 'electron/core/llm.cjs'))

    /*
     * 要给循环一个**能用的**供应商配置。
     *
     * 踩过：不给的话循环会在预算检查**之前**就抛「还没填 API Key」——
     * 于是「被拦住了」这条断言因为错误的原因通过，测试看着是绿的。
     * （所以下面还要断言错误信息里确实提到「上限」。）
     */
    const PROBE_KEY = 'sk-selftest-budget-123456'
    credentialsCore.set('provider:selftest-budget', PROBE_KEY)
    const probeProvider = {
      id: 'selftest-budget',
      name: '自检供应商',
      baseUrl: 'https://example.invalid/v1',
      credentialRef: 'provider:selftest-budget',
      chatPath: '/chat/completions',
      models: ['probe-model'],
      enabled: true,
    }
    const loopConfig = {
      ...configCore.get(),
      activeProvider: probeProvider,
      providers: [probeProvider],
      assistant: { ...configCore.get().assistant, model: 'probe-model' },
      tools: { ...configCore.get().tools, permission: 'full' },
    }

    setLimits({ enabled: true, dailyTokens: 1, monthlyTokens: 0, onExceed: 'block' })
    seedToday(999)

    let called = false
    const original = llmModule.chatStream
    llmModule.chatStream = async () => {
      called = true
      return { content: '不该走到这里', reasoning: '', toolCalls: [], usage: null }
    }

    let error = null
    const events = []
    try {
      await loopCore.run({
        history: [{ role: 'user', content: '你好' }],
        config: loopConfig,
        workdir: SANDBOX,
        mode: 'pair',
        goal: '你好',
        /* ★ 给个**专用** sessionId，好让下面兜底清理 —— 见 finally 里的注释 */
        sessionId: LIMITS_SESSION,
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        confirm: async () => true,
      })
    } catch (e) {
      error = e
    } finally {
      llmModule.chatStream = original
    }

    check('★ 超预算时循环被拦住（抛错）', error !== null, String(error?.message))
    /* 这条是关键：确认拦住的原因是预算，不是别的（比如没配 Key） */
    check(
      '★ 拦住的原因是「到上限」，不是别的错',
      String(error?.message ?? '').includes('上限'),
      String(error?.message),
    )
    check('★ 而且根本没去调模型（这才是省钱）', called === false)
    check(
      '★ 推了 budget 事件给界面',
      events.some((e) => e.type === 'budget'),
      JSON.stringify(events.map((e) => e.type)),
    )
    check('budget 事件里带 blocked=true', events.find((e) => e.type === 'budget')?.blocked === true)
  } finally {
    /* 还回用户真实数据 */
    statsCore.reset()
    /*
     * ★ 这一组会真的跑一次 loop，而 loop 里是**先建任务再执行** ——
     *   超预算时抛错，taskId 根本拿不到，任务就留在数据目录里了。
     *   2026-09-24 查出来：`data/tasks/` 里 582 条 `failed` 的「你好」全是这里攒的
     *   （每次自检加一条，几年下来能堆成几千条）。
     *   所以按这个专用 sessionId 兜底清一遍 —— 先标 cancelled 再删，
     *   因为在跑的删不掉（见 env.mjs 的 disposeTasks）。
     */
    disposeTasks(taskCore.list({ sessionId: LIMITS_SESSION }).map((item) => item.id))
    /* F8：清掉本组造的假凭证，别让它在 data/credentials.json 里越攒越多 */
    credentialsCore.remove('provider:selftest-budget')
    for (const [day, bucket] of Object.entries(statsBackup.byDay ?? {})) {
      for (let i = 0; i < (bucket.calls ?? 0); i += 1) {
        statsCore.record(
          {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: bucket.total / (bucket.calls || 1),
          },
          'restored',
        )
      }
    }
    configCore.patch({ limits: configBackup })
  }
}
