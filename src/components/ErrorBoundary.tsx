import { Component, type ErrorInfo, type ReactNode } from 'react'

/* ══════════════════════════════════════════════════════════════
   ErrorBoundary

   捕获子树里的渲染错误，显示可读的错误状态 + 重试按钮，
   而不是让整个窗口白屏。错误会打到 console（和可选的采集端点）。
   ══════════════════════════════════════════════════════════════ */

export interface ErrorBoundaryProps {
  children: ReactNode
  /** 出错时显示在哪个容器里（默认撑满） */
  className?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
    /* 这里可以接错误上报端点，先留空 */
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        className={`flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center ${this.props.className ?? ''}`}
        role="alert"
      >
        <p className="text-body font-semibold text-fg-primary">这一块出错了</p>
        <p className="max-w-md break-words font-mono text-2xs leading-relaxed text-fg-tertiary">
          {error.message || String(error)}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-base bg-cta px-3 py-1.5 text-dense text-cta-fg"
          >
            重试
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                void navigator.clipboard.writeText(error.stack ?? error.message)
              } catch {
                /* 复制失败不影响 */
              }
            }}
            className="rounded-base border border-line-hairline px-3 py-1.5 text-dense text-fg-secondary"
          >
            复制错误信息
          </button>
        </div>
      </div>
    )
  }
}
