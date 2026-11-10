import type { Message } from '@/types'
import { FlowDisclosure } from './FlowDisclosure'

const phases = {
  plan: 'A 分派',
  approval: '等待确认',
  execute: 'B 执行',
  review: 'A 检查',
  deliver: 'A 交付',
} as const
const statuses = {
  running: '进行中',
  waiting_user: '等待你确认',
  completed: '已完成',
  blocked: '尚未达到要求',
  paused: '已暂停',
  cancelled: '已停止',
  failed: '协作未完成',
} as const
const verdicts = {
  PASS: '已达到要求',
  NEEDS_CHANGES: '需要补充或修改',
  BLOCKED: '暂时受阻',
} as const
const kinds = {
  research: '资料检索',
  writing: '写作创作',
  development: '开发任务',
  general: '综合任务',
} as const

export function CollaborationCard({ message }: { message: Message }) {
  const record = message.collaboration
  if (!record) return null
  const interrupted =
    message.status !== 'streaming' &&
    (record.status === 'running' || record.status === 'waiting_user')
  const status = interrupted ? '上次协作未结束，已有记录保留' : statuses[record.status]
  return (
    <section
      className="mb-2 rounded-sm border border-line-subtle px-2.5 py-2 text-xs text-fg-secondary"
      aria-label="双模型协作记录"
    >
      <p className="flex items-center justify-between gap-2">
        <span>{record.mode === 'supervised' ? '双模型 · 监督执行' : '双模型协作'}</span>
        <span role="status">{status}</span>
      </p>
      <p className="mt-1 text-2xs text-fg-tertiary">
        A 指导 · {record.roles.planner.label}　B 执行 · {record.roles.executor.label}
      </p>
      <FlowDisclosure
        label={`${record.round ? `第 ${record.round} 轮 · ` : ''}${phases[record.phase]} · 查看交接与记录`}
        memoryKey={`${message.id}:${record.id}:collaboration`}
      >
        <ol className="flex flex-col gap-1 text-2xs">
          {record.stages.map((stage, index) => (
            <li key={`${stage.phase}:${index}`}>
              {stage.round ? `第 ${stage.round} 轮 · ` : ''}
              {phases[stage.phase]} ·{' '}
              {stage.phase === 'approval' ? '用户确认' : record.roles[stage.role].label}
              {' · '}
              {stage.status === 'completed'
                ? '已结束'
                : interrupted
                  ? '结果未确认'
                  : statuses[stage.status]}
              {stage.note ? ` · ${stage.note}` : ''}
            </li>
          ))}
        </ol>
        {record.plan ? (
          <div className="mt-2 space-y-1 text-2xs">
            <p>{record.plan.problem}</p>
            {record.plan.kind ? <p>任务类型：{kinds[record.plan.kind]}</p> : null}
            {record.plan.scope.length ? <p>任务范围：{record.plan.scope.join('、')}</p> : null}
            {record.plan.steps?.length ? <p>分派步骤：{record.plan.steps.join('；')}</p> : null}
            <p>预期：{record.plan.expected}</p>
            <p>检查方法：{record.plan.verify}</p>
            {record.plan.criteria?.length ? (
              <p>完成标准：{record.plan.criteria.join('；')}</p>
            ) : null}
          </div>
        ) : null}
        {record.rounds?.length ? (
          <ol className="mt-2 flex flex-col gap-2 text-2xs" aria-label="逐轮检查与反馈">
            {record.rounds.map((round) => (
              <li key={round.round} className="space-y-1 border-t border-line-subtle pt-2">
                <p>
                  第 {round.round} 轮 ·{' '}
                  {round.review ? verdicts[round.review.verdict] : statuses[round.status]}
                </p>
                {round.summary ? (
                  <p className="whitespace-pre-wrap">执行摘要：{round.summary}</p>
                ) : null}
                {round.review?.reasons.map((reason, index) => (
                  <p key={index}>检查：{reason}</p>
                ))}
                {round.review ? (
                  <ul className="space-y-1">
                    {(round.review.nextSteps?.length
                      ? round.review.nextSteps
                      : round.review.issues
                    ).map((step, index) => (
                      <li key={index}>补充要求：{step}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        ) : record.review ? (
          <div className="mt-2 space-y-1 text-2xs">
            <p>检查结论：{verdicts[record.review.verdict]}</p>
            {[...record.review.reasons, ...record.review.issues].map((item, index) => (
              <p key={index}>{item}</p>
            ))}
          </div>
        ) : null}
        {record.limits ? (
          <p className="mt-2 text-2xs text-fg-tertiary">
            最多 {record.limits.maxRounds} 轮 · 总时长 {record.limits.maxRuntime} 秒 · Token{' '}
            {record.limits.maxTokens ? `上限 ${record.limits.maxTokens}` : '不限'}
          </p>
        ) : null}
        {record.usage ? (
          <p className="mt-1 text-2xs text-fg-tertiary">
            已报告 {record.usage.knownTokens.toLocaleString()} Token
            {record.usage.unknownCalls ? `；${record.usage.unknownCalls} 次调用未提供用量` : ''}
          </p>
        ) : null}
        {record.error ? (
          <p className="mt-2 text-2xs text-fg-danger">{record.error.message}</p>
        ) : null}
      </FlowDisclosure>
    </section>
  )
}
