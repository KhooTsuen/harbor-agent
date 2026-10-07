/* window.workbench 的「文件与终端」一摊（从 backend.ts 拆出来的）。

   从 backend.ts 分出这一组是因为：它们是「跟磁盘和终端打交道」的方法，
   改动理由和配置 / 会话 / 模型那一摊完全不同。
   WorkbenchBridge 通过 extends 把它们合回去 —— 调用方看到的还是同一个桥。 */

import type { FsReadResult, FsTreeResult, ShellData, ShellRunResult } from './models'

export interface IoBridge {
  saveText: (payload: {
    defaultName: string
    content: string
  }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>

  pickJson: () => Promise<{
    ok: boolean
    content?: string
    path?: string
    canceled?: boolean
    error?: string
  }>

  fsWorkdir: () => Promise<{ workdir: string; exists: boolean }>
  fsTree: (dir?: string) => Promise<FsTreeResult>
  fsList: (
    dir: string,
  ) => Promise<{ ok: boolean; items?: Array<{ name: string; type: string }>; error?: string }>
  fsRead: (file: string) => Promise<FsReadResult>
  fsReveal: (target: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  pickImageAsDataUrl: () => Promise<{
    ok: boolean
    canceled?: boolean
    dataUrl?: string
    name?: string
    error?: string
  }>
  fsPickAndRead: () => Promise<{
    ok: boolean
    canceled?: boolean
    name?: string
    path?: string
    text?: string
    size?: number
    error?: string
  }>

  shellCwd: () => Promise<{ cwd: string }>
  shellReset: () => Promise<{ cwd: string }>
  shellRun: (payload: {
    command: string
    requestId: string
    timeout?: number
  }) => Promise<ShellRunResult>
  shellAbort: (requestId: string) => Promise<{ ok: boolean; error?: string }>
  onShellData: (callback: (data: ShellData) => void) => () => void

  ptyStart: (payload: { id: string; cols?: number; rows?: number; cwd?: string }) => Promise<{
    ok: boolean
    id?: string
    shell?: string
    pid?: number
    cols?: number
    rows?: number
    error?: string
  }>
  ptyWrite: (payload: { id: string; data: string }) => Promise<{ ok: boolean; error?: string }>
  ptyResize: (payload: {
    id: string
    cols: number
    rows: number
  }) => Promise<{ ok: boolean; error?: string }>
  ptyStop: (payload: { id: string }) => Promise<{ ok: boolean }>
  ptyStopAll: () => Promise<{ ok: boolean; closed?: number }>
  ptyList: () => Promise<{
    ok: boolean
    sessions: Array<{ id: string; pid: number; cols: number; rows: number; startedAt: number }>
  }>
  onPtyEvent: (
    callback: (
      event:
        | { type: 'data'; id: string; chunk: string }
        | { type: 'exit'; id: string; exitCode: number },
    ) => void,
  ) => () => void
}
