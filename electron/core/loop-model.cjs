/**
 * Agent 循环：调模型
 *
 * 从 loop.cjs 拆出来的（那边过 300 行了）。这里只管「把请求发出去、
 * 失败了怎么办」，不碰循环本身。
 */

const llm = require('./llm.cjs')
const log = require('./log.cjs')
const configCore = require('./config.cjs')
const errors = require('./errors.cjs')
const perfMarks = require('./perf-marks.cjs')
const loopGuard = require('./loop-guard.cjs')

/**
 * 这个供应商提供这个模型吗。
 *
 * `models` 为空 = 没声明支持哪些 → 当作「都能」（别因为没声明就不给用）。
 */
function servesModel(provider, model) {
  const list = Array.isArray(provider?.models) ? provider.models : []
  if (list.length === 0) return true
  return list.includes(String(model ?? ''))
}

/**
 * 调模型，带**重试**与**降级**。
 *
 * 两层：①同供应商重试 N 次（指数退避）；②换供应商继续，但要明确告诉用户。
 * 三种情况一律不重试：用户中断、认证失败（重试一万次还是 401）、
 * 上下文超限（该压缩，不是该重发）。
 */
async function callModel(options) {
  /* AG-037：整次调用计时（含重试与降级 —— 用户等的是这个总数） */
  const startedAt = Date.now()
  const traceId = String(options?.traceId || options?.taskId || '')
  try {
    return await callModelInner(options, options.emit)
  } finally {
    perfMarks.mark(traceId, 'llm', Date.now() - startedAt)
  }
}

async function callModelInner(options, emit) {
  const { config, provider, model, signal } = options
  const fb = config.fallback ?? {
    enabled: true,
    attempts: 2,
    retryOn: ['timeout', 'rate_limit', 'server', 'network'],
  }

  const candidates = [provider]
  if (fb.enabled) {
    const others = (config.providers ?? []).filter(
      (p) =>
        p.enabled &&
        p.baseUrl &&
        p.id !== provider.id &&
        configCore.hasKey(p) &&
        /* ★ 必须真的提供这个模型：以前筛选漏了这步，降级会悄悄换掉模型 */
        servesModel(p, model),
    )
    if (others.length > 0) candidates.push(others[0])
  }

  let lastError = null
  /* AG-016：上下文超限只自动压一次（压完还超说明不是「历史长」而是「单条长」） */
  let compacted = false

  for (let index = 0; index < candidates.length; index += 1) {
    const target = candidates[index]
    const maxAttempts = index === 0 && fb.enabled ? fb.attempts : 0

    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

      try {
        const result = await llm.chatStream({
          ...options,
          /* 日志里能一眼分出「对话轮次」和「起标题/建议」那种场景调用 */
          label: `对话 ${log.shortId(options.traceId || options.taskId)}`,
          /* 每请求指标里记第几次尝试（0 = 首次）—— 指标写不写得进不影响请求 */
          retryIndex: attempt,
          /*
           * provider 要整个传下去：请求体里的 extraBody / omitParams / streamUsage
           * 都是供应商级的（见 llm-body.cjs）。漏传的话——配置改了没反应，
           * 而且不报错。
           */
          provider: target,
          baseUrl: target.baseUrl,
          apiKey: configCore.providerKey(target),
          chatPath: target.chatPath,
          /* ★ 降级只换供应商、不换模型（候选上面已筛过「它提供这个模型」） */
          model,
        })
        result.retryCount = attempt
        return result
      } catch (error) {
        const info = errors.classify(error)
        lastError = error
        log.warn(`模型调用失败（${target.id} · ${info.kind}）：${info.message}`)

        if (info.kind === 'aborted') throw error
        if (info.kind === 'context_overflow') {
          emit?.({ type: 'context_overflow', hint: info.hint })
          /*
           * AG-016：自动压缩一次再重试（文档策略表：ContextOverflow → Compact）。
           * 只压一次 —— 压完还超限，说明不是「历史太长」而是「单条太长」，
           * 那种再压也没用，直接报错让用户处理。
           */
          if (!compacted && Array.isArray(options.messages) && options.messages.length > 4) {
            compacted = true
            await compactMessages({ ...options, provider: target })
            continue
          }
          throw error
        }
        if (!errors.shouldRetry(info, attempt, fb)) break

        const wait = errors.backoffMs(attempt, info.kind)
        emit?.({ type: 'retry', attempt: attempt + 1, kind: info.kind, hint: info.hint, wait })
        await sleep(wait)
      }
    }

    if (index < candidates.length - 1) {
      emit?.({
        type: 'fallback',
        from: candidates[index].id,
        to: candidates[index + 1].id,
        reason: errors.classify(lastError).hint,
      })
      log.info(`模型降级：${candidates[index].id} → ${candidates[index + 1].id}`)
    }
  }

  throw lastError ?? new Error('模型调用失败')
}

async function selfReview({ config, provider, model, content, userText, signal }) {
  const review = await llm.chatStream({
    label: '复核',
    provider,
    baseUrl: provider.baseUrl,
    apiKey: configCore.providerKey(provider),
    chatPath: provider.chatPath,
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是回答复核器。检查回答是否回答了用户问题、是否遗漏要求、是否有矛盾或无依据断言。直接输出修订后的最终答案，不要谈论复核过程。若原回答已经足够，原样返回。',
      },
      { role: 'user', content: `用户问题：\n${userText}\n\n待复核回答：\n${content}` },
    ],
    temperature: 0.2,
    maxTokens: config.assistant.maxTokens,
    signal,
  })
  return review.content?.trim() || content
}

/**
 * 自检复核（带事件 + 开关判断）。
 *
 * 从 loop.cjs 搬过来的（那边贴着 300 行）。它原本是围在 selfReview 外面的
 * 一层包装：判断开关和模式、发 started/completed 事件、吞掉失败保留原回答。
 * 搬过来才完整。
 */
async function reviewWithEvents({
  config,
  provider,
  model,
  content,
  userText,
  signal,
  mode,
  emit,
}) {
  if (config.assistant.selfReview !== true) return content
  if (mode !== 'execute' && mode !== 'goal' && mode !== 'plan') return content

  try {
    emit({ type: 'review', status: 'started' })
    const reviewed = await selfReview({ config, provider, model, content, userText, signal })
    emit({ type: 'review', status: 'completed' })
    return reviewed
  } catch (error) {
    log.warn(`自检复核失败，保留原回答：${error instanceof Error ? error.message : error}`)
    return content
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * AG-016：把历史压成一段摘要，**就地**换掉 `messages`。
 *
 * 就地改（`length = 0` + `push`）是为了让调用方看得见 —— `loop.cjs` 的
 * `messages` 是同一个数组引用，下一轮直接用短的就行。
 *
 * 压缩自己也失败时不掩盖原来的错：记一条日志，让调用方照旧抛 context_overflow。
 */
async function compactMessages({ messages, provider, model, apiKey, chatPath, emit }) {
  try {
    const compact = require('./compact.cjs')
    const summary = await compact.summarize({
      baseUrl: provider.baseUrl,
      apiKey,
      chatPath: chatPath ?? provider.chatPath,
      model,
      messages,
    })
    const rebuilt = compact.rebuild(messages, summary)
    messages.length = 0
    messages.push(...rebuilt)
    emit?.({ type: 'compacted', summary: summary.slice(0, 200), kept: rebuilt.length })
    log.info(`上下文超限：已压缩到 ${rebuilt.length} 条消息`)
  } catch (error) {
    log.warn(`自动压缩失败：${error instanceof Error ? error.message : error}`)
  }
}

/**
 * AG-011：暂停时的返回值。
 *
 * 故意和正常返回**同形**，只多一个 `paused: true` —— 调用方（loop.run）
 * 拿它决定把任务台账标成 paused 还是 completed，别处不用改。
 */
function pausedResult({ turn, usage, toolRuns }) {
  return {
    content: '（任务已暂停，可以从这里继续）',
    reasoning: '',
    usage,
    turns: turn,
    toolRuns,
    paused: true,
  }
}

/** AG-011：轮数用尽时的返回值（活没干完，同样可恢复） */
function exhaustedResult({ usage, toolRuns, maxTurns, budgetHit = null, loopHit = null }) {
  const text = (() => {
    if (budgetHit)
      return `${budgetHit.message}
（停下来等你决定：继续 / 停止 / 调整预算。）`
    if (loopHit) {
      /* 文案住在 loop-guard.cjs（和「对模型说的」那句挨着），这边只负责挑一句 */
      return loopGuard.stopMessage(loopHit)
    }
    return `（已经连续调用工具 ${maxTurns} 轮，先停在这里。你可以说「继续」让我接着做。）`
  })()
  return {
    content: text,
    reasoning: '',
    usage,
    turns: maxTurns,
    toolRuns,
    exhausted: true,
    budgetHit,
    loopHit,
  }
}

function mergeUsage(a, b) {
  if (!a) return b
  if (!b) return a
  /* 缓存字段也要累计（token 优化）：只合三个总数会把命中数据丢掉 */
  const cacheHit =
    (Number(a.prompt_cache_hit_tokens) || 0) + (Number(b.prompt_cache_hit_tokens) || 0)
  const cacheMiss =
    (Number(a.prompt_cache_miss_tokens) || 0) + (Number(b.prompt_cache_miss_tokens) || 0)
  return {
    prompt_tokens: (a.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
    completion_tokens: (a.completion_tokens ?? 0) + (b.completion_tokens ?? 0),
    total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0),
    ...(cacheHit > 0 || cacheMiss > 0
      ? { prompt_cache_hit_tokens: cacheHit, prompt_cache_miss_tokens: cacheMiss }
      : {}),
  }
}

module.exports = {
  callModel,
  selfReview,
  reviewWithEvents,
  mergeUsage,
  pausedResult,
  exhaustedResult,
}
