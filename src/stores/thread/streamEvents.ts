import type { AgentPhase, Message, ToolRunRecord } from '@/types'
import { uid } from '@/lib/utils'
import { confirmChat } from '@/lib/backend'
import { useAppStore } from '../useAppStore'
import { useTaskStore } from '../useTaskStore'
import { useUIStore } from '../useUIStore'
import { usePerfStore } from '../usePerfStore'
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
 * AG-002：生命周期事件用的是标准名（`agent.*`），而且**每条都带 phase 字段**。
 *
 * 判断只看 `phase` 字段，不看事件名 —— 名字将来再改也不影响这里。
 * `agent.tool.*` 是工具事件，不属于生命周期，排除在外。
 */
function isLifecycleEvent(type: string): boolean {
  if (type === 'phase') return true
  return type.startsWith('agent.') && !type.startsWith('agent.tool.')
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

  /*
   * AG-001 + AG-002：生命周期阶段由主进程的状态机推过来，渲染层照单收下 ——
   * 不自己算。以前是「发消息就置 running、结束按事件猜 success/error」，
   * 那种做法下 UI 和后台随时可能不一致。
   */
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
      state.patch({ content: state.content })
      return { handled: true }
    }

    case 'reasoning': {
      if (!state.content && !state.reasoning) usePerfStore.getState().markFirstContent()
      state.reasoning += String(event.text ?? '')
      state.patch({ reasoning: state.reasoning })
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
      state.patch({ toolRuns: [...state.toolRuns] })
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
      const kind = String(event.kind ?? '')
      const risk = (event.risk ?? null) as { level?: string } | null
      const high = risk?.level === 'high'

      /*
       * AG-013：把「要不要允许」说成人话，并且**说清「本次」的范围**。
       * 以前的标题是「模型请求执行：run_shell」—— 那是内部名字，
       * 用户既看不懂、也不知道批了之后会发生什么。
       */
      const KIND_TEXT: Record<string, string> = {
        write: '修改文件',
        mcp: '调用外部工具',
        risk: '执行命令',
        path: '访问工作目录之外的文件',
      }
      /* 和 core/tools/approval.cjs 的 REMEMBERED 保持一致 */
      const remembered = kind === 'write' || kind === 'mcp'

      useUIStore.getState().askPermission({
        kind: 'run-command',
        title: high
          ? `⚠ 高风险：${KIND_TEXT[kind] ?? toolName}`
          : `Agent 准备${KIND_TEXT[kind] ?? `执行 ${toolName}`}`,
        description: [
          String(event.summary ?? ''),
          remembered ? '同意后，**本轮**内同类操作不再询问。' : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        confirmText: '允许本次',
        danger: high,
        /* AG-036：会改成什么样（没有就不传，弹窗里也不会出现「查看 Diff」） */
        diff: Array.isArray(event.diff) ? event.diff : undefined,
        diffNote: String(event.diffNote ?? ''),
        impact: Array.isArray(event.impact) ? event.impact.map(String) : [],
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
    case 'budget': {
      /* 拦住的情况不在这里提示 —— 那种会直接抛错，错误气泡里已经有原因了 */
      if (event.blocked !== true && event.exceeded === true) {
        useUIStore.getState().showToast('warning', '用量已到上限', String(event.message ?? ''))
      }
      return { handled: true }
    }

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
