/**
 * 启动预热（token 优化 · 阶段 4，**默认关闭**）
 *
 * 背景：服务端的 prompt 缓存是前缀匹配。应用重启后第一个请求是「冷」的，
 * 合理预热一次可以让第一个真任务就吃到缓存（命中部分便宜很多）。
 *
 * 纪律（按规范写死）：
 *   · 默认关闭（config.cache.prewarm === true 才跑）—— 预热会产生真实请求与费用；
 *   · **不携带任何用户会话正文**：只发系统提示（稳定前缀）+ 一个固定短词；
 *   · 只发 1 个 token（maxTokens: 1）、temperature 0；
 *   · 可观测：用量/延迟/缓存字段全部记进 token-metrics.jsonl（kind=prewarm）；
 *   · 失败只记日志，绝不影响启动。
 */

const log = require('./log.cjs')
const metrics = require('./token-metrics.cjs')

let ran = false /* 单进程只预热一次 */

/**
 * 条件满足就预热。返回值只用于测试/日志，不抛错。
 */
async function maybeRun() {
  if (ran) return { skipped: 'already' }
  let config
  try {
    config = require('./config.cjs').load()
  } catch (error) {
    return { skipped: 'no-config', error: String(error?.message ?? error) }
  }
  if (config?.cache?.prewarm !== true) return { skipped: 'disabled' }

  const configCore = require('./config.cjs')
  const provider = config.activeProvider ?? configCore.activeProvider()
  if (!provider || !configCore.hasKey(provider)) return { skipped: 'no-provider' }

  ran = true
  try {
    /* 和真实请求完全同一条路：buildPromptContext 出的系统提示（动态段为空）——
       稳定前缀那段与服务端缓存里的块逐字节一致 */
    const { messages } = require('./loop-prompt.cjs').buildPromptContext({
      config,
      workdir: config.general?.workdir || '',
      mode: 'pair',
      history: [],
      threadSettings: {},
      options: {},
    })
    const system = String(messages?.[0]?.content ?? '')
    if (!system) return { skipped: 'empty-prompt' }

    const startedAt = Date.now()
    const result = await require('./llm.cjs').chatStream({
      provider,
      baseUrl: provider.baseUrl,
      apiKey: configCore.providerKey(provider),
      chatPath: provider.chatPath,
      model: config.assistant?.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '预热' },
      ],
      maxTokens: 1,
      temperature: 0,
      label: '预热',
    })
    const cache = metrics.cacheFields(result.usage)
    metrics.recordRequest({
      kind: 'prewarm',
      ok: true,
      model: config.assistant?.model ?? '',
      providerId: provider.id,
      prompt: Number(result.usage?.prompt_tokens) || 0,
      completion: Number(result.usage?.completion_tokens) || 0,
      total: Number(result.usage?.total_tokens) || 0,
      cacheHit: cache.hit,
      cacheMiss: cache.miss,
      cacheSource: cache.source,
      hitRate: metrics.hitRate(cache.hit, cache.miss),
      latencyMs: Date.now() - startedAt,
      ttftMs: result.ttftMs ?? null,
      retryIndex: 0,
      systemBytes: system.length,
    })
    log.info(
      `预热完成：${((Date.now() - startedAt) / 1000).toFixed(1)}s · in=${result.usage?.prompt_tokens ?? '?'} · cached=${cache.hit ?? 'unavailable'}`,
    )
    return { ok: true, usage: result.usage ?? null, ms: Date.now() - startedAt }
  } catch (error) {
    metrics.recordRequest({
      kind: 'prewarm',
      ok: false,
      error: String(error?.message ?? error).slice(0, 200),
    })
    log.warn(`预热失败（不影响启动）：${error instanceof Error ? error.message : error}`)
    return { ok: false, error: String(error?.message ?? error) }
  }
}

module.exports = { maybeRun }
