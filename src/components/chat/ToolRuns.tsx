import { useState } from 'react'
import { extractImageUrls } from '@/lib/markdown'
import { openImageFromDom } from '@/stores/useImageLightbox'
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Terminal, XCircle } from 'lucide-react'
import type { ToolRunRecord } from '@/types'
import { cn } from '@/lib/utils'
import { colorOf } from '@/lib/statusLanguage'
import { useScrollGuard } from './scrollGuard'

/* ══════════════════════════════════════════════════════════════
   工具调用的**明细行**（一条调用一行）

   概览那一层（「读取 4 个文件、运行 5 条命令 等 5 类 · 24 步 · 868ms」）在
   `message/ToolLine.tsx` —— 整个项目里工具只有**那一种**排版了，
   不再有第二套带边框的卡片。

   为什么把卡片那套拆了（2026-09-30）：用户拿 VS Code 的截图对比后要求
   「就应该是那一行」，而且两套并存时同一份对话里新旧消息长得不一样，
   接缝一眼可见（旧记录存的是三个聚合字段，本来就没有分轮信息）。

   这里只剩两件共用件：
     · `formatMs` —— 毫秒说成人话，概览行也在用
     · `ToolRunRow` —— 单条调用的展开样子（工具名 / 参数 / 耗时 / 输出 / 产出图）

   设计上跟着 dsh-watcher 的思路走：只总结**能确定**的事，不编。
   没收录的工具就老实用原名 + 次数。
   ══════════════════════════════════════════════════════════════ */

/** 毫秒 → 人看的（<1s 给毫秒，<1min 给秒，再长给分秒）—— 时间线那边也用它 */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function ToolRunRow({ run }: { run: ToolRunRecord }) {
  const [open, setOpen] = useState(false)
  const guard = useScrollGuard()
  const running = run.output === '' && run.ms === undefined
  const hasOutput = run.output.trim().length > 0
  /* 工具输出里可能带图片（生图、下载图之类）—— 单独抠出来渲染 */
  const images = extractImageUrls(run.output)

  return (
    <div className="rounded-sm border border-line-subtle bg-bg-base/40">
      <button
        type="button"
        onClick={() => {
          if (!hasOutput) return
          setOpen((v) => !v)
          guard?.enterFree()
        }}
        aria-expanded={hasOutput ? open : undefined}
        className={cn(
          'flex w-full items-center gap-2 px-2 py-1.5 text-left text-2xs',
          hasOutput ? 'cursor-pointer hover:bg-bg-hover' : 'cursor-default',
        )}
      >
        {hasOutput ? (
          open ? (
            <ChevronDown size={12} className="shrink-0 text-fg-tertiary" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-fg-tertiary" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {running ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-fg-tertiary" />
        ) : run.ok ? (
          <CheckCircle2 size={12} className="shrink-0" style={{ color: colorOf('completed') }} />
        ) : (
          <XCircle size={12} className="shrink-0" style={{ color: colorOf('failed') }} />
        )}

        <Terminal size={11} className="shrink-0 text-fg-tertiary" />
        <span className="shrink-0 font-mono text-fg-secondary">{run.name}</span>
        {run.summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-fg-tertiary" title={run.summary}>
            {run.summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {/* 长任务自己报的进度（真机反馈 9a）：百分比在左、条在右 */}
        {run.progress ? (
          <span className="flex shrink-0 items-center gap-1.5" title={run.progress.note}>
            <span className="font-mono text-fg-tertiary">
              {run.progress.percent === null ? '进行中' : `${Math.round(run.progress.percent)}%`}
            </span>
            {/* 报不出百分比时**不给条**：一个填满的条会被误读成「快好了」 */}
            {run.progress.percent === null ? null : (
              <span className="h-1 w-16 overflow-hidden rounded-pill bg-bg-overlay">
                <span
                  className="block h-full rounded-pill transition-all duration-fast"
                  style={{
                    width: `${Math.max(2, Math.min(100, run.progress.percent))}%`,
                    background: colorOf('running'),
                  }}
                />
              </span>
            )}
          </span>
        ) : null}

        {run.ms !== undefined ? (
          <span className="shrink-0 font-mono text-fg-tertiary">{run.ms}ms</span>
        ) : null}
      </button>

      {/*
        工具输出里的图片**不管折不折叠都显示**。
        工具输出是纯文本（<pre>），`![图](x)` 只会显示成一堆方括号 ——
        生图工具明明返回了图，用户却只看到文件路径。这里把图抠出来直接渲染。
      */}
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-line-subtle px-2 py-2">
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

      {open && hasOutput ? (
        <pre className="max-h-64 overflow-auto border-t border-line-subtle px-2 py-1.5 font-mono text-2xs leading-[1.6] text-fg-secondary whitespace-pre-wrap break-all">
          {run.output}
        </pre>
      ) : null}
    </div>
  )
}
