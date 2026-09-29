import type { MessageRound, ToolRunRecord } from '@/types'
import { ThinkBlock } from '../ProcessBlocks'
import { ToolRunList } from '../ToolRuns'
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
}: {
  rounds: MessageRound[]
  /** 全部工具记录；`round.tools` 里存的是它的下标 */
  toolRuns: ToolRunRecord[]
  streaming: boolean
}) {
  const lastIndex = rounds.length - 1

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
            {runs.length > 0 ? <ToolRunList runs={runs} /> : null}
            {round.content.trim() ? (
              <div>
                {/*
                  只有最后一轮走增量解析：前面的轮次已经写完了，
                  整篇解析一次到位更省（也避免重复解析长文本）。
                */}
                {streaming && isLast ? (
                  <StreamingMarkdown text={round.content} />
                ) : (
                  <Markdown text={round.content} />
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
