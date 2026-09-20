import { useEffect, useRef, useState } from 'react'
import { BRAND_NAME } from '@/constants'
import { Eraser, CornerDownLeft, Square } from 'lucide-react'
import type { Project, TerminalLine } from '@/types'
import { uid } from '@/lib/utils'
import { initialTerminal, terminalForCommand } from '@/lib/mock'
import { onShellData, shellAbort, shellCwd, shellRun } from '@/lib/shellApi'
import { useRealBackend } from '@/lib/backend'
import { TerminalOutput } from '@/components/chat/TerminalOutput'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'

/* ══════════════════════════════════════════════════════════════
   预览终端（浏览器里那个假的）

   **只在没有后端控制台时用**（`npm run dev:web` 的 UI 预览）。
   桌面版是真 PTY 终端，见 XtermTerminal.tsx。

   为什么两份都留着而不是删掉旧的：浏览器预览是调 UI 的地方，
   那边连不上本机 shell —— 没有这个假终端，右栏在预览环境下就是空的。
   它给的是一组固定回应，明确不碰用户文件。
   ══════════════════════════════════════════════════════════════ */

export interface PreviewTerminalProps {
  project: Project
}

function welcome(project: Project): TerminalLine[] {
  return [
    {
      id: uid('tl'),
      type: 'info',
      content: `${BRAND_NAME} 终端 —— ${project.path}`,
      timestamp: Date.now(),
    },
    { id: uid('tl'), type: 'output', content: '输入命令，回车执行。', timestamp: Date.now() + 10 },
  ]
}

export function PreviewTerminal({ project }: PreviewTerminalProps) {
  const isReal = useRealBackend

  const [lines, setLines] = useState<TerminalLine[]>(() =>
    isReal ? welcome(project) : initialTerminal(project),
  )
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [cwd, setCwd] = useState(project.path)
  const [runningId, setRunningId] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  /* 真实模式：cwd 以主进程为准 */
  useEffect(() => {
    if (!isReal) return
    void (async () => {
      const c = await shellCwd()
      if (c) setCwd(c)
    })()
  }, [isReal])

  /* 真实模式：订阅流式输出 */
  useEffect(() => {
    if (!isReal) return
    return onShellData((data) => {
      setLines((prev) => [
        ...prev,
        {
          id: uid('tl'),
          type: data.stream === 'stderr' ? 'error' : 'output',
          content: data.text,
          timestamp: Date.now(),
        },
      ])
    })
  }, [isReal])

  /* 浏览器预览环境切换项目时重置静态终端；桌面版 cwd 由主进程管理 */
  useEffect(() => {
    if (isReal) return
    setLines(initialTerminal(project))
    setCwd(project.path)
    setHistory([])
    setHistoryIndex(-1)
  }, [project, isReal])

  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  function run(raw: string): void {
    const command = raw.trim()
    if (!command) return

    if (command === 'clear') {
      setLines([])
      setHistory((h) => [command, ...h].slice(0, 50))
      setHistoryIndex(-1)
      return
    }

    setLines((prev) => [
      ...prev,
      { id: uid('tl'), type: 'input', content: command, timestamp: Date.now() },
    ])
    setHistory((h) => [command, ...h].slice(0, 50))
    setHistoryIndex(-1)

    /* ── 浏览器预览：静态响应，不执行本机命令 ── */
    if (!isReal) {
      const output = terminalForCommand(command, project, cwd)
      if (command.startsWith('cd')) {
        const target = command.slice(2).trim()
        if (target)
          setCwd((prev) =>
            target.startsWith('/') ? target : `${prev}/${target}`.replace(/\/+/g, '/'),
          )
      }
      setLines((prev) => [...prev, ...output])
      return
    }

    /* ── 真实模式：主进程执行 ── */
    const requestId = uid('sh')
    setRunningId(requestId)
    void (async () => {
      const result = await shellRun({ command, requestId })
      setRunningId((id) => (id === requestId ? null : id))
      if (result) {
        if (result.cwd) setCwd(result.cwd)
        if (!result.ok && result.error) {
          setLines((prev) => [
            ...prev,
            { id: uid('tl'), type: 'error', content: result.error ?? '', timestamp: Date.now() },
          ])
        }
      } else {
        setLines((prev) => [
          ...prev,
          {
            id: uid('tl'),
            type: 'error',
            content: '终端不可用（没有后端）',
            timestamp: Date.now(),
          },
        ])
      }
    })()
  }

  function abort(): void {
    if (!runningId) return
    void shellAbort(runningId)
    setRunningId(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex shrink-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-tertiary" title={cwd}>
          {runningId ? '● 运行中 ' : ''}
          {cwd}
        </span>
        {runningId ? (
          <Tooltip content="中断当前命令">
            <IconButton label="中断命令" size={28} onClick={abort}>
              <Square size={12} />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip content="清屏（clear）">
          <IconButton label="清屏" size={28} onClick={() => setLines([])}>
            <Eraser size={14} />
          </IconButton>
        </Tooltip>
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        <TerminalOutput lines={lines} className="h-full" emptyText="（清屏了，输入命令）" />
      </div>

      <form
        className="flex shrink-0 items-center gap-1.5 rounded-sm border border-line-subtle bg-bg-raised/60 px-2 py-1.5 focus-within:border-line-focus"
        onSubmit={(e) => {
          e.preventDefault()
          run(value)
          setValue('')
        }}
      >
        <span className="shrink-0 select-none font-mono text-xs text-fg-tertiary">❯</span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              const next = Math.min(historyIndex + 1, history.length - 1)
              if (next >= 0) {
                setHistoryIndex(next)
                setValue(history[next] ?? '')
              }
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              const next = historyIndex - 1
              setHistoryIndex(next)
              setValue(next < 0 ? '' : (history[next] ?? ''))
            }
          }}
          placeholder={isReal ? '输入命令，回车执行' : '输入命令，help 看全部'}
          aria-label="终端输入"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />
        <Tooltip content="回车执行">
          <button
            type="submit"
            aria-label="执行命令"
            className="shrink-0 rounded p-1 text-fg-tertiary transition-colors hover:bg-bg-hover hover:text-fg-primary"
          >
            <CornerDownLeft size={13} />
          </button>
        </Tooltip>
      </form>
    </div>
  )
}
