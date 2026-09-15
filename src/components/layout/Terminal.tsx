import type { Project } from '@/types'
import { ptyAvailable } from '@/lib/ptyApi'
import { PreviewTerminal } from './terminal/PreviewTerminal'
import { XtermTerminal } from './terminal/XtermTerminal'

/* ══════════════════════════════════════════════════════════════
   Terminal —— 两种终端二选一

     · 桌面版（有 pty 桥）→ XtermTerminal：挂真 PTY，vim / top 都能跑
     · 浏览器预览          → PreviewTerminal：假终端，不碰本机

   判断放在这一个地方，两个实现各自不用关心「我在什么环境里跑」。
   ══════════════════════════════════════════════════════════════ */

export interface TerminalProps {
  project: Project
}

export function Terminal({ project }: TerminalProps) {
  if (!ptyAvailable()) return <PreviewTerminal project={project} />
  return <XtermTerminal project={project} />
}
