import type { StoredMessage } from '@/types/backend'
import type { Message, MessageRound, ToolRunRecord } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { shouldFlushPartial } from '@/lib/partialFlush'
import { mergeReplySnapshot } from './replySnapshot'
import { logAction } from '@/lib/actionLog'

/* ══════════════════════════════════════════════════════════════
   助手回复的落盘

   从 turns.ts 抽出来的（那边贴到 300 行上限了），顺便让它可测 ——
   以前这两段是埋在发送流程里的闭包，只能靠真机试。

   两条来由：

   ① 助手那条**只在 done / aborted 时落盘**。进程被强杀 / 崩溃时这两个事件
      都不会来，于是半截回复全丢（实测：会话文件里只剩用户那句）。
      → 所以有了 flushPartial：流式过程中分段落盘。

   ② 分段落盘会往同一个 key 追加好几行（会话文件是追加式的，没地方原地更新），
      收尾那条也带同一个 key，读的一侧按 key 收敛成一条。
   ══════════════════════════════════════════════════════════════ */

export interface ReplyPersistence {
  flushPartial: () => void
  persistReply: () => void
}

/**
 * 分段快照里的工具记录：**去掉 `output` 正文**。
 *
 * ★ 为什么必须去掉（2026-10-20）：快照每 3 秒按「长了 10%」重写一次，而工具输出
 *   平均 1.3KB、最长 16KB（真机 22709 条统计）。连 output 一起写，一次长任务的
 *   快照总量会翻好几倍 —— 而快照存在的唯一目的是「进程被打断时别什么都不剩」。
 *   留下名字 / 参数摘要 / 成败 / 耗时，就足够让用户看出「它跑过什么」；
 *   完整输出在收尾那条里（`persistReply` 写全量）。
 */
function traceOf(toolRuns: ToolRunRecord[] | undefined): ToolRunRecord[] {
  return (toolRuns ?? []).map((run) => ({
    id: run.id,
    name: run.name,
    ...(run.summary ? { summary: run.summary } : {}),
    ok: run.ok,
    output: '',
    ...(run.ms === undefined ? {} : { ms: run.ms }),
    ...(run.subagent ? { subagent: run.subagent } : {}),
    ...(run.pending ? { pending: true } : {}),
    ...(run.sourcePath ? { sourcePath: run.sourcePath } : {}),
    ...(run.retryOf ? { retryOf: run.retryOf } : {}),
    ...(run.retryAttempt ? { retryAttempt: run.retryAttempt } : {}),
    ...(run.recoveredBy ? { recoveredBy: run.recoveredBy } : {}),
  }))
}

export function createReplyPersistence(opts: {
  threadId: string
  messageId: string
  timestamp: number
  /**
   * 这一轮答的是哪条提问、第几版 —— 落盘时带上。
   * 读会话时靠它把「同一次提问的几个回答」收成一条的多个版本
   * （以前没有这个标记，编辑/重生成产生的回答会并排堆在会话里）。
   */
  answersKey?: string
  answersVersion?: number
  /**
   * 这条回答是「重新生成」来的：指向被替代的那条回答（磁盘 key）。
   * 分段快照与收尾那条都带上 —— 进程被强杀后重开，也知道它是从哪条重来的。
   */
  regeneratedFrom?: string
  /**
   * 这次执行的身份（= 发送时的 `requestId`）。
   *
   * ── 为什么它必须落盘（2026-11-09）──────────────────────────────
   * 「一次发送 / 一次继续 / 一次重新生成」以前在磁盘上**没有痕迹**：
   * 重启后只看得出「这条答复在哪个会话里」，看不出「它是哪一次跑出来的」。
   * 于是继续原任务、重生成同一轮之后再回放，三次执行糊成一段。
   *
   * 现在每条落盘都带 `execId`，读侧能按它把同一次执行的记录收在一起。
   * 老记录没有这个字段 → 保持「不知道是哪次」的原样，**不去猜**。
   */
  execId?: string
  /*
   * 注意：**归属不再从这里传**。请求里的 `resumeTaskId` 只是「想恢复的目标」，
   * 主进程可能判定它不可用而新建一条 —— 所以真实归属改由 `task` 事件回送到消息上，
   * 落盘时现取（见下面 `taskField`）。老记录没有这个字段 → 不猜。
   */
  getContent: () => string
  getReasoning: () => string
  getEventType: () => string
  getSnapshot?: () => Message
}): ReplyPersistence {
  const { threadId, messageId, timestamp, getContent, getReasoning, getEventType } = opts
  // UI 提供展示字段，独立流快照提供当前执行数据；不依赖占位消息始终存在。
  const current = (): {
    rounds: MessageRound[]
    toolRuns: ToolRunRecord[]
    flow: StoredMessage['flow']
    execTaskId: string | undefined
    extras: Pick<Message, 'inputReplies' | 'citations' | 'artifacts' | 'collaboration'>
  } => {
    const stored = useAppStore
      .getState()
      .threads.find((t) => t.id === threadId)
      ?.messages.find((m) => m.id === messageId)
    const message = mergeReplySnapshot(stored, opts.getSnapshot?.())
    return {
      rounds: message?.rounds ?? [],
      toolRuns: message?.toolRuns ?? [],
      execTaskId: message?.execTaskId,
      flow: message?.flow,
      extras: {
        inputReplies: message?.inputReplies,
        collaboration: message?.collaboration,
        citations: message?.citations,
        artifacts: message?.artifacts,
      },
    }
  }
  const answer = {
    ...(opts.answersKey ? { answersKey: opts.answersKey } : {}),
    ...(opts.answersVersion !== undefined ? { answersVersion: opts.answersVersion } : {}),
    ...(opts.regeneratedFrom ? { regeneratedFrom: opts.regeneratedFrom } : {}),
    ...(opts.execId ? { execId: opts.execId } : {}),
    /*
     * 轨迹格式标识：凡是从这里写出去的记录，`rounds` 都是**执行时按事件到达顺序
     * 攒下来的**（不是读侧合成的）。带上它，重启后读取端才知道「这份顺序可信，
     * 可以直接回放」。老记录没有这一位 → 走兼容路径（见 types/models-session.ts）。
     */
    trace: 'ordered-v1' as const,
  }
  let lastFlushAt = 0
  let lastFlushLen = 0

  /**
   * 真实任务归属这一行 —— **每次落盘现取**，不是静态值。
   *
   * `task` 事件在流式中途才到（主进程先建台账再跑循环），所以快照落盘时它可能
   * 已经挂上、也可能还没挂上；收尾那条一定能取到。放进 `answer` 的话就会被
   * 首次取值冻住（那正是「续做较早答复时归属不更新」的老毛病）。
   */
  const taskField = (): { execTaskId?: string } => {
    const id = current().execTaskId
    return id ? { execTaskId: id } : {}
  }

  return {
    /*
     * 流式过程中分段落盘。
     *
     * 节奏交给 shouldFlushPartial（至少隔几秒、且内容长了才写）。
     *
     * ★ 2026-10-20 补：**快照也要带痕迹**（`rounds` + 轻量 `toolRuns`）。
     *
     *   以前这里只写 content / reasoning，理由是「工具日志每几秒重写一遍太浪费」。
     *   代价是：**这一轮被打断（崩溃 / 强杀 / 用户停止）时，磁盘上只剩正文和思考，
     *   思考块与工具行全没了** —— 读回来那条消息只有一大段文字，用户看到的就是
     *   「工作痕迹不见了」（真机复现：25 轮里 23 个思考块、33 次工具调用全丢，
     *   只剩「这条回复没写完」那句话）。
     *
     *   所以现在带上 rounds（分段是「哪段思考属于哪一轮」的唯一来源）和去掉
     *   `output` 正文的工具记录（见 traceOf：平均 1.3KB、最长 16KB，全量写会把
     *   快照量翻好几倍）。收尾那条仍然写全量。
     */
    flushPartial: () => {
      const content = getContent()
      const reasoning = getReasoning()
      const { rounds, toolRuns: runs, flow, extras } = current()
      const traces = traceOf(runs)
      const now = Date.now()
      /*
       * ★ 度量用「正文 + 思考」：只看正文的话，一段长思考（或纯工具轮）期间
       *   磁盘上什么都没有（2026-10-04 事故现场：8 分钟没写一次）。
       *   间隔规则照旧（至少 3 秒），所以不会把写入量抬上去。
       */
      const metric = content.length + reasoning.length
      const force =
        getEventType() === 'collab.phase' ||
        (flow && /^agent\.tool\.(started|completed|failed)$/.test(getEventType()))
      if (!force && !shouldFlushPartial(metric, lastFlushLen, now, lastFlushAt)) return
      lastFlushAt = now
      lastFlushLen = metric
      useAppStore.getState().persistMessage(threadId, {
        role: 'assistant',
        key: messageId,
        partial: true,
        content,
        ...(reasoning ? { reasoning } : {}),
        ...(flow ? { flow } : {}),
        ...(!flow && rounds.length
          ? { rounds: rounds.map((round) => ({ ...round, tools: [...round.tools] })) }
          : {}),
        ...(traces.length ? { toolRuns: traces } : {}),
        ...extras,
        ...answer,
        ...taskField(),
        ts: timestamp,
      })
    },

    /*
     * 收尾。**只在收到结束事件时调用**。
     *
     * 存的是**收尾后状态里的那条消息**，不是闭包里那几个变量：usage 只在状态里，
     * toolRuns 在流式过程中被复制过几份，读它更稳。
     * aborted 也存 —— 那是用户自己按停的，半截回复也是结果；error 不存，
     * 把报错当历史喂回模型没有意义。
     */
    persistReply: () => {
      const type = getEventType()
      if (type !== 'done' && type !== 'aborted') return
      const stored = useAppStore
        .getState()
        .threads.find((t) => t.id === threadId)
        ?.messages.find((m) => m.id === messageId)
      const final = mergeReplySnapshot(stored, opts.getSnapshot?.())
      // 兼容未提供独立快照的旧调用方；新执行在 UI 消息缺失时仍保留完整痕迹。
      if (!final) {
        const text = getContent()
        if (!text.trim()) return
        const reasoning = getReasoning()
        useAppStore.getState().persistMessage(threadId, {
          role: 'assistant',
          key: messageId,
          content: text,
          ...(reasoning ? { reasoning } : {}),
          ...(type === 'aborted' ? { aborted: true } : {}),
          ...answer,
          ...taskField(),
          ts: timestamp,
        })
        return
      }
      const text = final.content ?? ''
      if (!text.trim() && (final.toolRuns ?? []).length === 0) return
      const message: StoredMessage = {
        role: 'assistant',
        key: messageId,
        content: text,
        ...(final.reasoning ? { reasoning: final.reasoning } : {}),
        ...(final.toolRuns?.length ? { toolRuns: final.toolRuns } : {}),
        ...(final.flow ? { flow: final.flow } : {}),
        ...(!final.flow && final.rounds?.length ? { rounds: final.rounds } : {}),
        ...(final.verdict ? { verdict: final.verdict } : {}),
        /*
         * 用时（2026-10-21）：**只有真拿到终点才写**。
         *
         * `final.durationMs` 由 `streamEvents.ts` 在 done / aborted / error 里算出来，
         * 起止点口径写在 `types/conversation.ts` 的字段注释里。这里不做兜底推算 ——
         * 拿 `Date.now() - timestamp` 现算会把「落盘延迟」也算进去（收尾到落盘之间
         * 还有几步），而且进程重启后根本没有终点。没有就不写，界面显示「N 步」。
         */
        ...(typeof final.durationMs === 'number' && final.durationMs > 0
          ? { durationMs: final.durationMs }
          : {}),
        ...(final.clarify ? { clarify: final.clarify } : {}),
        ...(final.citations?.length ? { citations: final.citations } : {}),
        ...(final.inputReplies?.length ? { inputReplies: final.inputReplies } : {}),
        ...(final.collaboration ? { collaboration: final.collaboration } : {}),
        ...(final.artifacts?.length ? { artifacts: final.artifacts } : {}),
        ...(final.usage ? { usage: final.usage } : {}),
        ...(final.truncated ? { truncated: final.truncated } : {}),
        ...(type === 'aborted' || final.interrupted ? { aborted: true } : {}),
        ...answer,
        ...taskField(),
        ts: final.timestamp,
      }
      useAppStore.getState().persistMessage(threadId, message)
      if (final.collaboration)
        logAction(
          'collaboration.persist.enqueued',
          `${final.collaboration.id}:${final.collaboration.status}:ui=${!!stored}`,
        )
    },
  }
}
