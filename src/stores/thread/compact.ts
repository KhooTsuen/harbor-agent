import type { ConversationState, Message } from '@/types'
import type { ProviderCapabilityMatrix } from '@/types/model-caps'
import { uid } from '@/lib/utils'
import { CONTEXT_BASE_TOKENS } from '@/constants'
import { infoOf } from '@/lib/modelCapabilityWarn'
import { appendCompact, compactChat } from '@/lib/backend'
import { useAppStore } from '../useAppStore'
import { useUIStore } from '../useUIStore'

/* ══════════════════════════════════════════════════════════════
   上下文压缩（前端编排）

   后端只负责「把一段对话变成摘要」；**什么时候压、压到哪一条**在这里决定。
   这么分是因为：压缩会丢细节，用户应该看得见发生了什么。

   三个触发点：
     · 用户输入 /compact
     · 上下文超过「提示线」→ 提示但不压
     · 上下文超过「自动线」→ 自动压，并在消息流里留一条记录
   ══════════════════════════════════════════════════════════════ */

/** 压缩时保留最近多少条不进去（太近的内容摘要会丢关键细节） */
export const KEEP_RECENT = 6

/** 消息文本长度 → token 粗估（和后端 compact.cjs 用同一个系数） */
export function estimateTokens(text: string): number {
  return Math.ceil(String(text).length / 3)
}

export function estimateMessages(messages: readonly Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0)
}

/**
 * 内核那套「可用消息」的口径 —— 两边必须一致，否则压缩点之后算出来的用量对不上。
 * （`electron/core/session-read.cjs` 的 `toApiMessages`：只留 user / assistant，
 *   有文字**或者**只有图片（光发一张图）也算一条。）
 */
export function usableOf(messages: readonly Message[]): Message[] {
  return messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      (m.content.trim() !== '' || (m.images?.length ?? 0) > 0),
  )
}

/** 最后一个压缩点覆盖到第几条（0 = 没压过） */
function lastCompactUpTo(messages: readonly Message[], usableCount: number): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const upTo = messages[i]?.compactUpTo ?? 0
    if (upTo > 0) return Math.min(upTo, usableCount)
  }
  return 0
}

/**
 * 「这一轮真正会带进上下文的那一段」= 最后一个压缩点之后的消息。
 *
 * ★ 真机反馈 12b：以前用量是拿**全部**消息估的，压过一次之后永远超过自动线
 *   → **每一轮都自动压一次**，摘要互相覆盖、越压越糊。内核切上下文就是按
 *   `compacts[].upTo` 切的（`session-read.cjs`），这里跟它对齐。
 */
export function contextMessages(messages: readonly Message[]): Message[] {
  const usable = usableOf(messages)
  const upTo = lastCompactUpTo(messages, usable.length)
  return upTo > 0 ? usable.slice(upTo) : usable
}

/** 窗口里留给「输入」的比例 —— 另外 0.2 留给模型写答案（见 resolveLimit） */
export const MODEL_WINDOW_SHARE = 0.8

/**
 * 压缩的分母（token 数）：`min(模型窗口 × 0.8, 用户上限)`。
 *
 *   · 乘 0.8：窗口是「输入 + 输出」的总量，得给模型写字留出地方；
 *   · 和用户上限取小：上限是用户在设置里给的**刹车**，不能因为知道窗口更大就绕过它；
 *   · 模型窗口未知（没有预设、也没手填）→ 只认用户上限（老口径）→ 再退到内核基准。
 */
export function resolveLimit(maxTokens: number, modelWindow?: number | null): number {
  const userCap = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0
  const window =
    typeof modelWindow === 'number' && Number.isFinite(modelWindow) && modelWindow > 0
      ? Math.floor(modelWindow * MODEL_WINDOW_SHARE)
      : 0
  const limit =
    window && userCap ? Math.min(window, userCap) : window || userCap || CONTEXT_BASE_TOKENS
  return Math.max(2000, limit)
}

/**
 * 这个模型的上下文窗口（token）。查不到就是 `null` —— **未知，不是 0**。
 * 来源是主进程下发的能力矩阵（内置预设 / 用户手填），不是探测结果。
 */
export function modelWindowOf(
  matrix: ProviderCapabilityMatrix | undefined,
  model: string,
): number | null {
  const caps = infoOf(matrix, model)?.caps?.context_window
  return typeof caps === 'number' && caps > 0 ? caps : null
}

/**
 * 压缩的两条线（比例）。
 *
 * ★ 2026-10-04：以前这里写死 0.4 / 0.6，而内核的 `config-defaults.cjs` 里也有
 *   一份 `compactAt: 0.4` / `autoCompactAt: 0.6`（设置页改的就是那一份）——
 *   用户在设置里改了百分比，**渲染层根本没读**，两边各写各的。
 *   现在：调用方把配置里的值传进来（`useThreadStore` 从 config 取），
 *   这里的常量只当**缺配置时的默认值**，并且必须与内核一致
 *   （`compactDrift.test.ts` 直接读内核那份来比）。
 */
export const DEFAULT_WARN_RATIO = 0.4
export const DEFAULT_AUTO_RATIO = 0.6

/** 旧名字（别处可能引用）—— 指着同一个默认值 */
export const AUTO_RATIO = DEFAULT_AUTO_RATIO

export interface CompactRatios {
  /** 到这个占比提醒可以压缩 */
  warn?: number
  /** 到这个占比后台自动压缩 */
  auto?: number
}

export interface CompactAdvice {
  used: number
  limit: number
  ratio: number
  warn: boolean
  auto: boolean
}

export function adviseCompact(
  messages: readonly Message[],
  maxTokens: number,
  ratios: CompactRatios = {},
  modelWindow?: number | null,
): CompactAdvice {
  /* 用量只算**压缩点之后**那一段（见 contextMessages） */
  const used = estimateMessages(contextMessages(messages))
  const limit = resolveLimit(maxTokens, modelWindow)
  const warnAt = Number.isFinite(ratios.warn) ? Number(ratios.warn) : DEFAULT_WARN_RATIO
  const autoAt = Number.isFinite(ratios.auto) ? Number(ratios.auto) : DEFAULT_AUTO_RATIO
  const ratio = used / limit
  return { used, limit, ratio, warn: ratio >= warnAt, auto: ratio >= autoAt }
}

/** 生成一条「压缩点」消息，插在消息流里让用户看得见 */
function compactMarker(summary: string, count: number): Message {
  return {
    id: uid('compact'),
    threadId: '',
    role: 'system',
    content: `已压缩前 ${count} 条对话（之后会以摘要形式带上）`,
    kind: 'text',
    status: 'sent',
    timestamp: Date.now(),
    /* 覆盖到第几条 —— 上下文用量从此之后算起（真机反馈 12b） */
    compactUpTo: count,
    /* 摘要正文挂在这里，点开压缩点能看到 */
    reasoning: summary,
  }
}

export interface CompactOutcome {
  ok: boolean
  error?: string
  /** 压缩掉了多少条 */
  count?: number
}

/**
 * 压缩指定线程。
 *
 * @param threadId
 * @param silent 自动触发时传 true（不弹成功提示，只留消息流里那条记录）
 */
export async function runCompact(threadId: string, silent = false): Promise<CompactOutcome> {
  const app = useAppStore.getState()
  const ui = useUIStore.getState()
  const thread = app.threads.find((t) => t.id === threadId)
  if (!thread) return { ok: false, error: '找不到这条对话' }

  /* 太短就没必要压，压了反而丢信息 */
  /* 用和内核算用量同一套筛选（见 usableOf）—— 不然 upTo 会和内核切的地方错位 */
  const usable = usableOf(thread.messages)
  if (usable.length <= KEEP_RECENT + 2) {
    if (!silent) ui.showToast('info', '不需要压缩', `对话还很短（${usable.length} 条）`)
    return { ok: false, error: '对话太短' }
  }

  const toCompact = usable.slice(0, usable.length - KEEP_RECENT)
  const payload = toCompact.map((m) => ({ role: m.role, content: m.content }))

  try {
    const result = await compactChat({ model: thread.model, messages: payload })
    if (!result.ok || !result.summary) {
      throw new Error(result.error ?? '生成摘要失败')
    }

    /* 记到会话文件（第 toCompact 条之前的内容被摘要覆盖了） */
    await appendCompact(threadId, result.summary, toCompact.length)

    /* 界面：在消息流里插入压缩点，让用户知道上下文被收窄了 */
    const app2 = useAppStore.getState()
    const parsedState = parseStructuredSummary(result.summary)
    if (parsedState) app2.updateConversationState(threadId, parsedState)
    const marker = compactMarker(result.summary, toCompact.length)
    app2.addMessage(threadId, { ...marker, threadId })

    if (!silent) {
      ui.showToast('success', '已压缩', `${toCompact.length} 条对话 → 一段摘要`)
    }
    return { ok: true, count: toCompact.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!silent) ui.showToast('error', '压缩失败', message)
    return { ok: false, error: message }
  }
}

function parseStructuredSummary(summary: string): Partial<ConversationState> | null {
  const sections: Record<string, string> = {}
  const re = /^##\s+([^\n]+)\n([\s\S]*?)(?=^##\s+|$)/gm
  let match
  while ((match = re.exec(summary)) !== null)
    sections[match[1].trim().toLowerCase()] = match[2].trim()
  if (Object.keys(sections).length === 0) return null
  const list = (key: string) =>
    (sections[key] ?? '')
      .split(/\n/)
      .map((x) => x.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean)
  return {
    topic: sections.goal ?? '',
    goal: sections.goal ?? '',
    currentFocus: sections['next step'] ?? '',
    decisions: list('decisions'),
    constraints: list('constraints'),
    openQuestions: list('unresolved problems'),
    nextStep: sections['next step'] ?? '',
    entities: [],
    lastUpdated: new Date().toISOString(),
    version: 1,
  }
}

/** 发消息前的自动检查：到线了就压。返回是否压过 */
export async function maybeAutoCompact(
  threadId: string,
  maxTokens: number,
  ratios: CompactRatios = {},
  modelWindow?: number | null,
): Promise<boolean> {
  const thread = useAppStore.getState().threads.find((t) => t.id === threadId)
  if (!thread) return false

  const advice = adviseCompact(thread.messages, maxTokens, ratios, modelWindow)
  if (!advice.auto) return false

  const result = await runCompact(threadId, true)
  if (result.ok) {
    useUIStore
      .getState()
      .showToast('info', '上下文较长，已自动压缩', `${result.count} 条对话收成一段摘要`)
  }
  return result.ok
}
