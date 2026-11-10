import type { Message } from '@/types'
import { FlowDisclosure } from './FlowDisclosure'
import { navigateToFlow } from '@/lib/flowNavigation'
import { toolLabel } from '@/lib/agentActivity'

const labels = { done: '验收通过', partial: '部分完成', failed: '验收未通过' } as const

export function FlowAcceptance({
  message,
  streaming,
  active,
  motion,
}: {
  message: Message
  streaming: boolean
  motion: boolean
  active: boolean
}) {
  const verdict = message.verdict
  const checking = streaming && message.phase === 'verifying'
  if (!checking && verdict !== 'done' && verdict !== 'partial' && verdict !== 'failed') return null
  const label = checking ? '正在核对' : labels[verdict as keyof typeof labels]
  const runs = message.toolRuns ?? []
  return (
    <section className="flow-acceptance" data-flow-acceptance="true" aria-label="验收与证据">
      <FlowDisclosure
        label={<span role="status">{label}</span>}
        live={checking && active}
        memoryKey={`${message.threadId}:${message.diskKey ?? message.id}:${message.execId ?? 'answer'}:acceptance`}
      >
        <p className="flow-evidence-note">以下是本次执行留下的工具记录。</p>
        {runs.length ? (
          <ul className="flow-evidence-list">
            {runs.map((run) => (
              <li
                key={run.id}
                data-evidence-state={run.pending ? 'unknown' : run.ok ? 'success' : 'failed'}
              >
                <button
                  type="button"
                  className="flow-evidence-link"
                  onClick={() => {
                    const node = message.flow?.nodes.find(
                      (item) => item.kind === 'tool' && item.toolId === run.id,
                    )
                    if (node) navigateToFlow(message.id, `flow-node-${message.id}-${node.id}`)
                  }}
                >
                  {toolLabel(run.name)}
                </button>
                <span
                  key={run.pending ? 'pending' : String(run.ok)}
                  className={motion ? 'flow-state-arrival' : undefined}
                >
                  {run.pending ? '结果未确认' : run.ok ? '执行成功' : '执行失败'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flow-evidence-note">这次执行没有工具记录。</p>
        )}
      </FlowDisclosure>
    </section>
  )
}
