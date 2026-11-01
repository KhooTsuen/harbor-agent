import type { StoredMessage } from '@/types/backend'
import type { MessageRound, ToolRunRecord } from '@/types'
import { useAppStore } from '@/stores/useAppStore'
import { shouldFlushPartial } from '@/lib/partialFlush'

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
  /** 流式过程中定期调用（判断很便宜，不满足就直接返回） */
  flushPartial: () => void
  /** 收到结束事件后调用一次 */
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
  }))
}

export function createReplyPersistence(opts: {
  threadId: string
  /** 占位消息的 id —— 同一条回复的所有记录共用它当 key */
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
  getContent: () => string
  getReasoning: () => string
  /** 最后一个事件类型：只有 done / aborted 才值得存 */
  getEventType: () => string
}): ReplyPersistence {
  const { threadId, messageId, timestamp, getContent, getReasoning, getEventType } = opts
  /*
   * 痕迹（时间线 + 工具记录）从这个占位消息上读**当前值**。
   *
   * ★ 为什么读 store 而不是让调用方再传两个 getter（2026-10-20）：`rounds` /
   *   `toolRuns` 由 streamEvents 就地改，而「此刻界面上已经显示出来的那一份」
   *   就是 store 里这条消息的。让调用方再包一层，只会多两处可能不同步的拷贝
   *   （`turns.ts` 也因此涨了 15 行、破了 300 行红线）。
   */
  const current = (): {
    rounds: MessageRound[]
    toolRuns: ToolRunRecord[]
  } => {
    const message = useAppStore
      .getState()
      .threads.find((t) => t.id === threadId)
      ?.messages.find((m) => m.id === messageId)
    return { rounds: message?.rounds ?? [], toolRuns: message?.toolRuns ?? [] }
  }
  const answer = {
    ...(opts.answersKey ? { answersKey: opts.answersKey } : {}),
    ...(opts.answersVersion !== undefined ? { answersVersion: opts.answersVersion } : {}),
    ...(opts.regeneratedFrom ? { regeneratedFrom: opts.regeneratedFrom } : {}),
  }
  let lastFlushAt = 0
  let lastFlushLen = 0

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
      const { rounds, toolRuns: runs } = current()
      const traces = traceOf(runs)
      const now = Date.now()
      /*
       * ★ 度量用「正文 + 思考」：只看正文的话，一段长思考（或纯工具轮）期间
       *   磁盘上什么都没有（2026-10-04 事故现场：8 分钟没写一次）。
       *   间隔规则照旧（至少 3 秒），所以不会把写入量抬上去。
       */
      const metric = content.length + reasoning.length
      if (!shouldFlushPartial(metric, lastFlushLen, now, lastFlushAt)) return
      lastFlushAt = now
      lastFlushLen = metric
      useAppStore.getState().persistMessage(threadId, {
        role: 'assistant',
        key: messageId,
        partial: true,
        content,
        ...(reasoning ? { reasoning } : {}),
        /* 时间线：逐轮复制一份（别和 store 里的草稿共享引用） */
        ...(rounds.length
          ? { rounds: rounds.map((round) => ({ ...round, tools: [...round.tools] })) }
          : {}),
        ...(traces.length ? { toolRuns: traces } : {}),
        ...answer,
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
      const final = useAppStore
        .getState()
        .threads.find((t) => t.id === threadId)
        ?.messages.find((m) => m.id === messageId)
      if (!final) return
      const text = final.content ?? ''
      /* 空回复（比如刚发出去就被停掉）不写 —— 免得会话里多一条空消息 */
      if (!text.trim() && (final.toolRuns ?? []).length === 0) return
      const message: StoredMessage = {
        role: 'assistant',
        key: messageId,
        content: text,
        ...(final.reasoning ? { reasoning: final.reasoning } : {}),
        ...(final.toolRuns?.length ? { toolRuns: final.toolRuns } : {}),
        /* 时间线（思考 → 工具 → 正文 的真实顺序）—— 不存的话重开会话会塌回三段堆叠 */
        ...(final.rounds?.length ? { rounds: final.rounds } : {}),
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
        /* 开工前问过什么（AG-053 批③）—— 只读卡靠它，不存的话重开会话就只剩「模型自己改的」 */
        ...(final.clarify ? { clarify: final.clarify } : {}),
        ...(final.citations?.length ? { citations: final.citations } : {}),
        ...(final.usage ? { usage: final.usage } : {}),
        /* 被中止的那条：落盘标上 aborted —— 重开会话后「重试」文案还能回来 */
        ...(type === 'aborted' ? { aborted: true } : {}),
        ...answer,
        ts: final.timestamp,
      }
      useAppStore.getState().persistMessage(threadId, message)
    },
  }
}
