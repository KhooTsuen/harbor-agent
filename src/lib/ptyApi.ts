import type { Project } from '@/types'

/* ══════════════════════════════════════════════════════════════
   真终端（PTY）的桥包装

   输出是持续推来的（pty:data），不是一问一答，所以订阅和发送分开：
     · 发送：ptyWrite(id, keyboardInput)
     · 接收：onPtyEvent(cb) —— data / exit 两种都走它

   浏览器预览没有桥，ptyAvailable() 返回 false，界面那边会退回静态终端。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

export type PtyEvent =
  { type: 'data'; id: string; chunk: string } | { type: 'exit'; id: string; exitCode: number }

export interface PtyStartResult {
  ok: boolean
  id?: string
  shell?: string
  pid?: number
  cols?: number
  rows?: number
  error?: string
}

/** 有没有真终端可用（桌面版才有） */
export function ptyAvailable(): boolean {
  return Boolean(bridge?.ptyStart)
}

export async function ptyStart(payload: {
  id: string
  cols?: number
  rows?: number
  cwd?: string
}): Promise<PtyStartResult> {
  if (!bridge?.ptyStart) return { ok: false, error: '这个环境没有真终端' }
  try {
    return await bridge.ptyStart(payload)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  if (!bridge?.ptyWrite) return
  try {
    await bridge.ptyWrite({ id, data })
  } catch {
    /* 会话已经没了：忽略，用户看到的是「进程已退出」 */
  }
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  if (!bridge?.ptyResize) return
  try {
    await bridge.ptyResize({ id, cols, rows })
  } catch {
    /* 忽略 */
  }
}

export async function ptyStop(id: string): Promise<void> {
  if (!bridge?.ptyStop) return
  try {
    await bridge.ptyStop({ id })
  } catch {
    /* 忽略 */
  }
}

export async function ptyStopAll(): Promise<void> {
  if (!bridge?.ptyStopAll) return
  try {
    await bridge.ptyStopAll()
  } catch {
    /* 忽略 */
  }
}

export async function ptyList(): Promise<
  Array<{ id: string; pid: number; cols: number; rows: number; startedAt: number }>
> {
  if (!bridge?.ptyList) return []
  try {
    const result = await bridge.ptyList()
    return result.sessions ?? []
  } catch {
    return []
  }
}

export function onPtyEvent(callback: (event: PtyEvent) => void): () => void {
  if (!bridge?.onPtyEvent) return () => {}
  try {
    return bridge.onPtyEvent(callback)
  } catch {
    return () => {}
  }
}

/** 给上层拼提示用 */
export function ptyProjectLabel(project: Project): string {
  return project.path || project.name
}
