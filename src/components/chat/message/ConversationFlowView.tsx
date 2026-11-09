import type { Message } from '@/types'
import { bodyTextOf } from '@/lib/bodyText'
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
  return (
    <>
      {nodes.length > 0 || streaming ? (
        <details open={streaming || undefined} className="my-2">
          <summary className="cursor-pointer text-sm text-fg-secondary">
            {streaming ? '执行中' : '执行过程'}
          </summary>
          <div className="mt-2 border-l border-line-subtle pl-3">
            {nodes.map((node) => {
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
              if (streaming && !streamOutput) return null
              return streaming ? (
                <StreamingMarkdown key={node.id} text={node.text} />
              ) : (
                <Markdown key={node.id} text={node.text} />
              )
            })}
          </div>
        </details>
      ) : null}
      {final ? <Markdown text={final} /> : null}
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
