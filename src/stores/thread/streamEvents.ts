import type { AgentPhase, Message, MessageRound, ToolRunRecord } from '@/types'
import { uid } from '@/lib/utils'
import { useAppStore } from '../useAppStore'
import { useTaskStore } from '../useTaskStore'
import { useAuditStore } from '../useAuditStore'
import { usePerfStore } from '../usePerfStore'
import { parseFileCitation, parseSearchCitations, summarizeArgs } from './parseToolOutput'
import { handleNoticeEvent } from './noticeEvents'
import { handleAttachmentEvent } from './attachmentEvents'
import { askPermissionFor, applyPauseAfterTurn, onClarifyTimeout } from './confirmEvents'
import { logError } from '@/lib/actionLog'

/* ══════════════════════════════════════════════════════════════
   流式聊天事件的处理：每种事件怎么落到消息上（turns.ts 只管发起、收尾、中断）。
   ⚠️ 拆这个文件踩过的坑：只留空函数占位 → tsc 全绿但流式/工具/引用全不更新；
   这类跨层接线必须真跑一遍（详见 docs/踩坑记录.md）。
   ══════════════════════════════════════════════════════════════ */

export interface StreamState {
  /** 消息的累积内容（分片事件会不断追加） */
  content: string
  reasoning: string
  toolRuns: ToolRunRecord[]
  /**
   * 一轮一轮的片段（思考 / 工具下标 / 正文）—— 顺序就是发生顺序；三个聚合字段拼不出先后。
   * ⚠️ 改完必须 `patch({ rounds: syncRounds(state) })`：只在 `done` 时挂的话，
   * 整场流式会退回三段堆叠（2026-09-30 用户报的「流式排版太乱」根因）。
   */
  rounds: MessageRound[]
  citations: NonNullable<Message['citations']>
  /** 把字段写回那条流式消息 */
  patch: (fields: Partial<Message>) => void
  /** 这一刻的消息对象（`done` 事件里要拿完整字段落盘） */
  snapshot: () => Message
  /** 收尾（取消订阅、清计时器、把 sending 置回 false） */
  finish: () => void
  threadId: string
}

/** 当前轮；一片内容都没收到就先把第一轮开出来（不依赖 turn_start 一定到达） */
function currentRound(state: StreamState): MessageRound {
  const last = state.rounds[state.rounds.length - 1]
  if (last) return last
  const fresh: MessageRound = { reasoning: '', content: '', tools: [] }
  state.rounds.push(fresh)
  return fresh
}

/** 把分轮草稿同步到消息上（浅拷贝外层）；不复制的话引用没变 → 界面不重渲 */
function syncRounds(state: StreamState): MessageRound[] {
  return [...state.rounds]
}

/**
 * 收尾链上的每一步都单独兜住：任何一步抛异常都不许把后面的带走，抛了就记一笔
 * （进 `data/errors/*.jsonl`）。2026-10-04 真机事故的根因与证据链见 docs/踩坑记录.md。
 */
function runSafely(where: string, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    logError(`stream.${where}`, error)
  }
}

/** AG-002：判断只看 `phase` 字段（事件名将来再改也不影响）；`agent.tool.*` 不算生命周期 */
function isLifecycleEvent(type: string): boolean {
  if (type === 'phase') return true
  return type.startsWith('agent.') && !type.startsWith('agent.tool.')
}

/**
 * 处理一个来自主进程的事件。返回值告诉调用方要不要接着跑后置动作（目前只有 done 需要），
 * 这样 turns.ts 不用把每种事件的后续逻辑都写一遍。
 */
export function handleStreamEvent(
  event: Record<string, unknown>,
  state: StreamState,
): { handled: boolean; notifyDone?: boolean } {
  const type = String(event.type ?? '')

  /* AG-001/AG-002：阶段由主进程的状态机推过来，渲染层照单收下 —— 不自己算（否则 UI 与后台随时可能不一致） */
  if (isLifecycleEvent(type)) {
    const phase = String(event.phase ?? '') as AgentPhase
    if (phase) {
      state.patch({ phase })
      useAppStore.getState().setThreadPhase(state.threadId, phase)
    }
    return { handled: true }
  }

  switch (type) {
    /* ── 内容与思考：分片追加 ── */
    case 'content': {
      /* AG-037：「首字上屏」—— 只在**第一个**字时记一次（这一轮的第一个字） */
      if (!state.content && !state.reasoning) usePerfStore.getState().markFirstContent()
      state.content += String(event.text ?? '')
      currentRound(state).content += String(event.text ?? '')
      state.patch({ content: state.content, rounds: syncRounds(state) })
      return { handled: true }
    }

    case 'reasoning': {
      if (!state.content && !state.reasoning) usePerfStore.getState().markFirstContent()
      state.reasoning += String(event.text ?? '')
      currentRound(state).reasoning += String(event.text ?? '')
      state.patch({ reasoning: state.reasoning, rounds: syncRounds(state) })
      return { handled: true }
    }

    /* ── 工具：开始先插一条 running 记录，结束时补结果 ── */
    case 'agent.tool.started': {
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
      /* 这一轮跑过这个工具 —— 记下标（记录本身不重复存） */
      currentRound(state).tools.push(state.toolRuns.length - 1)
      state.patch({ toolRuns: [...state.toolRuns], rounds: syncRounds(state) })
      return { handled: true }
    }

    case 'agent.tool.completed':
    case 'agent.tool.failed': {
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
       * AG-005：进度时间线的「动作行」读的是任务台账的 `steps`，
       * 而任务快照只在几个离散时机刷新（进入对话、对话状态变化）——
       * 工具执行期间 status 根本不变，于是时间线**永远看不到任何一步**。
       * 真机验证抓到的（单元测试照不到这种接线）。
       * 走事件驱动，别轮询；每个工具一次，量很小。
       */
      void useTaskStore.getState().refresh()
      /* 底栏那个运行日志也得跟着走 —— 它以前只在打开时拉一次，工具跑完一条都不动 */
      useAuditStore.getState().bump()

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

      /* 工具跑完 → 那一行从「转圈」变成「耗时」（rounds 顺带同步，成本可忽略） */
      state.patch({ toolRuns: [...state.toolRuns], rounds: syncRounds(state) })
      return { handled: true }
    }

    /* ── 写操作确认：弹给用户，用户点完回主进程（实现见 confirmEvents.ts）── */
    case 'confirm_request':
      askPermissionFor(event)
      return { handled: true }

    /*
     * AG-053 批③：澄清卡**离场超时**（用户走开太久，已按默认选项继续）。
     * 收卡 + 记进这条回复（实现见 confirmEvents.ts 的 onClarifyTimeout）。
     */
    case 'clarify.timeout':
      onClarifyTimeout(event)
      return { handled: true }

    /*
     * 新一轮开始 —— 时间线在这里分段。
     * 以前这个事件被 default 吞掉（那时的理由：「进度靠 phase 体现」），
     * 于是「哪段思考属于哪一轮」在渲染层就丢了。
     */
    case 'turn_start': {
      state.rounds.push({ reasoning: '', content: '', tools: [] })
      /* 立刻挂到消息上 —— 否则新的一轮要等它出了第一个字才在界面上出现 */
      state.patch({ rounds: syncRounds(state) })
      return { handled: true }
    }

    /* ── 结束 ── */
    case 'done': {
      const finalContent = String(event.content ?? '') || state.content
      /* ★ 顺序：**先收尾，再写字段** —— patch 一抛，finish 就永远轮不到（2026-10-04 事故） */
      runSafely('done.finish', () => state.finish())
      runSafely('done.patch', () =>
        state.patch({
          content: finalContent,
          reasoning: String(event.reasoning ?? '') || state.reasoning,
          usage: (event.usage ?? undefined) as Message['usage'],
          toolRuns: [...state.toolRuns],
          /* 时间线：逐轮复制一份 —— 别和 state 里的草稿共享引用 */
          rounds: state.rounds.map((round) => ({ ...round, tools: [...round.tools] })),
          citations: [...state.citations],
          status: 'sent',
          kind: 'text',
        }),
      )
      /*
       * 批⑤：「先不做了」的收尾。必须**放在这里**（而不是点按钮那一刻）——
       * done 是主进程那次收尾写（正常结束 → completed）**之后**才到的，
       * 这时候才写得上 `paused`。理由与踩坑过程写在 `confirmEvents` 的 `pauseAfterTurn`。
       */
      runSafely('done.pauseAfterTurn', () => applyPauseAfterTurn(String(event.requestId ?? '')))
      return { handled: true, notifyDone: true }
    }

    case 'aborted': {
      /* ★ 先收尾再写字段（同上）；标 `interrupted`：操作条据此把「重新生成」换成「重试」 */
      runSafely('aborted.finish', () => state.finish())
      runSafely('aborted.patch', () =>
        state.patch({
          status: 'sent',
          content: state.content,
          interrupted: true,
          /* 被停掉的那条也要留住时间线：落盘只认消息上的 rounds，不挂就存不下去 */
          rounds: syncRounds(state),
        }),
      )
      return { handled: true }
    }

    case 'error': {
      const message = String(event.message ?? '未知错误')
      runSafely('error.finish', () => state.finish())
      runSafely('error.patch', () =>
        state.patch({ status: 'error', kind: 'error', errorText: message, content: message }),
      )
      return { handled: true }
    }

    /* 长消息落了文件：在消息流里留一行看得见的提示（不静默换掉用户贴的东西） */
    case 'attachment': {
      runSafely('attachment', () => handleAttachmentEvent(state.threadId, event))
      return { handled: true }
    }

    /* ── 提示类事件：不改消息，但要让用户看见（实现见 noticeEvents.ts）── */
    case 'boundary':
    case 'budget':
    case 'notice':
    case 'retry':
    case 'fallback':
    case 'context_overflow':
    case 'review': {
      handleNoticeEvent(event)
      return { handled: true }
    }

    /*
     * 这些不落到消息上，也不打扰用户：
     *   turn_start / turn_end  —— 进度，界面靠线程状态体现（phase）
     *   mode / route           —— 意图分类与模型选择，属于调试信息
     *   task                   —— 任务台账走 IPC 读（见任务中心），不走事件流
     */
    case 'plan': {
      /*
       * AG-004：计划变了。事件里那份够画卡片，但任务的**版本历史**在台账里 ——
       * 让 useTaskStore 重读一遍，不在事件流里维护第二份真相。
       * 频率很低（只在计划真的变了才发），不值得再做个增量协议。
       */
      void useTaskStore.getState().refresh()
      return { handled: true }
    }

    default:
      return { handled: false }
  }
}
