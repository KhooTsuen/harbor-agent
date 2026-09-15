/**
 * 错误分类
 *
 * 问题不是「出错了」，而是「出错了之后怎么办」。
 * 现在整个链路只有一个字符串错误，调用方只能选择「重试」或「放弃」——
 * 这两种都是错的：429 该退避重试，401 该让用户去改 Key，
 * 上下文超限该压缩，文件被改过该重新读一遍。
 *
 * 所以先把错误分成几类，每类给一个明确处置：
 *
 *   network         网络不通        → 重试（退避）
 *   timeout         超时            → 重试（退避）
 *   rate_limit      限流            → 退避更久
 *   server          5xx             → 重试
 *   auth            401/403         → **别重试**，让用户去检查 Key
 *   bad_request     400 参数问题    → 别重试，改请求
 *   model_unsupported 模型不支持该能力 → 提示换模型
 *   context_overflow 上下文超限     → 压缩
 *   file_changed    文件被改过      → 重新读
 *   permission      权限不足        → 问用户
 *   aborted         用户主动中断     → 什么都不做
 *   unknown                         → 报出来
 */

const KINDS = {
  network: { retryable: true, hint: '网络请求失败' },
  timeout: { retryable: true, hint: '请求超时' },
  rate_limit: { retryable: true, hint: '被限流了' },
  server: { retryable: true, hint: '对方服务端出错' },
  auth: { retryable: false, hint: '认证失败 —— 检查 API Key' },
  bad_request: { retryable: false, hint: '请求参数不被接受' },
  model_unsupported: { retryable: false, hint: '这个模型不支持该能力' },
  context_overflow: { retryable: false, hint: '上下文超出模型上限' },
  file_changed: { retryable: false, hint: '文件在读取后被改动了' },
  permission: { retryable: false, hint: '权限不足' },
  aborted: { retryable: false, hint: '被主动中断' },
  unknown: { retryable: false, hint: '未知错误' },
}

/** 从 HTTP 状态码判断 */
function fromStatus(status) {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'bad_request'
  if (status === 408) return 'timeout'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (status >= 400) return 'bad_request'
  return 'unknown'
}

/** 从错误码判断（Node 的 syscall 错误） */
function fromCode(code) {
  const text = String(code ?? '').toUpperCase()
  if (
    ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH'].includes(text)
  ) {
    return 'network'
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(text)) return 'timeout'
  if (text === 'ABORT_ERR') return 'aborted'
  if (text === 'ENOENT') return 'file_changed'
  if (text === 'EACCES' || text === 'EPERM') return 'permission'
  return null
}

/**
 * 从错误消息里认特征。
 *
 * 顺序有讲究：先具体后笼统。「model does not support image」既像
 * bad_request 又像 model_unsupported，让它先命中后者。
 */
const MESSAGE_RULES = [
  [/(aborted|abort(ed)? by user|用户(取消|中断))/, 'aborted'],
  [
    /(context length|context_length|maximum context|too many tokens|reduce the length)/i,
    'context_overflow',
  ],
  [
    /(does not support (image|vision)|unsupported (content|modality)|image.*not supported|multimodal)/i,
    'model_unsupported',
  ],
  [/(model.{0,20}(not found|不存在|invalid)|unknown model)/i, 'model_unsupported'],
  [/(rate limit|too many requests|429)/i, 'rate_limit'],
  [
    /(invalid api key|incorrect api key|unauthorized|authentication|api key.*(invalid|错误))/i,
    'auth',
  ],
  [/(timed? ?out|timeout)/i, 'timeout'],
  [/(socket hang up|fetch failed|network|econnreset|enotfound)/i, 'network'],
  [/(old text|找不到这段原文|出现多次|file.*changed|文件不存在)/i, 'file_changed'],
  [/(permission denied|eacces|没有权限|需要授权)/i, 'permission'],
]

/**
 * 分类一个错误。
 *
 * @param {unknown} error
 * @param {{ status?: number }} [extra]
 * @returns {{ kind: string, retryable: boolean, hint: string, status: number, message: string }}
 */
function classify(error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const status = Number(extra.status ?? error?.status ?? error?.statusCode ?? 0)

  let kind = null

  if (error instanceof Error && error.name === 'AbortError') kind = 'aborted'
  if (!kind && status) kind = fromStatus(status)
  if (!kind && error?.code) kind = fromCode(error.code)
  if (!kind) {
    for (const [pattern, candidate] of MESSAGE_RULES) {
      if (pattern.test(message)) {
        kind = candidate
        break
      }
    }
  }
  if (!kind) kind = 'unknown'

  const meta = KINDS[kind] ?? KINDS.unknown
  return {
    kind,
    retryable: meta.retryable,
    hint: meta.hint,
    status,
    message: message.slice(0, 500),
  }
}

/**
 * 该不该重试。
 *
 * 两个额外的否决条件：
 *   · 用户已经中断 → 一律不重试（否则「停止」按钮会变成摆设）
 *   · 这一类不在允许重试的名单里 → 不重试
 */
function shouldRetry(info, attempt, options = {}) {
  const { attempts = 2, retryOn = ['timeout', 'rate_limit', 'server', 'network'] } = options
  if (attempt >= attempts) return false
  if (info.kind === 'aborted') return false
  if (!info.retryable) return false
  return retryOn.includes(info.kind)
}

/** 退避时长：限流等久一点，其它指数退避，最多 8 秒 */
function backoffMs(attempt, kind = 'unknown') {
  const base = kind === 'rate_limit' ? 2000 : 500
  const delay = base * 2 ** Math.max(0, attempt)
  return Math.min(delay, 8000)
}

module.exports = { KINDS, classify, shouldRetry, backoffMs, fromStatus, fromCode }
