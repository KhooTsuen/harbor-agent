/**
 * 内核：错误清单的「规则层」（严重性 / 建议 / 位置 / 去重键 / 合并）
 *
 * 为什么住在内核而不是 `scripts/`：
 *   **`scripts/` 不打包进应用**。界面（右栏「错误」标签）要显示同样的严重性分组，
 *   规则放 scripts 里界面就够不着 —— 够不着的后果就是再写一套，然后就漂。
 *   放内核里，CLI（`scripts/errors.mjs`）和界面读的是**同一份**（`scripts/errors/severity.mjs`
 *   现在只是转发，见那个文件）。
 *
 * 严重性口径（P0 阻塞 / P1 严重 / P2 一般 / P3 轻微）**只在这里定义一次** ——
 * 改动会同时影响命令行和界面，这是故意的。
 */

const errorsCore = require('./errors.cjs')

/** 内核分类器是否可用（拿不到就退化成 unknown，不因为分类器挂了让整个清单不可用） */
const classifierAvailable = typeof errorsCore.classify === 'function'

/**
 * 分类：**复用内核已有的分类器**（14 类，带 retryable / needsUser / canAutoRecover）。
 * 只补一件内核没有的事：事件流里的「重试」不是错误，是「系统自己恢复了一次」。
 */
function classify(message, { source } = {}) {
  if (source === 'event' && /^agent\.retrying/.test(String(message))) {
    return {
      kind: 'retry',
      retryable: true,
      needsUser: false,
      hint: '系统自己重试过（看次数是否异常偏高）',
      message: String(message),
    }
  }
  if (!classifierAvailable) {
    return { kind: 'unknown', retryable: false, needsUser: false, hint: '', message: String(message ?? '') }
  }
  try {
    return errorsCore.classify(new Error(String(message ?? '')))
  } catch {
    return { kind: 'unknown', retryable: false, needsUser: false, hint: '', message: String(message ?? '') }
  }
}

const P1_KINDS = new Set(['auth', 'permission', 'process_exit', 'context_overflow'])
const P3_KINDS = new Set(['aborted', 'retry', 'unknown'])

/**
 * 严重性档位与**给用户看的措辞** —— 全项目只有这一份。
 * 命令行（`scripts/errors.mjs`）和界面（右栏「错误」标签）都从这里取，
 * 免得同一个档位在两个地方叫两个名字（本仓库为「同一件事写两份」返工过好几次）。
 */
const SEVERITY_ORDER = ['P0', 'P1', 'P2', 'P3']
const SEVERITY_LABEL = {
  P0: 'P0 阻塞（必须人处理）',
  P1: 'P1 严重',
  P2: 'P2 一般（系统会自己重试）',
  P3: 'P3 轻微 / 非故障',
}

/** 消息里出现这些字样 = 高信号（分类器看不出来，但人一看就知道很严重） */
const MESSAGE_HINTS = [
  { re: /\d+\s*个\s*IPC 通道没注册上/, severity: 'P1', note: 'IPC 通道没注册 = 界面会有按钮点不动' },
  { re: /未捕获异常|未处理的 Promise 拒绝/, severity: 'P1', note: '主进程/渲染层有异常没人接' },
  { re: /会话加密迁移中止|解不开/, severity: 'P1', note: '数据解不开（可能是换了 Windows 账户）' },
]

/**
 * 严重性。规则**顺序有讲究**，都是踩过坑才这么排的：
 *   · 不能盲信分类器的 `needsUser` —— 内核对 `unknown` 也返回 true（保守），
 *     照抄的话「认不出原因的记录」全变 P0（实测 482 条 P0 里 459 条是这么来的）。
 *   · `unknown` 本质是「分类器认不出」= 可信度低 → 放 P3，让人自己看。
 */
function severityOf(kind, { needsUser = false, retryable = true, denied = false, message = '' } = {}) {
  if (denied) return 'P3'
  const hinted = MESSAGE_HINTS.find((h) => h.re.test(String(message)))
  if (hinted) return hinted.severity
  if (needsUser && kind !== 'unknown') return 'P0'
  if (P1_KINDS.has(kind)) return 'P1'
  if (P3_KINDS.has(kind)) return 'P3'
  if (retryable) return 'P2'
  return 'P1'
}

/** 给一条错误附一句人话建议（覆盖分类器的通用 hint） */
function hintOf(kind, message, fallback = '') {
  const hit = MESSAGE_HINTS.find((h) => h.re.test(String(message)))
  if (hit?.note) return `${hit.note}（判定依据：消息里匹配到「${hit.re}」）`
  if (kind === 'unknown') return '分类器认不出这条 —— 看原文再判断，别当成故障'
  return fallback
}

/** 「位置」：给人和 AI 一个能去查的坐标 */
function locationOf(item) {
  if (item.source === 'log') return item.location
  if (item.source === 'audit') return item.location
  if (item.source === 'task') return item.location
  return item.location ?? item.source
}

/**
 * 去重键：source + kind + location + **归一化消息**
 * （数字、时间戳、临时 id 会被抹平 —— 否则「文件不存在：xxx1.txt」和「：xxx2.txt」永远算两条）
 */
function dedupeKey(kind, item) {
  const normalized = String(item.message ?? '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.+-]+/g, '<时间>')
    .replace(/[0-9a-f]{8,}/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  return `${item.source}|${kind}|${locationOf(item)}|${normalized}`
}

/**
 * 同一条（key 相同）合并：count / firstSeen / lastSeen。
 *
 * `repeat` 是观察哨在写入侧折叠出来的计数（同一个错刷了 1000 次 ≈ 10 行），
 * 这里要把次数折回总数 —— 否则「刷了 1000 次」会被算成 10 次。
 * 命令行和界面共用这一个函数，合并口径就不会两边不一样。
 */
function aggregate(list) {
  const map = new Map()
  for (const e of list) {
    const times = Number(e.repeat) || 1
    const hit = map.get(e.key)
    if (!hit) {
      map.set(e.key, { ...e, count: times, firstSeen: e.ts, lastSeen: e.ts })
      continue
    }
    hit.count += times
    hit.firstSeen = Math.min(hit.firstSeen, e.ts)
    hit.lastSeen = Math.max(hit.lastSeen, e.ts)
  }
  return [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen)
}

module.exports = {
  classify,
  severityOf,
  hintOf,
  locationOf,
  dedupeKey,
  aggregate,
  classifierAvailable,
  SEVERITY_ORDER,
  SEVERITY_LABEL,
  rules: { P1_KINDS, P3_KINDS, MESSAGE_HINTS },
}
