import type { Message, ToolRunRecord } from '@/types'
import { uid } from '@/lib/utils'
import { confirmChat } from '@/lib/backend'
import { useUIStore } from '../useUIStore'
import { parseFileCitation, parseSearchCitations, summarizeArgs } from './parseToolOutput'

/* ══════════════════════════════════════════════════════════════
   流式聊天事件的处理

   从 turns.ts 拆出来的。turns.ts 现在只负责「发起、收尾、中断」，
   这里负责「每种事件怎么落到消息上」。

   ⚠️ 拆分的教训：一开始我在 turns.ts 里只留了个空函数占位就以为拆完了 ——
   tsc 全过，但**流式内容、工具过程、引用全都不再更新**。
   层与层之间的接线是测试照不到的，所以这份文件必须整体搬完再验证，
   不能留一半。
   ══════════════════════════════════════════════════════════════ */

export interface StreamState {
  /** 消息的累积内容（分片事件会不断追加） */
  content: string
  reasoning: string
  toolRuns: ToolRunRecord[]
  citations: NonNullable<Message['citations']>
  /** 把字段写回那条流式消息 */
  patch: (fields: Partial<Message>) => void
  /** 这一刻的消息对象（`done` 事件里要拿完整字段落盘） */
  snapshot: () => Message
  /** 收尾（取消订阅、清计时器、把 sending 置回 false） */
  finish: () => void
  threadId: string
}

/**
 * 处理一个来自主进程的事件。
 *
 * 返回值告诉调用方要不要接着做后置动作（目前只有 done 需要）。
 * 这样 turns.ts 不用把每种事件的后续逻辑都写一遍。
 */
export function handleStreamEvent(
  event: Record<string, unknown>,
  state: StreamState,
): { handled: boolean; notifyDone?: boolean } {
  const type = String(event.type ?? '')

  switch (type) {
    /* ── 内容与思考：分片追加 ── */
    case 'content': {
      state.content += String(event.text ?? '')
      state.patch({ content: state.content })
      return { handled: true }
    }

    case 'reasoning': {
      state.reasoning += String(event.text ?? '')
      state.patch({ reasoning: state.reasoning })
      return { handled: true }
    }

    /* ── 工具：开始先插一条 running 记录，结束时补结果 ── */
    case 'tool_start': {
      const record: ToolRunRecord = {
        id: String(event.toolCallId ?? uid('tool')),
        name: String(event.name ?? '未知工具'),
        summary: summarizeArgs(
          String(event.name ?? ''),
          (event.args ?? {}) as Record<string, unknown>,
        ),
        ok: true,
        output: '',
      }
      state.toolRuns.push(record)
      state.patch({ toolRuns: [...state.toolRuns] })
      return { handled: true }
    }

    case 'tool_end': {
      const id = String(event.toolCallId ?? '')
      const index = state.toolRuns.findIndex((run) => run.id === id)
      const output = String(event.result ?? '')

      const updated: ToolRunRecord = {
        id,
        name: String(event.name ?? '未知工具'),
        summary: state.toolRuns[index]?.summary,
        ok: event.ok !== false,
        output,
        ms: typeof event.ms === 'number' ? event.ms : undefined,
      }

      if (index >= 0) state.toolRuns[index] = updated
      else state.toolRuns.push(updated)

      /*
       * 工具输出里能捞出可追溯的东西：
       *   · 搜索结果是网页 → Web Citation（标题/URL/域名/抓取时间）
       *   · 读取文件 → 文件 Citation
       * 解析失败一律吞掉 —— 引用是加分项，不能因为格式怪就让整轮对话失败。
       */
      try {
        const path =
          typeof event.path === 'string'
            ? event.path
            : String((event.args as Record<string, unknown>)?.path ?? '')
        const found = event.name === 'read_file' ? parseFileCitation(output, path) : null
        const web = event.name === 'search_web' ? parseSearchCitations(output) : []
        const merged = [...(found ? [found] : []), ...web]
        if (merged.length > 0) {
          state.citations.push(...merged)
          state.patch({ citations: [...state.citations] })
        }
      } catch {
        /* 解析不出来就算了 */
      }

      state.patch({ toolRuns: [...state.toolRuns] })
      return { handled: true }
    }

    /* ── 写操作确认：弹给用户，用户点完回主进程 ── */
    case 'confirm_request': {
      const confirmId = String(event.confirmId ?? '')
      const toolName = String(event.toolName ?? '操作')

      useUIStore.getState().askPermission({
        kind: 'run-command',
        title: `模型请求执行：${toolName}`,
        description: String(event.summary ?? ''),
        confirmText: '允许',
        danger: true,
        onConfirm: () => void confirmChat(confirmId, true),
        /* 关掉弹窗也算拒绝 —— 不回话的话主进程会一直等到超时 */
        onCancel: () => void confirmChat(confirmId, false),
      })
      return { handled: true }
    }

    /* ── 结束 ── */
    case 'done': {
      const finalContent = String(event.content ?? '') || state.content
      state.patch({
        content: finalContent,
        reasoning: String(event.reasoning ?? '') || state.reasoning,
        usage: (event.usage ?? undefined) as Message['usage'],
        toolRuns: [...state.toolRuns],
        citations: [...state.citations],
        status: 'sent',
        kind: 'text',
      })
      state.finish()
      return { handled: true, notifyDone: true }
    }

    case 'aborted': {
      state.patch({ status: 'sent', content: state.content })
      state.finish()
      return { handled: true }
    }

    case 'error': {
      const message = String(event.message ?? '未知错误')
      state.patch({ status: 'error', kind: 'error', errorText: message, content: message })
      state.finish()
      return { handled: true }
    }

    /* ── 提示类事件：不改消息，但要让用户看见 ── */
    case 'retry': {
      useUIStore
        .getState()
        .showToast('warning', '正在重试', String(event.hint ?? '请求失败，稍后自动重试'))
      return { handled: true }
    }

    case 'fallback': {
      useUIStore
        .getState()
        .showToast('warning', '已换用一个供应商', `原因：${String(event.reason ?? '上一个不可用')}`)
      return { handled: true }
    }

    case 'context_overflow': {
      useUIStore.getState().showToast('info', '上下文太长', '用 /compact 压一下再继续，会比现在稳')
      return { handled: true }
    }

    case 'review': {
      if (event.status === 'started') {
        useUIStore.getState().showToast('info', '正在复核这次回答', '复核完会给出结论')
      }
      return { handled: true }
    }

    /*
     * 这些不落到消息上，也不打扰用户：
     *   turn_start / turn_end  —— 进度，界面靠线程状态体现
     *   mode / route           —— 意图分类与模型选择，属于调试信息
     *   plan / task            —— 任务台账走 IPC 读（见 TaskBanner），不走事件流
     */
    default:
      return { handled: false }
  }
}
