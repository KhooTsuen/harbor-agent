/**
 * 分类与严重性 —— **复用内核已有的分类器**，不另起一套。
 *
 * 为什么：`electron/core/errors.cjs` 已经有 14 类（aborted / context_overflow /
 * model_unsupported / rate_limit / auth / timeout / network / file_missing /
 * file_changed / permission / mcp / process_exit / tool_failure / unknown），
 * 还带 `retryable` / `needsUser` / `canAutoRecover` 与重试策略。
 * 再写第二套分类必然漂（本仓库为「同一件事写两份」返工过好几次）。
 *
 * 这个文件只做两件内核没做的事：
 *   ① 把分类结果映射成 P0–P3（本工具自己的「严重性」口径，规则集中在这里）
 *   ② 从数据源上下文里抠出「位置」（文件:行 之类），便于人去找
 */
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
/* 内核是 CommonJS，且刻意不依赖 electron —— 自检就是这么直接 require 它的 */
let kernelErrors = null
try {
  kernelErrors = require(path.resolve(import.meta.dirname, '..', '..', 'electron', 'core', 'errors.cjs'))
} catch {
  kernelErrors = null /* 拿不到就退化成 unknown：不因为分类器不可用而整个工具失效 */
}

/** 内核分类器是否可用（CLI 会把它报出来 —— 不可用时结论要打折） */
export const classifierAvailable = typeof kernelErrors?.classify === 'function'

export function classify(message, { source } = {}) {
  /* 事件流里的「重试」不是错误，是「系统自己恢复了一次」——单独立一类，
     否则它会落到 unknown，而 unknown 会让人以为「发生了什么不知道的事」。 */
  if (source === 'event' && /^agent\.retrying/.test(String(message))) {
    return { kind: 'retry', retryable: true, needsUser: false, hint: '系统自己重试过（看次数是否异常偏高）', message: String(message) }
  }
  if (!classifierAvailable) return { kind: 'unknown', retryable: false, needsUser: false, hint: '', message: String(message ?? '') }
  try {
    return kernelErrors.classify(new Error(String(message ?? '')))
  } catch {
    return { kind: 'unknown', retryable: false, needsUser: false, hint: '', message: String(message ?? '') }
  }
}

/**
 * 严重性口径（P0 阻塞 / P1 严重 / P2 一般 / P3 轻微）。
 *
 * 规则顺序有讲究，而且踩过坑：
 *   · **不能盲信分类器的 `needsUser`** —— 内核对 `unknown` 也返回 needsUser=true（保守），
 *     照抄的话「重试事件」「读不到原因的记录」全变成 P0 阻塞（实测 482 条 P0 里有 459 条是这样来的）。
 *   · `unknown` 本质是「分类器认不出」= 可信度低 → 放 P3，让人自己看。
 */
const P1_KINDS = new Set(['auth', 'permission', 'process_exit', 'context_overflow'])
const P3_KINDS = new Set(['aborted', 'retry', 'unknown'])

/** 消息里出现这些字样 = 高信号（内核分类器看不出来，但人一看就知道很严重） */
const MESSAGE_HINTS = [
  { re: /\d+\s*个\s*IPC 通道没注册上/, severity: 'P1', note: 'IPC 通道没注册 = 界面会有按钮点不动' },
  { re: /未捕获异常|未处理的 Promise 拒绝/, severity: 'P1', note: '主进程/渲染层有异常没人接' },
  { re: /会话加密迁移中止|解不开/, severity: 'P1', note: '数据解不开（可能是换了 Windows 账户）' },
]

export function severityOf(kind, { needsUser = false, retryable = true, denied = false, message = '' } = {}) {
  if (denied) return 'P3' /* 按设计的拒绝：不是故障 */
  const hinted = MESSAGE_HINTS.find((h) => h.re.test(String(message)))
  if (hinted) return hinted.severity
  /* ★ unknown 不参与 P0：它只说明「分类器认不出」，不代表「阻塞」 */
  if (needsUser && kind !== 'unknown') return 'P0'
  if (P1_KINDS.has(kind)) return 'P1'
  if (P3_KINDS.has(kind)) return 'P3'
  if (retryable) return 'P2'
  return 'P1'
}

/** 给一条错误附一句人话建议（覆盖分类器的通用 hint） */
export function hintOf(kind, message, fallback = '') {
  const hit = MESSAGE_HINTS.find((h) => h.re.test(String(message)))
  if (hit?.note) return `${hit.note}（判定依据：消息里匹配到「${hit.re}」）`
  if (kind === 'unknown') return '分类器认不出这条 —— 看原文（--json / --noise）再判断，别当成故障'
  return fallback
}

/** 「位置」：给人和 AI 一个能去查的坐标 */
export function locationOf(item) {
  if (item.source === 'log') return item.location // 日志文件名（消息里常带模块名）
  if (item.source === 'audit') return item.location // audit:<工具>
  if (item.source === 'task') return item.location // task:<id>.steps[i]
  return item.location ?? item.source
}

/**
 * 去重键：source + kind + location + **归一化消息**
 * （数字、时间戳、临时 id 会被抹平 —— 否则「文件不存在：xxx1.txt」和「：xxx2.txt」永远算两条）
 */
export function dedupeKey(kind, item) {
  const normalized = String(item.message ?? '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.+-]+/g, '<时间>')
    .replace(/[0-9a-f]{8,}/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  return `${item.source}|${kind}|${locationOf(item)}|${normalized}`
}
