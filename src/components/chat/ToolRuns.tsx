import { useId, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, XCircle } from 'lucide-react'
import type { ToolRunRecord } from '@/types'
import { extractImageUrls } from '@/lib/markdown'
import { openImageFromDom } from '@/stores/useImageLightbox'
import { cn } from '@/lib/utils'
import { toolIconOf } from '@/lib/agentActivity'
import { colorOf } from '@/lib/statusLanguage'
import { errorDigest } from '@/lib/toolError'
import { useScrollGuard } from './scrollGuard'
import { ToolOutput } from './ToolOutput'
import { stateOfRun, toolStateLabels } from './toolRunState'
import { useToolRecovery } from './useToolRecovery'
import '@/styles/conversation-tools.css'

export function formatMs(ms: number): string {
  if (ms < 1000) return ms + 'ms'
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's'
  return Math.floor(ms / 60_000) + 'm' + Math.round((ms % 60_000) / 1000) + 's'
}

export function ToolRunRow({
  run,
  live = false,
  motion = false,
  anchorId,
}: {
  run: ToolRunRecord
  live?: boolean
  motion?: boolean
  anchorId?: string
}) {
  const state = stateOfRun(run, live)
  const { recovered, retrying } = useToolRecovery(run.id, state, motion, run)
  const running = state === 'running'
  const failed = state === 'failed'
  const pending = state === 'unconfirmed'
  const hasOutput = run.output.trim().length > 0
  const [manual, setManual] = useState<boolean | null>(null)
  const [visited, setVisited] = useState(false)
  const open = manual ?? (failed && hasOutput)
  const [rawOpen, setRawOpen] = useState(false)
  const detailsId = useId()
  const guard = useScrollGuard()
  const images = extractImageUrls(run.output)
  const ToolIcon = toolIconOf(run.name)
  const digest = failed && hasOutput ? errorDigest(run.output) : null
  const color = running ? undefined : colorOf(pending ? 'warning' : failed ? 'failed' : 'completed')
  const percent = run.progress?.percent
  const progress =
    typeof percent === 'number' && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent))
      : null

  return (
    <div
      id={anchorId}
      className="flow-tool-row"
      data-tool-motion={motion || undefined}
      data-tool-id={run.id}
    >
      <button
        type="button"
        onClick={() => {
          if (!hasOutput) return
          guard?.enterFree()
          setVisited(true)
          setManual(!open)
        }}
        aria-expanded={hasOutput ? open : undefined}
        aria-controls={hasOutput ? detailsId : undefined}
        className={cn(
          'flow-disclosure-trigger flow-tool-trigger',
          !hasOutput && 'flow-tool-no-output',
        )}
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={cn('flow-disclosure-chevron', open && 'flow-disclosure-chevron-open')}
          style={!hasOutput ? { visibility: 'hidden' } : undefined}
        />
        {running ? (
          <Loader2 size={12} className="flow-tool-spinner shrink-0 text-fg-tertiary" />
        ) : pending ? (
          <AlertTriangle size={12} className="shrink-0" style={{ color }} />
        ) : failed ? (
          <XCircle size={12} className="shrink-0" style={{ color }} />
        ) : (
          <CheckCircle2 size={12} className="shrink-0" style={{ color }} />
        )}
        <ToolIcon size={12} className="shrink-0 text-fg-tertiary" />
        <span className="shrink-0 font-mono text-fg-secondary">{run.name}</span>
        <span className="min-w-0 flex-1 truncate text-fg-tertiary" title={run.summary}>
          {run.summary}
        </span>
        {running && run.progress ? (
          <span className="flow-tool-progress" title={run.progress.note}>
            <span className="flow-tool-meta">
              {progress === null ? run.progress.note || '进行中' : Math.round(progress) + '%'}
            </span>
            {progress === null ? null : (
              <span
                className="flow-tool-progress-track"
                role="progressbar"
                aria-label="工具实际进度"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span className="flow-tool-progress-fill" style={{ width: progress + '%' }} />
              </span>
            )}
          </span>
        ) : null}
        {run.ms !== undefined ? <span className="flow-tool-meta">{formatMs(run.ms)}</span> : null}
        <span
          key={state + String(recovered) + String(retrying)}
          className="flow-tool-status"
          data-run-status={state}
          style={{ color }}
          aria-live="polite"
        >
          {recovered
            ? '已恢复'
            : retrying
              ? '正在重试'
              : run.recoveredBy
                ? '失败 · 重试已恢复'
                : toolStateLabels[state]}
        </span>
      </button>

      {images.length > 0 ? (
        <div className="flow-tool-images">
          {images.map((src) => (
            <img
              key={src}
              src={src}
              alt="工具产出的图片"
              loading="lazy"
              data-chat-image="true"
              className="max-h-48 cursor-zoom-in rounded border border-line-subtle"
              onClick={() => openImageFromDom(src)}
            />
          ))}
        </div>
      ) : null}

      <div
        ref={(element) => {
          if (element) element.inert = !open
        }}
        id={detailsId}
        className="flow-tool-details"
        data-open={open}
        aria-hidden={!open}
      >
        <div>
          {open || visited ? (
            digest ? (
              <div className="flow-tool-error" data-run-error="true">
                <p style={{ color: colorOf('failed') }}>{digest.brief}</p>
                {digest.full ? (
                  <button
                    type="button"
                    onClick={() => {
                      guard?.enterFree()
                      setRawOpen(!rawOpen)
                    }}
                    aria-expanded={rawOpen}
                    className="mt-1 text-fg-tertiary underline-offset-2 hover:underline"
                  >
                    {rawOpen ? '收起完整输出' : '查看完整输出'}
                  </button>
                ) : null}
                {rawOpen && digest.full ? <ToolOutput text={digest.full} motion={motion} /> : null}
              </div>
            ) : hasOutput ? (
              <ToolOutput text={run.output} motion={motion} />
            ) : null
          ) : null}
        </div>
      </div>
    </div>
  )
}
