import type { ConversationState, Message } from '@/types'
import { uid } from '@/lib/utils'
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

/** 低于这个比例不提示；超过「提示线」提醒，超过「自动线」直接压 */
const WARN_RATIO = 0.4
export const AUTO_RATIO = 0.6

export interface CompactAdvice {
  used: number
  limit: number
  ratio: number
  warn: boolean
  auto: boolean
}

export function adviseCompact(messages: readonly Message[], maxTokens: number): CompactAdvice {
  const used = estimateMessages(messages)
  const limit = Math.max(2000, maxTokens || 4096)
  const ratio = used / limit
  return { used, limit, ratio, warn: ratio >= WARN_RATIO, auto: ratio >= AUTO_RATIO }
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
  const usable = thread.messages.filter((m) => m.role !== 'system' && m.content.trim())
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
export async function maybeAutoCompact(threadId: string, maxTokens: number): Promise<boolean> {
  const thread = useAppStore.getState().threads.find((t) => t.id === threadId)
  if (!thread) return false

  const advice = adviseCompact(thread.messages, maxTokens)
  if (!advice.auto) return false

  const result = await runCompact(threadId, true)
  if (result.ok) {
    useUIStore
      .getState()
      .showToast('info', '上下文较长，已自动压缩', `${result.count} 条对话收成一段摘要`)
  }
  return result.ok
}
