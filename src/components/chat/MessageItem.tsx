import { useEffect, useRef, useState } from 'react'
import type { Message } from '@/types'
import { cn } from '@/lib/utils'
import { useSmoothText } from '@/hooks/useSmoothText'
import { fsReveal } from '@/lib/fsApi'
import { CodeBlock } from './CodeBlock'
import { Markdown } from './Markdown'
import { StreamingText } from './StreamingText'
import { DiffViewer } from './DiffViewer'
import { AssistantActions } from './message/AssistantActions'
import { TerminalOutput } from './TerminalOutput'
import { ThinkBlock } from './ProcessBlocks'
import { ToolRunList } from './ToolRuns'
import { activityLabel } from '@/lib/agentActivity'
import { colorOf } from '@/lib/statusLanguage'
import { SystemMessage } from './SystemMessage'
import { UserMessage } from './message/UserMessage'

/* ══════════════════════════════════════════════════════════════
   MessageItem

   布局是参考实现那种：
     · 用户消息**右对齐气泡**
     · 助手消息左对齐、无气泡（内容就是内容）
     · 系统消息居中、小字
   ══════════════════════════════════════════════════════════════ */

export interface MessageItemProps {
  message: Message
  /** 是否显示悬停操作条 */
  showActions?: boolean
}

/** 助手那条的操作条在 `message/AssistantActions`（复制 / 重新生成 / 赞踩 / 翻译）；用户这条是编辑 / 分支 */
export function MessageItem({ message, showActions = true }: MessageItemProps) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isStreaming = message.status === 'streaming'
  const isError = message.status === 'error'

  /*
   * AG-023：必须在 `isSystem` 那个提前 return **之前**调，否则 hook 个数会变。
   * 上游 SSE 一阵一阵的，这段负责把文字摊到每一帧。
   */
  const smoothContent = useSmoothText(message.content ?? '', isStreaming)

  if (isSystem) {
    return <SystemMessage message={message} />
  }

  return (
    <article
      /* AG-038：给基准测试一个能数的锚点（「渲染出来几条」比「节点总数」更直观） */
      data-message-id={message.id}
      className={cn('group flex w-full flex-col', isUser ? 'items-end' : 'items-start')}
    >
      {isUser ? (
        <UserMessage message={message} />
      ) : (
        <div className="flex w-full flex-col">
          {isError ? (
            <div
              className="flex items-start gap-2 rounded border px-3 py-2"
              style={{ borderColor: 'rgb(229 83 75 / 0.4)', background: 'rgb(229 83 75 / 0.08)' }}
              role="alert"
            >
              <span className="text-xs leading-relaxed" style={{ color: colorOf('failed') }}>
                {message.errorText ?? message.content}
              </span>
            </div>
          ) : (
            <div className="w-full max-w-[86ch]">
              {/* 思考——默认折叠 */}
              {message.reasoning ? (
                <ThinkBlock text={message.reasoning} streaming={isStreaming} />
              ) : null}

              {/* 工具调用——一行一个，跑完显示耗时 */}
              {message.toolRuns && message.toolRuns.length > 0 ? (
                <ToolRunList runs={message.toolRuns} />
              ) : null}

              {message.content ? (
                <div>
                  {isStreaming ? (
                    /*
                     * ★ 流式中：像思考链一样纯文本直接流，只给行首标记染色。
                     *
                     * 原则：**不做块重排**（块重排就是「写完一段被覆盖重写」的根源），
                     * 每行独立渲染，`##` `-` ``` 染成浅色但不改变结构。
                     * 写完最后一刻才交给 <Markdown> 做真正的块渲染。
                     */
                    <StreamingText text={smoothContent} />
                  ) : (
                    <Markdown text={message.content} />
                  )}
                  {isStreaming ? <span className="caret" /> : null}
                </div>
              ) : isStreaming ? (
                <p className="flex items-center gap-2 text-sm text-fg-secondary">
                  <span className="inline-block size-2 animate-pulse rounded-full bg-fg-tertiary" />
                  {/*
                    AG-003：按下发送就要有反馈，而且要说清现在在干什么。
                    阶段文字来自主进程的状态机（AG-001 的 phase），
                    还没收到第一个 phase 事件时退回一句通用的。
                  */}
                  {activityLabel(message.toolRuns ?? [], message.phase)}
                </p>
              ) : null}

              {/*
                只有流式过程中留下的快照、没写完 —— 说明上次进程被打断了。
                不说的话用户会以为「模型就写了这么多」，而后面其实还有。
              */}
              {message.interrupted ? (
                <p className="mt-1 text-2xs text-fg-tertiary">
                  这条回复没写完 —— 上次运行被打断了，可以在右栏「任务」里接着做
                </p>
              ) : null}

              {message.codeBlocks?.map((block) => (
                <CodeBlock key={block.id} block={block} className="mt-3" />
              ))}

              {message.diffs && message.diffs.length > 0 ? (
                <DiffViewer files={message.diffs} className="mt-3" />
              ) : null}

              {message.terminalLines && message.terminalLines.length > 0 ? (
                <TerminalOutput lines={message.terminalLines} className="mt-3" />
              ) : null}

              {message.artifacts && message.artifacts.length > 0 ? (
                <div className="mt-3 flex flex-col gap-1">
                  {message.artifacts.map((artifact) => (
                    <div
                      key={artifact.id}
                      className="flex items-center gap-2 rounded-sm border border-line-subtle bg-bg-base/30 px-2.5 py-2 text-2xs"
                    >
                      <span className="min-w-0 flex-1 truncate text-fg-secondary">
                        {artifact.name}
                      </span>
                      {artifact.path ? (
                        <button
                          type="button"
                          className="shrink-0 text-fg-tertiary hover:text-fg-primary"
                          onClick={() => void fsReveal(artifact.path ?? '')}
                        >
                          打开
                        </button>
                      ) : null}
                      <span className="shrink-0 text-fg-tertiary">成果 · {artifact.type}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {message.citations && message.citations.length > 0 ? (
                <div className="mt-3 rounded-sm border border-line-subtle bg-bg-base/30 px-2.5 py-2 text-2xs text-fg-secondary">
                  <p className="mb-1 text-fg-tertiary">来源</p>
                  <ol className="flex flex-col gap-1">
                    {message.citations.map((citation, index) => (
                      <li key={citation.id} className="flex gap-1.5">
                        <span className="shrink-0 font-mono text-fg-tertiary">[{index + 1}]</span>
                        <a
                          href={citation.url}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 truncate text-fg-secondary hover:text-fg-primary hover:underline"
                          title={citation.url}
                        >
                          {citation.title}
                          {citation.domain ? ` · ${citation.domain}` : ''}
                        </a>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {/* 生成的图片 */}
              {message.images?.map((src) => (
                <img
                  key={src.slice(-24)}
                  src={src}
                  alt="生成的图片"
                  className="mt-3 max-w-full rounded-base border border-line-hairline"
                />
              ))}

              {showActions && !isStreaming ? <AssistantActions message={message} /> : null}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

/* ── 打字机：把文本逐字吐出来（给非流式场景用）───────────── */

export function useTypewriter(text: string, enabled: boolean, charsPerTick = 2): string {
  const [shown, setShown] = useState(enabled ? '' : text)
  const indexRef = useRef(enabled ? 0 : text.length)

  useEffect(() => {
    if (!enabled) {
      setShown(text)
      indexRef.current = text.length
      return
    }
    indexRef.current = 0
    setShown('')
    const timer = window.setInterval(() => {
      indexRef.current = Math.min(indexRef.current + charsPerTick, text.length)
      setShown(text.slice(0, indexRef.current))
      if (indexRef.current >= text.length) window.clearInterval(timer)
    }, 24)
    return () => window.clearInterval(timer)
  }, [text, enabled, charsPerTick])

  return shown
}
