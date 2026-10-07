/* window.workbench 的「文件与终端」一摊（从 backend.ts 拆出来的）。

   从 backend.ts 分出这一组是因为：它们是「跟磁盘和终端打交道」的方法，
   改动理由和配置 / 会话 / 模型那一摊完全不同。
   WorkbenchBridge 通过 extends 把它们合回去 —— 调用方看到的还是同一个桥。 */

import type { FsReadResult, FsTreeResult, ShellData, ShellRunResult } from './models'

/** 一个已附加的文件（主进程解析完的形状，见 electron/core/file-extract.cjs）。
    `kind` 决定界面怎么显示、发送时怎么拼进消息。 */
export interface AttachedFile {
  ok: boolean
  name: string
  path?: string
  size?: number
  ext?: string
  kind?: 'text' | 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'archive' | 'binary'
  /** 类别的中文称呼（主进程 `file-extract.cjs` 的 KIND_LABEL，界面直接显示，不另写一份） */
  label?: string
  /** 抽出来的正文（text / pdf / docx / xlsx / pptx）；binary 恒为空 */
  text?: string
  /** 图片附件的 data URL（交给现有图片预览条） */
  dataUrl?: string
  /** 压缩包条目名（最多 MAX_ENTRIES 条） */
  entries?: string[]
  entryCount?: number
  /** 抽出来有多少页 / 表 / 片（界面显示用） */
  pages?: number
  sheets?: number
  slides?: number
  /** 正文被截断了（没拿到全文，界面照实说） */
  truncated?: boolean
  /** 一句补充说明（比如「rar 只能登记大小」） */
  note?: string
  error?: string
}

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

  /* 图片查看器：跟系统打交道那三条（另存为 / 在文件夹里显示 / 复制到剪贴板） */
  imageSaveAs: (src: string) => Promise<{
    ok: boolean
    path?: string
    canceled?: boolean
    error?: string
  }>
  imageReveal: (src: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  imageCopy: (src: string) => Promise<{ ok: boolean; error?: string }>
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

  /* 「附加文件」：任何格式，主进程按扩展名分流解析（见 electron/core/file-extract.cjs） */
  attachFiles: () => Promise<{
    ok: boolean
    canceled?: boolean
    files?: AttachedFile[]
    /* 超过单次上限、没被采纳的那几个（界面照实说一句） */
    dropped?: number
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
