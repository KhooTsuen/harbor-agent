import type { Message } from '@/types'
import { bodyTextOf } from '@/lib/bodyText'
import { purposeOf } from '@/lib/conversationFlow'
import { formatDuration } from '@/lib/processSummary'
import { navigateToFlow } from '@/lib/flowNavigation'
import { Markdown } from '../Markdown'
import { StreamingMarkdown } from '../markdown/StreamingMarkdown'
import { FlowDisclosure } from './FlowDisclosure'
import { FlowProcessSteps } from './FlowProcessSteps'
import { FlowAcceptance } from './FlowAcceptance'
import { useFlowPresentation } from './useFlowPresentation'
import '@/styles/conversation-flow.css'
import { useScrollStore } from '@/stores/useScrollStore'

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
  const presentation = useFlowPresentation(message, streaming)
  const key = `${message.threadId}:${message.diskKey ?? message.id}:${message.execId ?? message.answerIndex ?? 0}`
  const expanded = useScrollStore((state) => state.processOpen[`${key}:process`] ?? false)
  const processNodes = nodes.filter(
    (node) => node.kind !== 'speech' || purposeOf(node) === 'chatter',
  )
  const loose = final
    ? []
    : nodes.filter((node) => node.kind === 'speech' && purposeOf(node) !== 'chatter')
  const unconfirmed = !streaming && !final && loose.length > 0
  const showLoose = !streaming || streamOutput
  const showProcess = processNodes.length > 0 || streaming
  const last = nodes.at(-1)
  const activeId =
    presentation.running && last && (last.kind !== 'speech' || purposeOf(last) === 'chatter')
      ? last.id
      : undefined
  const answerId = `flow-answer-${message.id}`
  const bodyId = final
    ? nodes.find((node) => node.kind === 'speech' && purposeOf(node) === 'final')?.id
    : loose[0]?.id
  const bodyBlocks = final ? [{ id: bodyId ?? 'final', text: final, hold: true }] : loose
  const failedCount = (message.toolRuns ?? []).filter((run) => !run.pending && !run.ok).length
  const pendingCount = (message.toolRuns ?? []).filter((run) => run.pending).length
  return (
    <div className="conversation-flow" data-flow-motion={presentation.motion || undefined}>
      {showProcess ? (
        <div className="flow-process-shell">
          <FlowDisclosure
            label={<span role="status">{presentation.summary}</span>}
            live={presentation.running}
            memoryKey={`${key}:process`}
            className="flow-process"
          >
            {!streaming && message.durationMs !== undefined ? (
              <p className="flow-process-meta">用时 {formatDuration(message.durationMs)}</p>
            ) : null}
            <FlowProcessSteps
              key={key}
              nodes={processNodes}
              runs={runs}
              activeId={activeId}
              expanded={expanded}
              streaming={streaming}
              motion={presentation.motion}
              memoryKey={key}
              messageId={message.id}
            />
            {!processNodes.length ? <p className="flow-empty-progress">等待首个实际进展</p> : null}
            {final || loose.length ? (
              <button
                type="button"
                className="flow-jump-answer"
                onClick={() => navigateToFlow(message.id, answerId)}
              >
                跳到答复
              </button>
            ) : null}
          </FlowDisclosure>
          {!streaming && (failedCount > 0 || pendingCount > 0) ? (
            <p className="flow-process-caution" role="status">
              {failedCount > 0 ? `${failedCount} 项工具执行失败` : ''}
              {failedCount > 0 && pendingCount > 0 ? ' · ' : ''}
              {pendingCount > 0 ? `${pendingCount} 项结果未确认` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
      <div id={answerId} className="flow-answer" data-flow-node={bodyId} data-flow-answer="true">
        {unconfirmed ? (
          <p className="flow-unconfirmed" data-flow-unconfirmed="true">
            这段还没结算，不能当正式答复
          </p>
        ) : null}
        {final || showLoose ? (
          bodyBlocks.map((node) => (
            <div
              key={node.id}
              className={`flow-body-block${presentation.motion && streaming ? ' flow-body-arrival' : ''}`}
              data-flow-node={node.id}
            >
              {streaming && !final && !('hold' in node && node.hold) ? (
                <p className="flow-candidate-label">文字归属待确认</p>
              ) : null}
              {streaming && !final ? (
                <StreamingMarkdown
                  text={'text' in node ? node.text : ''}
                  active={presentation.writing && node.id === last?.id}
                />
              ) : (
                <Markdown text={'text' in node ? node.text : ''} />
              )}
            </div>
          ))
        ) : streaming && loose.length ? (
          <p className="flow-candidate-label">正在生成文字，结束后显示</p>
        ) : null}
      </div>
      <FlowAcceptance
        message={message}
        streaming={streaming}
        active={presentation.running}
        motion={presentation.motion}
      />
    </div>
  )
}
