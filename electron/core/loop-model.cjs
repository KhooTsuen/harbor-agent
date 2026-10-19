/**
 * Agent 循环：调模型（从 loop.cjs 拆出来的，那边过 300 行了）
 * 这里只管「把请求发出去、失败了怎么办」，不碰循环本身。
 */

const llm = require('./llm.cjs')
/* ★ M-Codex：第二种后端种类（本机 ChatGPT Codex CLI）—— 与 llm 同形，见设计 §3 */
const codexCli = require('./codex-cli.cjs')
const kinds = require('./provider-kinds.cjs')
const log = require('./log.cjs')
const configCore = require('./config.cjs')
/* ★ 辅助任务（压缩 / 复核）**不复用主任务的 provider** —— 主模型可能是 CLI 后端
   （没有 baseUrl），拿它走 llm.chatStream 必失败。判据见 aux-model.cjs。 */
const auxModel = require('./aux-model.cjs')
const errors = require('./errors.cjs')
const observer = require('./error-observer.cjs')
const perfMarks = require('./perf-marks.cjs')
const loopGuard = require('./loop-guard.cjs')

/**
 * 这个供应商提供这个模型吗。`models` 为空 = 没声明支持哪些 → 当作「都能」
 * （别因为没声明就不给用）。
 */
function servesModel(provider, model) {
  const list = Array.isArray(provider?.models) ? provider.models : []
  if (list.length === 0) return true
  return list.includes(String(model ?? ''))
}

/**
 * 调模型，带**重试**与**降级**。两层：①同供应商重试 N 次（指数退避）；
 * ②换供应商继续，但要明确告诉用户。三种情况不重试：用户中断、认证失败、
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
  /*
   * ★ codex-cli 没有凭据 → 天然不在降级候选里：这是**有意的**。
   *   用户没选它，就不该被自动换过去（换过去还会连工具一起丢，见设计 §1）。
   */
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
    const preparedMessages = await require('./vision-messages.cjs').prepareMessages(options.messages, {
      config, provider: target, model, signal, allowNetwork: options.allowNetwork, emit,
    })

    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

      try {
        /* ★ 按**后端种类**分流 —— 全项目只有这一处（设计 §3）：codex-cli → CLI 适配器，
           其余 → 原来的 HTTP/SSE。两者 `chatStream` 是**同形契约**（同入参 / 返回 / 取消），
           所以循环 / 工具 / 审批 / 预算 / 恢复全都不感知这次分流。 */
        const engine = kinds.isCodexCli(target) ? codexCli : llm
        const result = await engine.chatStream({
          ...options,
          messages: preparedMessages,
          /* 日志里能一眼分出「对话轮次」和「起标题/建议」那种场景调用 */
          label: `对话 ${log.shortId(options.traceId || options.taskId)}`,
          /* 每请求指标里记第几次尝试（0 = 首次）—— 指标写不写得进不影响请求 */
          retryIndex: attempt,
          /* provider 整个传下去：extraBody / omitParams / streamUsage 都是供应商级的
             （见 llm-body.cjs）。漏传 = 配置改了没反应，而且不报错。 */
          provider: target,
          baseUrl: target.baseUrl,
          apiKey: configCore.providerKey(target),
          chatPath: target.chatPath,
          /* ★ 降级只换供应商、不换模型（候选上面已筛过「它提供这个模型」） */
          model,
        })
        /* 上游报「因长度停」→ 告诉用户，别静默截断（事故见 07-llm-body 组注释） */
        if (result.finishReason === 'length') {
          const why = '内容没写完。让它「接着写」，或让它把长内容写进文件。'
          emit?.({ type: 'notice', level: 'warning', title: '回复被输出上限截断了', text: why })
        }
        /* ★ 只取证：有内容却没有 finish_reason = 上游平静断流（只记日志，不改行为） */
        require('./llm-stream-end.cjs').noteStreamEnd({
          label: `对话 ${log.shortId(options.traceId || options.taskId)}`,
          model,
          providerId: target.id,
          finishReason: result.finishReason,
          content: result.content.length,
          reasoning: result.reasoning.length,
          toolCalls: result.toolCalls.length,
          ms: result.latencyMs,
        })
        result.retryCount = attempt
        return result
      } catch (error) {
        const info = errors.classify(error)
        lastError = error
        log.warn(`模型调用失败（${target.id} · ${info.kind}）：${info.message}`)
        /* aborted 是用户点的停，不算故障 → 不记（理由见 error-observer.cjs 顶部） */
        if (info.kind !== 'aborted') {
          const { kind, needsUser, retryable, hint } = info
          observer.record(error, { source: 'model', location: target.id, kind, needsUser, retryable, hint })
        }

        if (info.kind === 'aborted') throw error
        if (info.kind === 'context_overflow') {
          emit?.({ type: 'context_overflow', hint: info.hint })
          /* AG-016：自动压缩一次再重试（ContextOverflow → Compact）。只压一次 ——
             压完还超限说明不是「历史太长」而是「单条太长」，再压也没用，直接报错。 */
          if (!compacted && Array.isArray(options.messages) && options.messages.length > 4) {
            compacted = true
            /* ★ 不传主任务那个 provider：压缩是**辅助任务**，自己挑 HTTP 后端（见 compactMessages） */
            await compactMessages({ messages: options.messages, config: options.config, emit: options.emit })
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
 * 自检复核（带事件 + 开关判断）。从 loop.cjs 搬来的（那边贴 300 行）：
 * 判断开关和模式、发 started/completed 事件、吞掉失败保留原回答。
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

  /* ★ 复核是**辅助任务** → `resolveAux` 挑一个能走 HTTP 的后端，**不复用主任务那个**
     （主模型可能是 codex-cli，baseUrl 空串 → 必失败）；一个候选都没有就跳过复核、
     保留原回答。`provider`/`model` 只用于日志对照。 */
  const aux = auxModel.resolveAux(config)
  if (!aux) {
    log.warn(`自检复核跳过：没有可用的 HTTP 后端（主任务 ${provider?.id ?? '?'}/${model ?? '?'}）`)
    return content
  }

  try {
    emit({ type: 'review', status: 'started' })
    const reviewed = await selfReview({
      config,
      provider: aux.provider,
      model: aux.model,
      content,
      userText,
      signal,
    })
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
 * AG-016：把历史压成一段摘要，**就地**换掉 `messages`（就地改是为了让调用方
 * 看得见：`loop.cjs` 的 `messages` 是同一个数组引用，下一轮直接用短的）。
 * 压缩失败**不掩盖原来的错**：记一条日志，让调用方照旧抛 context_overflow。
 *
 * ★ 用**辅助后端**（`resolveAux`）而非主任务那个：主模型可能是 codex-cli
 *   （baseUrl 空串）→ `llm.chatStream` 必失败。拿不到辅助后端就如实记一条跳过。
 */
async function compactMessages({ messages, config, emit }) {
  try {
    const aux = auxModel.resolveAux(config, { scene: 'compact' })
    if (!aux) {
      log.warn('自动压缩跳过：没有能走 HTTP 的供应商（辅助任务不复用 CLI 后端）')
      return
    }
    const compact = require('./compact.cjs')
    const summary = await compact.summarize({
      baseUrl: aux.provider.baseUrl,
      apiKey: configCore.providerKey(aux.provider),
      chatPath: aux.provider.chatPath,
      model: aux.model,
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
  /* 保留 loop-result 的旧导出接口。 */
  ...require('./loop-result.cjs'),
}
