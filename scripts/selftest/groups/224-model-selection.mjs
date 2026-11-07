import { join, require, ROOT, SANDBOX, mkdirSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   模型选择与实际调用的一致性（2026-11-07，第 5 项）

   ── 这条链上原来有三个洞，都在 `loop-model.cjs` ───────────────
   ① `fallback.enabled` 默认 **true** → 用户选 DeepSeek，500 之后就换成另一家。
      界面只弹「已换用一个供应商」，事后无从查起。
   ② 换家的判据不分错误种类 → **401（key 无效）和 400（参数被拒）也会换家**，
      等于用别家的额度把「你这把 key 坏了」盖过去。
   ③ 重试次数与换家开关**共用** `enabled` → 关掉降级，连同一家的重试也没了
      （实测：500 只发一次就报错）。

   ── 这一组怎么判 ──────────────────────────────────────────────
   **不看配置字段、不看日志文字**，只看假 `fetch` 收到几个请求、每个打到哪个
   baseUrl。这是「界面选 A、后台发给 B」唯一站得住的证据层。

   ⚠️ 全部在隔离数据根里跑（假 provider 不落盘），不碰真实凭据和会话。
   ══════════════════════════════════════════════════════════════ */

const configCore = require(join(ROOT, 'electron/core/config.cjs'))
const loopModel = require(join(ROOT, 'electron/core/loop-model.cjs'))

/** 假上游：按 `mode` 决定第一家返回什么；第二家永远成功 */
function installFetch() {
  const state = { hits: [], mode: '500' }
  globalThis.fetch = async (url) => {
    const u = String(url)
    state.hits.push(u)
    if (u.includes('second.example')) {
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(c) {
            const enc = new TextEncoder()
            for (const s of [
              'data: {"choices":[{"delta":{"content":"第二家答的"}}]}\n\n',
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
              'data: [DONE]\n\n',
            ]) c.enqueue(enc.encode(s))
            c.close()
          },
        }),
      }
    }
    const table = {
      401: ['{"error":{"message":"invalid api key","type":"authentication_error"}}', 'Unauthorized'],
      400: ['{"error":{"message":"bad request","type":"invalid_request_error"}}', 'Bad Request'],
      429: ['{"error":{"message":"rate limited","type":"rate_limit"}}', 'Too Many Requests'],
      500: ['{"error":{"message":"boom","type":"internal_error"}}', 'Server Error'],
    }
    const [body, text] = table[state.mode] ?? table[500]
    return { ok: false, status: Number(state.mode), statusText: text, text: async () => body }
  }
  return state
}

const mk = (id, base) => ({
  id,
  name: id,
  enabled: true,
  baseUrl: base,
  models: ['shared-model'],
  chatPath: '/chat/completions',
  kind: 'openai',
})

/** 跑一次，返回「打到哪几家、有没有降级事件」 */
async function once(state, fallback, signal) {
  state.hits.length = 0
  const first = mk('first', 'https://first.example/v1')
  const second = mk('second', 'https://second.example/v1')
  const events = []
  let ok = false
  let error = null
  try {
    await loopModel.callModel({
      config: {
        providers: [first, second],
        assistant: { model: 'shared-model', temperature: 0.7 },
        fallback,
        router: { enabled: false, roles: {} },
        context: {},
        tools: {},
      },
      provider: first,
      model: 'shared-model',
      messages: [{ role: 'user', content: 'hi' }],
      emit: (e) => events.push(e),
      traceId: 'p5',
      signal,
    })
    ok = true
  } catch (e) {
    error = e
  }
  return {
    first: state.hits.filter((u) => u.includes('first.example')).length,
    second: state.hits.filter((u) => u.includes('second.example')).length,
    total: state.hits.length,
    fallbacks: events.filter((e) => e.type === 'fallback').length,
    retries: events.filter((e) => e.type === 'retry').length,
    ok,
    error,
  }
}

export async function run() {
  mkdirSync(SANDBOX, { recursive: true })
  const originalFetch = globalThis.fetch
  const originalHasKey = configCore.hasKey
  const state = installFetch()
  /* 假 provider 不在凭证库里 → 让 hasKey 认它们（真实逻辑不变，只为让候选成立） */
  configCore.hasKey = () => true

  const ON = { enabled: true, attempts: 2, retryOn: ['timeout', 'rate_limit', 'server', 'network'] }
  const OFF = { enabled: false, attempts: 2, retryOn: ['timeout', 'rate_limit', 'server', 'network'] }

  try {
    /* ══ ① 默认值：跨供应商降级必须是关的 ═════════════════════ */
    group('模型选择 / ① 默认不跨供应商')
    const defaults = require(join(ROOT, 'electron/core/config-defaults.cjs')).DEFAULTS
    check(
      '★★ 默认 fallback.enabled 是 false（换谁在答你得你点头）',
      defaults.fallback.enabled === false,
      String(defaults.fallback.enabled),
    )
    check(
      '★ 默认 attempts 仍是 2（同一家内重试没被砍）',
      defaults.fallback.attempts === 2,
      String(defaults.fallback.attempts),
    )

    /* 归一化：老配置里根本没有这个字段 → 不许变成"允许换家" */
    const normalize = require(join(ROOT, 'electron/core/config-normalize.cjs'))
    const bare = normalize.normalize({})
    check(
      '★★ 老配置（没有 fallback 字段）归一化后是关，不是开',
      bare.fallback.enabled === false,
      String(bare.fallback.enabled),
    )
    /* ★ 旧版把 true 当默认值落盘了，那时设置页没有这个开关 —— 那是一份「没选过」的 true */
    const nz = (v) => normalize.normalize(v)
    check('★★ 旧版写下的 true 不算用户选择（升级后是关）', nz({ version: 2, fallback: { enabled: true } }).fallback.enabled === false)
    check('★ 旧配置被按未选择处理时会留痕（load 据此记日志）', nz({ version: 2, fallback: { enabled: true } })._migratedFallback === true)
    check('★★ 新版写下的 true 才算用户点头（开）', nz({ version: 3, fallback: { enabled: true } }).fallback.enabled === true)
    check('★ 新版不产生迁移痕迹', nz({ version: 3, fallback: { enabled: true } })._migratedFallback === false)
    check('★ 用户主动关掉之后重启仍是关', nz({ version: 3, fallback: { enabled: false } }).fallback.enabled === false)
    check('★ 归一化出来的配置带当前版本号（下次保存即升级）', nz({}).version === defaults.version, String(nz({}).version))

    /* ══ ② 关着的时候：只打你选的那家 ═════════════════════════ */
    group('模型选择 / ② 关掉之后只用你选的那家')
    state.mode = '500'
    const offRun = await once(state, OFF)
    check('★★ 一次都没打到第二家', offRun.second === 0, `第二家 ${offRun.second} 次`)
    check('★ 也没有降级事件', offRun.fallbacks === 0, String(offRun.fallbacks))
    check(
      '★★ 同一家内仍然重试（关掉降级 ≠ 关掉重试）',
      offRun.first === 3,
      `第一家 ${offRun.first} 次（attempts=2 → 首发 + 2 次重试）`,
    )
    check('★ 失败如实抛出（不假装成功）', offRun.ok === false && Boolean(offRun.error))

    /* ══ ③ 开着的时候：允许换，但只在"这家不行了"时 ════════ */
    group('模型选择 / ③ 开了才换，且换家要留痕')
    state.mode = '500'
    const onRun = await once(state, ON)
    check('★ 开了之后确实会换（说明开关真的生效）', onRun.second > 0, `第二家 ${onRun.second} 次`)
    check('★ 换家时发了 fallback 事件（界面能提示是谁答的）', onRun.fallbacks === 1, String(onRun.fallbacks))
    check('★ 换家前先把这家重试满', onRun.first === 3, `第一家 ${onRun.first} 次`)

    /* ══ ④ 换家分辨错误种类：这几类不换 ═══════════════════════ */
    group('模型选择 / ④ 换家也不会有用的错误，不换')
    for (const [code, label] of [
      ['401', '认证失败（key 无效）'],
      ['400', '请求参数被拒'],
    ]) {
      state.mode = code
      const r = await once(state, ON)
      check(`★★ ${code} ${label} → 不换家`, r.second === 0, `第二家 ${r.second} 次`)
      check(`★ ${code} 也不重试（重试也不会变好）`, r.total === 1, `请求 ${r.total} 次`)
      check(`★ ${code} 如实报错，不拿别家盖过去`, r.ok === false, `ok=${r.ok}`)
    }

    /* 对照：500 / 429 是"这家暂时不行"，开了就该换 */
    state.mode = '429'
    const rateRun = await once(state, ON)
    check('★ 429 限流 → 开了就允许换家（这类换家是有意义的）', rateRun.second > 0, `第二家 ${rateRun.second} 次`)

    /* ══ ⑤ 用户中止：绝不重试、绝不换家 ═══════════════════════ */
    group('模型选择 / ⑤ 用户点了停止就不许再发')
    state.mode = '500'
    const ctrl = new AbortController()
    ctrl.abort()
    const aborted = await once(state, ON, ctrl.signal)
    check('★★ 已中止 → 一个请求都不发', aborted.total === 0, `请求 ${aborted.total} 次`)
    check('★ 也不换家', aborted.second === 0, `第二家 ${aborted.second} 次`)
    check('★ 抛的是中止错误（不是"模型失败"）', String(aborted.error?.name ?? '').includes('Abort'), String(aborted.error?.name))

    /* ══ ⑥ 不换模型：换家时模型名必须不变 ═════════════════════ */
    group('模型选择 / ⑥ 换家不换模型')
    state.mode = '500'
    state.hits.length = 0
    const bodies = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      try {
        bodies.push(JSON.parse(String(init?.body ?? '{}')).model)
      } catch {
        bodies.push('?')
      }
      return origFetch(url, init)
    }
    await once(state, ON)
    globalThis.fetch = origFetch
    check(
      '★★ 每一次请求的 model 都是用户选的那个（没被换成对方的 models[0]）',
      bodies.length > 0 && bodies.every((m) => m === 'shared-model'),
      JSON.stringify(bodies),
    )

    /* ══ ⑦ 两家不提供同一模型 → 根本不构成候选 ════════════════ */
    group('模型选择 / ⑦ 别家不提供这个模型时，不换')
    state.hits.length = 0
    state.mode = '500'
    const p1 = mk('deepseek', 'https://first.example/v1')
    p1.models = ['deepseek-flash']
    const p2 = mk('relay', 'https://second.example/v1')
    p2.models = ['gpt-6']
    let threw = null
    try {
      await loopModel.callModel({
        config: {
          providers: [p1, p2],
          assistant: { model: 'deepseek-flash', temperature: 0.7 },
          fallback: ON,
          router: { enabled: false, roles: {} },
          context: {},
          tools: {},
        },
        provider: p1,
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'hi' }],
        emit: () => {},
        traceId: 'p5g',
      })
    } catch (e) {
      threw = e
    }
    check(
      '★★ 第二家不提供 deepseek-flash → 一次都没打过去',
      state.hits.filter((u) => u.includes('second.example')).length === 0,
      state.hits.join(','),
    )
    check('★ 如实失败，不换成 gpt-6 顶上', Boolean(threw))

    /* ══ ⑧ 设置页有开关，而且默认显示「已关闭」 ═══════════════ */
    group('模型选择 / ⑧ 界面能看见、能关')
    const { readFileSync } = require('node:fs')
    const src = readFileSync(join(ROOT, 'src/components/settings/tabs/ScenesTab.tsx'), 'utf8')
    check('★★ 设置页有「失败后换用其他供应商」这个开关', src.includes('失败后换用其他供应商'))
    check(
      '★ 开关读的是 fallback.enabled（不是另一个字段）',
      src.includes('patchFallback({ enabled:'),
      '没找到 patchFallback({ enabled:',
    )
    check(
      '★★ 文案说清了关着的效果（只用你选的那家）',
      src.includes('只用你选的那家'),
    )

    /* ══ ⑨ 路由（按类型换模型）默认仍是关的 ═══════════════════ */
    group('模型选择 / ⑨ 自动换模型也必须默认关')
    check(
      '★★ router.enabled 默认 false（自动换模型不透明）',
      defaults.router.enabled === false,
      String(defaults.router.enabled),
    )
    const routerSrc = readFileSync(join(ROOT, 'electron/core/router.cjs'), 'utf8')
    check(
      '★★ 关掉时直接返回默认模型（不改道）',
      routerSrc.includes('if (!config.router?.enabled) return fallback'),
    )
  } finally {
    globalThis.fetch = originalFetch
    configCore.hasKey = originalHasKey
  }
}
