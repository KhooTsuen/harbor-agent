import type { Message } from '@/types'
import { isSafeHref } from '@/lib/linkPolicy'
import { citationTarget } from '@/lib/citationTargets'
import { navigateToFlow } from '@/lib/flowNavigation'
import { ArrivalImage } from './ArrivalImage'
import { ArtifactCard } from './ArtifactCard'
import { FlowDisclosure } from './FlowDisclosure'
import { useAnswerMotion } from './AnswerSurface'

export function MessageDeliverables({ message }: { message: Message }) {
  const live = useAnswerMotion()
  return (
    <>
      {message.artifacts?.length ? (
        <div className="mt-2 flex flex-col gap-1">
          {message.artifacts.map((artifact) => (
            <ArtifactCard
              key={`${message.execId}:${artifact.id}:${artifact.path}`}
              artifact={artifact}
              message={message}
            />
          ))}
        </div>
      ) : null}
      {message.citations?.length ? (
        <FlowDisclosure
          label={`本轮查阅资料（${message.citations.length}）`}
          memoryKey={`${message.threadId}:${message.id}:${message.execId ?? 'legacy'}:materials`}
          className="mt-2 rounded-sm border border-line-subtle bg-bg-base/30 px-2 py-1 text-2xs text-fg-secondary"
        >
          <p className="mb-2 text-fg-tertiary">
            记录本轮读取的文件和搜索结果，便于回溯查阅；未逐项对应最终结论。
          </p>
          <ol className="flex flex-col gap-1">
            {message.citations.map((citation, index) => {
              const label = `${citation.title}${citation.domain ? ` · ${citation.domain}` : ''}`
              const target = citationTarget(message, citation)
              return (
                <li
                  key={citation.id}
                  className="flex items-start gap-1.5"
                  data-live-arrival={live ? 'true' : undefined}
                >
                  <span className="shrink-0 font-mono text-fg-tertiary">[{index + 1}]</span>
                  {target ? (
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left hover:underline"
                      title="定位到查阅步骤"
                      onClick={() => navigateToFlow(message.id, target)}
                    >
                      {label}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate" title={citation.path ?? citation.url}>
                      {label}
                    </span>
                  )}
                  {isSafeHref(citation.url) ? (
                    <a
                      href={citation.url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-fg-tertiary hover:underline"
                      title={citation.url}
                    >
                      打开网页
                    </a>
                  ) : null}
                  {!target && !citation.url ? (
                    <span className="shrink-0 text-fg-tertiary">未绑定步骤</span>
                  ) : null}
                </li>
              )
            })}
          </ol>
        </FlowDisclosure>
      ) : null}
      {message.images?.map((src) => (
        <ArrivalImage
          key={src}
          src={src}
          alt="生成的图片"
          className="mt-2 max-w-full rounded-base border border-line-hairline"
        />
      ))}
    </>
  )
}
