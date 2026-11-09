import type { Message } from '@/types'
import { bodyTextOf } from '@/lib/bodyText'
import { purposeOf } from '@/lib/conversationFlow'
import { Markdown } from '../Markdown'
import { StreamingMarkdown } from '../markdown/StreamingMarkdown'
import { ToolLine } from './ToolLine'

const verdictLabels = {
  done: '验收通过',
  partial: '部分完成',
  failed: '验收未通过',
} as const

export function ConversationFlowView({
  message,
  streaming,
  streamOutput,
}: {
  message: Message
  streaming: boolean
  streamOutput: boolean
}) {
  const nodes = message.flow?.nodes ?? []
  const runs = new Map(message.toolRuns?.map((run) => [run.id, run]))
  const final = bodyTextOf(message)
  const verdict = message.verdict
  /*
   * 过程区只收「过程」：工具 / 思考 / 已降级成过程发言的文字。
   * 以前这里把**所有** speech 都画进折叠区，正文区又画一遍 final —— 同一段显示两遍。
   */
  const processNodes = nodes.filter(
    (node) => node.kind !== 'speech' || purposeOf(node) === 'chatter',
  )
  /*
   * 正文：结算了就是 `final`（唯一）；没结算时把还没定性的片段照实摆出来 ——
   * 流式中那是**同一段**在增长（advanceFlow 合并同轮连续 content），
   * 结算前被中断就标「未确认」，不许冒充成正式答复。
   */
  const loose = final
    ? []
    : nodes.filter((node) => node.kind === 'speech' && purposeOf(node) !== 'chatter')
  const unconfirmed = loose.some((node) => purposeOf(node) === 'unconfirmed')
  /* 流式时正文是否跟着出现（用户在设置里关掉「边跑边看」时，等结算再看） */
  const showLoose = !streaming || streamOutput
  return (
    <>
      {processNodes.length > 0 || streaming ? (
        <details open={streaming || undefined} className="my-2">
          <summary className="cursor-pointer text-sm text-fg-secondary">
            {streaming ? '执行中' : '执行过程'}
          </summary>
          <div className="mt-2 border-l border-line-subtle pl-3">
            {processNodes.map((node) => {
              if (node.kind === 'tool') {
                const run = runs.get(node.toolId)
                return run ? <ToolLine key={node.id} runs={[run]} hideMeta={streaming} /> : null
              }
              if (node.kind === 'reasoning') {
                return (
                  <details key={node.id}>
                    <summary className="cursor-pointer text-sm text-fg-secondary">思考过程</summary>
                    <Markdown text={node.text} />
                  </details>
                )
              }
              if (node.kind !== 'speech' || !node.text) return null
              return <Markdown key={node.id} text={node.text} />
            })}
          </div>
        </details>
      ) : null}
      {final ? <Markdown text={final} /> : null}
      {showLoose
        ? loose.map((node) =>
            streaming ? (
              <StreamingMarkdown key={node.id} text={'text' in node ? node.text : ''} />
            ) : (
              <div key={node.id}>
                {unconfirmed ? (
                  <p className="mb-1 text-2xs text-fg-tertiary" data-flow-unconfirmed="true">
                    这段还没结算 —— 上次执行被打断，不能当正式答复
                  </p>
                ) : null}
                <Markdown text={'text' in node ? node.text : ''} />
              </div>
            ),
          )
        : null}
      {verdict === 'done' || verdict === 'partial' || verdict === 'failed' ? (
        <details className="mt-2 text-sm text-fg-secondary">
          <summary className="cursor-pointer">{verdictLabels[verdict]}</summary>
          <ul className="pl-5">
            {(message.toolRuns ?? []).map((run) => (
              <li key={run.id}>
                {run.name} · {run.pending ? '结果未确认' : run.ok ? '成功' : '失败'}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  )
}
