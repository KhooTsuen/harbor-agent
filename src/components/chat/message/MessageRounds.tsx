import type { MessageRound, ToolRunRecord } from '@/types'
import { useSmoothText } from '@/hooks/useSmoothText'
import { ThinkBlock } from '../ProcessBlocks'
import { ProcessPanel } from '../ProcessPanel'
import { ToolLine } from './ToolLine'
import { Markdown } from '../Markdown'
import { StreamingMarkdown } from '../markdown/StreamingMarkdown'
import { liveActivityLabel } from '@/lib/agentActivity'
import { groupRounds, isProcessSpeech } from './groupRounds'

/* ══════════════════════════════════════════════════════════════
   一轮一轮地排（VS Code 那种时间线）

   以前是三段堆叠：**一大块思考 → 一列工具 → 一段正文**。
   三个字段（reasoning / toolRuns / content）确实是拼在一起的，所以
   「哪段思考发生在哪个工具之前」在界面上根本表达不出来。

   而真实过程是交替的：思考 → 工具 → 正文 → 思考 → 工具 → 正文 …
   2026-09-30 真机数据（一轮 39 次工具调用）：思考累积到 8.5 万字符、
   正文一段段长到 4300 字符 —— 三段堆叠会把过程全糊在一起。

   ── 2026-10-21：过程收进折叠区 ──────────────────────────────

   按顺序全平铺的后果：跑 24 步时长任务要滚过几十行工具摘要才看到结论。
   现在分成两块：

     · **正文**（`round.content`）—— 直接显示，是阅读主体
     · **过程**（`round.reasoning` + 工具行）—— 收进 `ProcessPanel`，
       默认只有一行入口（「用时 31 秒 · 24 个步骤」）

   ★ 关键：**归属按字段来，不按关键词猜**。`reasoning` 是过程、`content` 是正文，
     这是内核分开攒的两个通道（`loop-transcript.cjs` 的 `stream` 回调），
     不是从这里用「我会先 / 接下来」这类词去判断的。所以老记录也照同一条规则排，
     **不需要改写Any 原文**。

   ── 流式期间也折叠（2026-10-21 用户改口径）────────────────────

   上一版是「跑的时候平铺、跑完才收」。用户看过真机后改了口径：
   **什么时候都可折叠、默认收起**，代价（跑的时候看不见过程细节）他自己接受。
   入口文案换成「正在运行 · N 个步骤」—— 不写这句，收起后的入口看起来
   就像已经跑完了，用户会对着静止的界面干等（见 processSummary）。

   ── 过程话不占正文（同一次改动）──────────────────────────────

   模型常见的写法是「我先核对一下现状 → 调工具 → 现在核完了 → 再调工具」，
   这些话都走 `content` 通道，于是被当成正文摆在外面，把真正的结论挤下去。

   归属判据**只看结构、不看措辞**：一轮里**有工具**、**有正文**、且
   **不是这条消息最后一段正文** → 这段是过程里的话，收进折叠区（展开可见，
   一个字不删）。最后一段正文永远是正文 —— 那就是这条消息的结论。

   ── Phase 3：跨轮同类聚合 ──────────────────────────────────
   连续、可聚合的若干轮（无正文、无失败、无子代理）折成一组，工具用一个
   `ToolLine` 一次说完（展开仍是 100 条原始明细）。规则与强制打断都在
   `groupRounds.ts`（纯函数，单测钉死）—— 渲染层只负责按它给的结果画。
   ══════════════════════════════════════════════════════════════ */

export function MessageRounds({
  rounds,
  toolRuns,
  streaming,
  hideStreamingContent = false,
  clarify = false,
  message,
}: {
  rounds: MessageRound[]
  /** 全部工具记录；`round.tools` 里存的是它的下标 */
  toolRuns: ToolRunRecord[]
  streaming: boolean
  /**
   * `assistant.streamOutput === false` 时传 true：**正文等写完再显示**。
   *
   * 过程和工具照旧实时出现（思考链、每一步工具都能看）—— 只有「答案本身」
   * 不逐字蹦。`useSmoothText` 那条摊平的逻辑在这里就不需要了（内容还没上屏）。
   */
  hideStreamingContent?: boolean
  /** 这条消息开头挂了澄清卡 → 不跨轮聚合（理由见 groupRounds.ts 的 GroupOptions） */
  clarify?: boolean
  /**
   * 折叠区要读的几个字段（`durationMs` 用时 / `interrupted` 已中断 / `status` 出错判断
   * / `id` + `threadId` 用来记住用户手动展开过哪条过程）。
   *
   * ★ 只声明用得到的几个，不要求整个 `Message`：单测复现一个渲染形状时
   *   不该被逼着造一条完整的消息对象。少了 id/threadId = 不持久化展开状态，
   *   与以前一模一样；少了 durationMs = 入口只写「N 步」，是同一个降级路径。
   */
  message?: Pick<
    import('@/types').Message,
    'durationMs' | 'interrupted' | 'status' | 'phase' | 'id' | 'threadId'
  >
}) {
  const lastIndex = rounds.length - 1
  /*
   * 这条消息出过正文没有（只要出过一次就永远是 true —— 正文不会退回去）。
   * 光标位靠它决定要不要占：一次都还没出过时干脆不挂（下方有注释）。
   */
  const everHadContent = rounds.some((round) => round.content.trim())
  /** 最后一轮现在有没有正文 —— 有才把光标露出来 */
  const lastHasContent = Boolean(rounds[lastIndex]?.content.trim())

  /*
   * 流式那一轮的正文要「摊平」（AG-023）—— 上游是一批一批给的，直接渲染会
   * 一块一块地跳。它和思考链是两个独立通道（后端按 type 分开攒），所以
   * ThinkBlock 自己那份平滑（见 ProcessBlocks）不能省。
   */
  const smoothLast = useSmoothText(rounds[lastIndex]?.content ?? '', streaming)

  /* Phase 3：跨轮同类工具聚合成一组（纯展示层派生，规则见 groupRounds.ts） */
  const items = groupRounds(rounds, toolRuns, { clarify })

  /*
   * ★ 折叠区的三条边界（2026-10-21 第三版口径）：
   *   · 跑完了、一步过程都没有（纯问答）→ 入口本身不挂
   *   · **还在跑 → 入口恒挂**：刚按下发送时一轮都还没结束，入口就是「实时任务」，
   *     展开能看到「正在等待模型回应…」（验收表第一行）。以前这里只看 rounds，
   *     那种状态下整条消息连入口都没有，只剩一行裸的活动文字。
   *   · **出错 / 中断 → 折叠区照旧在，但默认展开**（`defaultOpen`）：
   *     「等待授权、澄清、失败和中断必须直接显示、不能被默认折叠」这条没松开过。
   *     区别只是入口文案写清「失败 · N 个步骤」/「已中断」，过程本身一眼可见。
   */
  /*
   * 「任务没成」也算异常态 —— 只是有几项失败（任务照样完成）不算：
   * 那种情况过程默认收起、入口写「含 N 项失败」，用户想看再点（图2 表第二 / 三行）。
   */
  const allToolsFailed =
    toolRuns.length > 0 && toolRuns.every((run) => !run.ok && run.ms !== undefined)
  const abnormal = message?.status === 'error' || message?.interrupted === true || allToolsFailed
  const processItems = items.filter(
    (item) =>
      item.kind === 'group' ||
      Boolean(item.round.reasoning.trim()) ||
      item.round.tools.length > 0 ||
      (item.kind === 'round' && isProcessSpeech(rounds, item.index)),
  )
  const showEntry = processItems.length > 0 || streaming

  /**
   * 正文块（每条有正文的轮各一段，顺序不变）
   *
   * ★ 「过程话」那一轮的正文**不在这里出**（返回 null）：它在 `processOf` 里
   *   跟着思考与工具一起出现。判据见 groupRounds 的 `isProcessSpeech`。
   */
  const bodyOf = (item: (typeof items)[number]) => {
    if (item.kind === 'group') return null
    const round = item.round
    if (!round.content.trim()) return null
    if (isProcessSpeech(rounds, item.index)) return null
    const isLast = item.index === lastIndex
    if (isLast && streaming && hideStreamingContent) {
      return (
        <p key={`b-${item.index}`} className="flex items-center gap-2 text-sm text-fg-secondary">
          <span className="inline-block size-2 animate-pulse rounded-full bg-fg-tertiary" />
          正在写回答…（写完一次显示）
        </p>
      )
    }
    return (
      <div key={`b-${item.index}`} data-round-body={item.index}>
        {/*
          只有最后一轮走增量解析：前面的轮次已经写完了，
          整篇解析一次到位更省（也避免重复解析长文本）。
        */}
        {streaming && isLast ? (
          <StreamingMarkdown text={smoothLast} />
        ) : (
          <Markdown text={round.content} />
        )}
      </div>
    )
  }

  /** 过程块（思考 + 工具，按真实发生顺序） */
  const processOf = (item: (typeof items)[number]) => {
    if (item.kind === 'group') {
      return (
        <div
          key={`p-g-${item.from}`}
          data-round={item.from}
          data-round-span={item.to - item.from + 1}
          className="flex flex-col"
        >
          {item.rounds.map((round, k) =>
            round.reasoning.trim() ? (
              <ThinkBlock key={k} text={round.reasoning} hideCount={streaming} />
            ) : null,
          )}
          <ToolLine runs={item.runs} hideMeta={streaming} />
        </div>
      )
    }
    const round = item.round
    const runs = round.tools.map((at) => toolRuns[at]).filter(Boolean)
    /* 最后一轮还没出正文 = 正在思考（这样才会显示「正在思考…」） */
    const thinking = streaming && item.index === lastIndex && !round.content.trim()
    /*
     * 这一轮的正文是「过程里说的话」→ 跟着思考与工具一起出现（判据见 groupRounds）。
     * 放在思考之后、工具之前：`rounds` 只记「这一轮说过什么 / 调过什么」，不记
     * 这一轮里两者的先后，所以按最常见的「先说一句再动手」排。
     */
    const speech = isProcessSpeech(rounds, item.index)
    return (
      <div key={`p-${item.index}`} data-round={item.index} className="flex flex-col">
        {round.reasoning.trim() ? (
          <ThinkBlock text={round.reasoning} streaming={thinking} hideCount={streaming} />
        ) : null}
        {speech ? (
          <div data-round-speech={item.index} className="mb-2 opacity-80">
            <Markdown text={round.content} />
          </div>
        ) : null}
        {/*
          工具**一行说完**（不占一张卡片）—— 用户 2026-09-30 拿 VS Code 的
          截图对比后要求的排版：摘要行与正文自然交错。
        */}
        {runs.length > 0 ? <ToolLine runs={runs} hideMeta={streaming} /> : null}
      </div>
    )
  }

  /*
   * 入口要读的几个字段。
   * ★ 运行中只给 `running`：文案恒定是「实时任务」，不报步骤数 / 用时（见 processSummary）。
   */
  const entryMessage = {
    durationMs: message?.durationMs,
    interrupted: message?.interrupted,
    running: streaming,
    failed: message?.status === 'error',
  }

  /*
   * 运行中那一行「现在在干什么」（验收表第一行的「正在等待模型回应…」）。
   * 它排在展开区**最末**：那里是最新发生的位置，与工具时间线同一个阅读方向。
   * 收起时它不渲染 —— 收起状态下用户看到的只有入口，实时活动不该漏到外面。
   */
  const activity = streaming ? (
    <p className="flex items-center gap-2 text-2xs text-fg-secondary" data-live-activity="true">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-fg-tertiary" />
      {liveActivityLabel(toolRuns, message?.phase)}
    </p>
  ) : null

  return (
    <div className="flex flex-col">
      {showEntry ? (
        <>
          {/* 先给入口（运行中恒为「实时任务」/ 中断 / 失败 · N 个步骤），再给正文 */}
          <ProcessPanel
            message={entryMessage}
            runs={toolRuns}
            activity={activity}
            /* 手动展开 / 折叠按「对话 + 消息」记住：切走再回来仍保持（见 ProcessPanel） */
            threadId={message?.threadId}
            messageId={message?.id}
            /* 出错 / 中断 → 过程默认展开，入口仍然在（状态一眼可见，过程也一眼可见） */
            defaultOpen={abnormal}
          >
            {processItems.map(processOf)}
          </ProcessPanel>
          {items.map(bodyOf)}
        </>
      ) : (
        /*
         * 没有过程可收（纯问答）：保持平铺 —— 反正 processOf 不会产出任何东西，
         * 这里只画正文。走这条分支时 `items` 里最多只有正文轮。
         */
        items.map((item) => (
          <div
            key={item.kind === 'group' ? `g-${item.from}` : item.index}
            className="flex flex-col"
          >
            {processOf(item)}
            {bodyOf(item)}
          </div>
        ))
      )}

      {/*
        打字光标：**整条消息只挂一个，位置钉在尾巴上**（2026-10-06 第二次调整）。

        上一版挂在「有正文的那一轮」里面，换轮时那个元素会卸载再挂载：
        光标那一行的出现 / 消失让下面所有东西上下跳一格（真机反馈的「对话抽搐」），
        而且重挂会重置 CSS 闪烁动画（看着像卡了一下）。

        现在：它不在任何一轮里面，所以在换轮、工具行增删时**都不会卸载**；
        流式期间只是「有正文就看得见、没有（正在想 / 跑工具）就看不见」，
        位置始终占着 —— 不会跳。

        两条底线：① 一行正文都没出过时不挂（那种情况下它会多出一行空的，
        2026-10-06 第一版就栽在这儿）；② 非流式（答完了）不挂。
      */}
      {streaming && everHadContent ? (
        <span className={lastHasContent ? 'caret' : 'caret invisible'} aria-hidden="true" />
      ) : null}
    </div>
  )
}
