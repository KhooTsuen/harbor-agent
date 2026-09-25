import { useEffect, useRef, useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { RotateCw, Trash2 } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { Project } from '@/types'
import { onPtyEvent, ptyResize, ptyStart, ptyStop, ptyWrite } from '@/lib/ptyApi'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { colorOf } from '@/lib/statusLanguage'

/* ══════════════════════════════════════════════════════════════
   真终端

   为什么要 xterm 而不是自己画：
   PTY 吐的是 ANSI/VT 转义序列 —— 光标定位、清屏、改色、切备用屏。
   自己解析的话，`vim` 和 `top` 这种全屏程序必须实现一个屏幕缓冲区
   （不是「按行追加文本」能糊过去的）。那是几百行且永远修不完的活，
   而且做出来还不如 xterm。

   两件容易被忽略的事：
     · **尺寸要同步给 PTY**（ptyResize）。不报的话程序按 80×24 排版，
       面板一窄一宽就全乱。
     · **切标签时不能卸载**。卸载 = 杀会话，跑一半的 vim 就没了。
       所以 RightPanel 那边用 CSS 隐藏而不是条件渲染；重新可见时
       ResizeObserver 会自然触发一次 fit。
   ══════════════════════════════════════════════════════════════ */

/** 从应用主题的 CSS 变量取色，终端跟着主题走（fallback 与 Primer 深色映射一致） */
function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback

  return {
    background: v('--bg-canvas', '#0d1117'),
    foreground: v('--text-primary', '#f0f6fc'),
    cursor: v('--text-primary', '#f0f6fc'),
    cursorAccent: v('--bg-canvas', '#0d1117'),
    selectionBackground: v('--border-strong', '#3d444d'),
    black: v('--bg-canvas', '#0d1117'),
    brightBlack: v('--text-tertiary', '#818b98'),
    red: v('--diff-remove', '#f85149'),
    brightRed: v('--diff-remove', '#f85149'),
    green: v('--diff-add', '#3fb950'),
    brightGreen: v('--diff-add', '#3fb950'),
    yellow: v('--accent-yellow', '#d29922'),
    brightYellow: v('--accent-yellow', '#d29922'),
    blue: v('--accent-blue', '#4493f8'),
    brightBlue: v('--info', '#4493f8'),
    magenta: v('--accent-purple', '#ab7df8'),
    brightMagenta: v('--accent-purple', '#ab7df8'),
    cyan: v('--accent-green', '#3fb950'),
    brightCyan: v('--accent-green', '#3fb950'),
    white: v('--text-secondary', '#9198a1'),
    brightWhite: v('--text-primary', '#f0f6fc'),
  }
}

type Status = 'starting' | 'ready' | 'exited' | 'error'

export interface XtermTerminalProps {
  project: Project
}

export function XtermTerminal({ project }: XtermTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const [status, setStatus] = useState<Status>('starting')
  const [shell, setShell] = useState('')
  const [error, setError] = useState('')
  /* 换一个值就重建终端（「重新启动」按钮用） */
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const id = `term-${project.id}-${Date.now()}`
    const root = getComputedStyle(document.documentElement)

    const term = new XTerm({
      fontFamily: root.getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 12,
      lineHeight: 1.35,
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 5000,
      /* Windows 下让应用以为自己在 xterm 里，才会输出彩色 */
      theme: readTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    /* 主题切换时跟着变（应用是改 <html data-theme>，所以监听属性） */
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    })

    let disposed = false

    /** 尺寸同步。容器不可见（display:none）时 clientWidth 是 0，跳过 —— 硬 fit 会把 cols 算成 0 */
    const syncSize = (): void => {
      if (disposed) return
      if (host.clientWidth < 40 || host.clientHeight < 20) return
      try {
        fit.fit()
      } catch {
        return
      }
      void ptyResize(id, term.cols, term.rows)
    }

    const observer = new ResizeObserver(syncSize)
    observer.observe(host)

    const dataSub = term.onData((data) => void ptyWrite(id, data))
    const resizeSub = term.onResize(({ cols, rows }) => void ptyResize(id, cols, rows))

    /* Ctrl+C：有选区就复制，没选区照常发中断信号（和 Windows Terminal 一致） */
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'c') {
        if (term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection())
          return false
        }
      }
      return true
    })

    const off = onPtyEvent((event) => {
      if (event.id !== id) return
      if (event.type === 'data') {
        term.write(event.chunk)
        return
      }
      setStatus('exited')
      term.write(`\r\n\x1b[90m[进程已退出，退出码 ${event.exitCode}]\x1b[0m\r\n`)
    })

    void (async () => {
      const result = await ptyStart({ id, cols: term.cols, rows: term.rows, cwd: project.path })
      /* 组件已经卸载了（用户切走太快），把刚开的会话收掉，别留孤儿进程 */
      if (disposed) {
        void ptyStop(id)
        return
      }
      if (!result.ok) {
        setStatus('error')
        setError(result.error ?? '开终端失败')
        term.write(`\x1b[31m${result.error ?? '开终端失败'}\x1b[0m\r\n`)
        return
      }
      setStatus('ready')
      setShell(result.shell ?? '')
      syncSize()
      term.focus()
    })()

    return () => {
      disposed = true
      observer.disconnect()
      themeObserver.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      off()
      void ptyStop(id)
      term.dispose()
      termRef.current = null
    }
  }, [project.id, project.path, generation])

  function clear(): void {
    termRef.current?.clear()
    termRef.current?.focus()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line-hairline px-2 py-1">
        <span className="shrink-0 font-mono text-2xs text-fg-tertiary">
          {status === 'starting' ? '启动中…' : shell || 'shell'}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-tertiary"
          title={project.path}
        >
          {project.path}
        </span>
        {status === 'error' ? (
          <span
            className="shrink-0 font-mono text-2xs"
            style={{ color: colorOf('failed') }}
            title={error}
          >
            启动失败
          </span>
        ) : null}
        {status === 'exited' ? (
          <span className="shrink-0 font-mono text-2xs text-fg-tertiary">已退出</span>
        ) : null}
        <Tooltip content="重新启动终端">
          <IconButton label="重新启动终端" size={28} onClick={() => setGeneration((n) => n + 1)}>
            <RotateCw size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip content="清屏">
          <IconButton label="清屏" size={28} onClick={clear}>
            <Trash2 size={13} />
          </IconButton>
        </Tooltip>
      </div>

      {/* xterm 自己往这里塞 DOM，所以不要再套 text/font 相关的类 */}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-1 pt-1" />
    </div>
  )
}
