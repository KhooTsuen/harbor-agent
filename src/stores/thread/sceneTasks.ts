import type { Message } from '@/types'
import { sceneSuggest, sceneTitle } from '@/lib/sceneApi'
import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { useUIStore } from '@/stores/useUIStore'

/* ══════════════════════════════════════════════════════════════
   一轮对话结束后的杂活

   起标题、生成建议回复 —— 都不阻塞主线：失败了就当没发生，
   用户看到的是「标题还是老样子」，不是一条报错。

   起标题只在标题还是系统默认的时候做一次，否则会把用户
   手动改过的名字冲掉。
   ══════════════════════════════════════════════════════════════ */

/**
 * 该不该让模型重新起标题。
 *
 * 判据是 titleAuto —— 不能用「标题是不是空的」，因为发第一句话时
 * 已经拿那句话占了个位（否则看起来像没标题）。用户手动改过就不动了。
 */
function canAutoTitle(thread: { title: string; titleAuto?: boolean }): boolean {
  if (thread.titleAuto === false) return false
  const text = thread.title.trim()
  return text === '' || text === '新对话' || text === '没有打开的对话' || thread.titleAuto === true
}

function digest(messages: readonly Message[]): Array<{ role: string; content: string }> {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }))
}

export async function runPostTurnTasks(threadId: string): Promise<void> {
  const app = useAppStore.getState()
  const thread = app.threads.find((t) => t.id === threadId)
  if (!thread) return

  const messages = digest(thread.messages)
  if (messages.length === 0) return

  /* ── 起标题 ── */
  if (canAutoTitle(thread)) {
    try {
      const result = await sceneTitle(messages)
      /* 再确认一次：这期间用户可能自己改过名字了 */
      const still = useAppStore.getState().threads.find((t) => t.id === threadId)
      if (result.ok && result.title && still && canAutoTitle(still)) {
        useAppStore.getState().autoTitle(threadId, result.title)
      }
    } catch {
      /* 起标题失败不值得打扰用户 */
    }
  }

  /* ── 建议回复 ── */
  try {
    const result = await sceneSuggest(messages)
    if (result.ok && result.suggestions?.length) {
      useThreadStore.getState().setSuggestions(threadId, result.suggestions)
    }
  } catch {
    /* 同上 */
  }
}

/** 手动触发一次建议（用户点了「再想几个」时用） */
export async function refreshSuggestions(threadId: string): Promise<void> {
  const thread = useAppStore.getState().threads.find((t) => t.id === threadId)
  if (!thread) return
  const result = await sceneSuggest(digest(thread.messages))
  if (result.ok && result.suggestions) {
    useThreadStore.getState().setSuggestions(threadId, result.suggestions)
  } else {
    useUIStore.getState().showToast('error', '没能给出建议', result.error)
  }
}
