import type { AgentPhase, Message, MessageRound, ToolRunRecord } from '@/types'
import { uid } from '@/lib/utils'
import { useAppStore } from '../useAppStore'
import { usePerfStore } from '../usePerfStore'
import { summarizeArgs } from './parseToolOutput'
import { applyToolProgress } from './toolProgress'
/* 子代理 v1：它内部的每一步落到那次 `spawn_subagent` 调用上 */
import { applySubagentEvent } from './subagentEvents'
import { citationsOf } from './toolCitations'
import { handleAttachmentEvent } from './attachmentEvents'
import { reconcileFinalRounds } from './finalRounds'
import { applyPauseAfterTurn } from './confirmEvents'
import { handleCardEvent } from './cardEvents'
import { logError } from '@/lib/actionLog'
import { endedNow } from './turnTiming'
import { refreshAfterTool } from './toolRefresh'
/* 重试回滚 + 提示类事件（那边有来由；回滚规则见 retryRollback.ts） */
import { dispatchLightEvent } from './streamLight'
import { markRoundStart, type RetryMarks } from './retryRollback'

/* 流式事件落到消息；跨层接线必须真跑，空占位事故见 docs/踩坑记录.md。 */

export interface StreamState {
  /** 消息的累积内容（分片事件会不断追加） */
  content: string
  reasoning: string
  toolRuns: ToolRunRecord[]
  /**
   * 一轮一轮的片段（思考 / 工具下标 / 正文），顺序即发生顺序，聚合字段拼不出先后。
   * ⚠️ 改完必须 `patch({ rounds: syncRounds(state) })`，否则整场流式退回三段堆叠。
   */
  rounds: MessageRound[]
  citations: NonNullable<Message['citations']>
  /** 把字段写回那条流式消息 */
  patch: (fields: Partial<Message>) => void
  /** 这一刻的消息对象（`done` 里要拿完整字段落盘） */
  snapshot: () => Message
  /** 收尾（取消订阅、清计时器、把 sending 置回 false） */
  finish: () => void
  threadId: string
  /** 本轮起点 —— `retry` 时退回它，否则「半截 + 整段重说」显示两遍（见 retryRollback.ts） */
  retryMarks: RetryMarks
}

/** 当前轮；一片内容都没收到就先把第一轮开出来（不依赖 turn_start 一定到达） */
function currentRound(state: StreamState): MessageRound {
  const last = state.rounds[state.rounds.length - 1]
  if (last) return last
  const fresh: MessageRound = { reasoning: '', content: '', tools: [] }
  state.rounds.push(fresh)
  /*
   * 懒建出来的这一轮 = 本轮起点，顺手把重试标记对齐到「现在」（没有 turn_start 的
   * 那一轮很常见；标记若还停在 0，一次重试会把前面所有的话都退掉）。
   */
  state.retryMarks = markRoundStart(state.content, state.reasoning, state.rounds)
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
      /* 先取轮、再累加：懒建那一轮时标记要记「加这片之前」的长度（见 currentRound） */
      const round = currentRound(state)
      state.content += String(event.text ?? '')
      round.content += String(event.text ?? '')
      state.patch({ content: state.content, rounds: syncRounds(state) })
      return { handled: true }
    }

    case 'reasoning': {
      if (!state.content && !state.reasoning) usePerfStore.getState().markFirstContent()
      const round = currentRound(state)
      state.reasoning += String(event.text ?? '')
      round.reasoning += String(event.text ?? '')
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

    /* 长任务自己报的进度（真机反馈 9a）—— 只改那一条记录，规矩见 toolProgress.ts */
    case 'agent.tool.progress': {
      if (applyToolProgress(state.toolRuns, event)) {
        state.patch({ toolRuns: [...state.toolRuns] })
      }
      return { handled: true }
    }

    /* 子代理 v1：它内部的每一步（实现在 subagentEvents.ts）—— 同样只改那一条记录 */
    case 'subagent.step': {
      if (applySubagentEvent(state.toolRuns, event)) state.patch({ toolRuns: [...state.toolRuns] })
      return { handled: true }
    }

    case 'agent.tool.completed':
    case 'agent.tool.failed': {
      const id = String(event.toolCallId ?? '')
      const index = state.toolRuns.findIndex((run) => run.id === id)
      const output = String(event.result ?? '')

      const updated: ToolRunRecord = {
        ...state.toolRuns[index] /* 保住 subagent trace（重建新对象会把它抹掉） */,
        id,
        name: String(event.name ?? '未知工具'),
        ok: event.ok !== false,
        output,
        ms: typeof event.ms === 'number' ? event.ms : undefined,
      }

      if (index >= 0) state.toolRuns[index] = updated
      else state.toolRuns.push(updated)

      /*
       * 消息状态变了，别的面板得知道（任务台账的进度时间线 + 底栏运行日志）。
       * 两条为什么必须走事件驱动、为什么是 `void` —— 见 `toolRefresh.ts` 的文件头。
       */
      refreshAfterTool()

      /* 工具输出里能捞出引用（文件 / 网页）—— 见 toolCitations.ts */
      const cited = citationsOf(event, output)
      if (cited.length > 0) {
        state.citations.push(...cited)
        state.patch({ citations: [...state.citations] })
      }

      /* 工具跑完 → 那一行从「转圈」变成「耗时」（rounds 顺带同步，成本可忽略） */
      state.patch({ toolRuns: [...state.toolRuns], rounds: syncRounds(state) })
      return { handled: true }
    }

    /* 交互卡（写操作确认 / 两类卡的超时作废）—— 实现在 confirmEvents.ts，这里只转发 */
    case 'confirm_request':
    case 'clarify.timeout':
    case 'confirm.timeout':
      return { handled: handleCardEvent(event, type) }

    /* 新一轮开始 —— 时间线在这里分段（以前被 default 吞掉，「哪段思考属于哪轮」就丢了） */
    case 'turn_start': {
      state.rounds.push({ reasoning: '', content: '', tools: [] })
      /* 新一轮 = 新的重试起点（重试只退本轮的半截，前面几轮一个字不动） */
      state.retryMarks = markRoundStart(state.content, state.reasoning, state.rounds)
      /* 立刻挂到消息上 —— 否则新的一轮要等它出了第一个字才在界面上出现 */
      state.patch({ rounds: syncRounds(state) })
      return { handled: true }
    }

    /* ── 结束 ── */
    case 'done': {
      const finalContent = String(event.content ?? '') || state.content
      /* ★ 顺序：**先收尾，再写字段** —— patch 一抛，finish 就永远轮不到（2026-10-04 事故） */
      runSafely('done.finish', () => state.finish())
      /* 后台汇总可能不同于逐轮流式正文；对齐规则在 finalRounds.ts（含「整段显示两遍」的事故） */
      state.rounds = reconcileFinalRounds(state.rounds, finalContent)
      runSafely('done.patch', () =>
        state.patch({
          content: finalContent,
          reasoning: String(event.reasoning ?? '') || state.reasoning,
          /* 用时：起点是这条消息的 timestamp（按下发送那一刻），终点是现在 */
          durationMs: endedNow(state),
          usage: (event.usage ?? undefined) as Message['usage'],
          toolRuns: [...state.toolRuns],
          /* 时间线：逐轮复制一份 —— 别和 state 里的草稿共享引用 */
          rounds: state.rounds.map((round) => ({ ...round, tools: [...round.tools] })),
          citations: [...state.citations],
          status: 'sent',
          kind: 'text',
        }),
      )
      /* 批⑤：「先不做了」的收尾必须等 done（主进程收尾写完才写得上 paused，见 confirmEvents） */
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
          /* 被停掉的那条也有用时（停在哪一刻就是哪一刻）—— 别因为「没正常结束」就不记 */
          durationMs: endedNow(state),
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
        state.patch({
          status: 'error',
          kind: 'error',
          errorText: message,
          content: message,
          /* 失败也算「用户等了多久」，照实记 */
          durationMs: endedNow(state),
        }),
      )
      return { handled: true }
    }

    /* 长消息落了文件：在消息流里留一行看得见的提示（不静默换掉用户贴的东西） */
    case 'attachment': {
      runSafely('attachment', () => handleAttachmentEvent(state.threadId, event))
      return { handled: true }
    }

    /* 重试 / 提示类事件整块在 streamLight.ts（重试要先把半截退掉，否则同段话两遍） */
    case 'retry':
    case 'boundary':
    case 'budget':
    case 'notice':
    case 'fallback':
    case 'context_overflow':
      return { handled: dispatchLightEvent(type, event, state) }

    /*
     * 这些不落到消息上，也不打扰用户：
     *   turn_end —— 进度，界面靠线程状态体现（phase）；mode / route —— 属调试信息；
     *   task —— 任务台账走 IPC 读（任务中心），不走事件流
     */
    case 'plan': {
      /* AG-004：计划变了 → 让 useTaskStore 重读（和工具跑完走同一条刷新，见 toolRefresh.ts） */
      refreshAfterTool()
      return { handled: true }
    }

    default:
      return { handled: false }
  }
}
