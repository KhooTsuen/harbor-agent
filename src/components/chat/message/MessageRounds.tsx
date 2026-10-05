import type { MessageRound, ToolRunRecord } from '@/types'
import { useSmoothText } from '@/hooks/useSmoothText'
import { ThinkBlock } from '../ProcessBlocks'
import { ToolLine } from './ToolLine'
import { Markdown } from '../Markdown'
import { StreamingMarkdown } from '../markdown/StreamingMarkdown'

/* ══════════════════════════════════════════════════════════════
   一轮一轮地排（VS Code 那种时间线）

   以前是三段堆叠：**一大块思考 → 一列工具 → 一段正文**。
   三个字段（reasoning / toolRuns / content）确实是拼在一起的，所以
   「哪段思考发生在哪个工具之前」在界面上根本表达不出来。

   而真实过程是交替的：思考 → 工具 → 正文 → 思考 → 工具 → 正文 …
   2026-09-30 真机数据（一轮 39 次工具调用）：思考累积到 8.5 万字符、
   正文一段段长到 4300 字符 —— 三段堆叠会把过程全糊在一起。

   这里按 `rounds` 的顺序画。**最后一轮**才吃流式状态（正在思考 / 正在输出）。
   ══════════════════════════════════════════════════════════════ */

export function MessageRounds({
  rounds,
  toolRuns,
  streaming,
  hideStreamingContent = false,
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

  return (
    <div className="flex flex-col">
      {rounds.map((round, index) => {
        const isLast = index === lastIndex
        /* 下标可能越界（落盘/读回之间版本不一致时）—— 过滤掉，别渲染空的 */
        const runs = round.tools.map((at) => toolRuns[at]).filter(Boolean)
        /* 最后一轮还没出正文 = 正在思考（这样才会显示「正在思考…」） */
        const thinking = streaming && isLast && !round.content.trim()

        return (
          <div key={index} data-round={index} className="flex flex-col">
            {round.reasoning.trim() ? (
              <ThinkBlock text={round.reasoning} streaming={thinking} />
            ) : null}
            {/*
              工具**一行说完**（不占一张卡片）—— 用户 2026-09-30 拿 VS Code 的
              截图对比后要求的排版：摘要行与正文自然交错。
            */}
            {runs.length > 0 ? <ToolLine runs={runs} /> : null}
            {isLast && streaming && hideStreamingContent ? (
              /* 「不生字」模式下也得让用户看出还在动 —— 一句话就够 */
              <p className="flex items-center gap-2 text-sm text-fg-secondary">
                <span className="inline-block size-2 animate-pulse rounded-full bg-fg-tertiary" />
                正在写回答…（写完一次显示）
              </p>
            ) : round.content.trim() ? (
              <div>
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
            ) : null}
          </div>
        )
      })}

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
