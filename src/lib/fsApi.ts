import type { FileNode } from '@/types'
import type { FsNode, FsReadResult, FsTreeResult } from '@/types/models'

/* ══════════════════════════════════════════════════════════════
   文件系统的桥包装

   没有桥（浏览器预览）时返回 null；Electron 下走真实磁盘，路径都相对工作目录。
   ══════════════════════════════════════════════════════════════ */

const bridge = typeof window !== 'undefined' ? window.workbench : undefined

export async function fsWorkdir(): Promise<{ workdir: string; exists: boolean } | null> {
  if (!bridge) return null
  try {
    return await bridge.fsWorkdir()
  } catch {
    return null
  }
}

export async function fsTree(dir?: string): Promise<FsTreeResult | null> {
  if (!bridge) return null
  try {
    return await bridge.fsTree(dir)
  } catch {
    return null
  }
}

export async function fsRead(path: string): Promise<FsReadResult | null> {
  if (!bridge) return null
  try {
    return await bridge.fsRead(path)
  } catch {
    return null
  }
}

/** 附件：选文件读文本。canceled 表示用户没选。 */
export async function fsPickAndRead(): Promise<{
  ok: boolean
  canceled?: boolean
  name?: string
  path?: string
  text?: string
  size?: number
  error?: string
} | null> {
  if (!bridge) return null
  try {
    return await bridge.fsPickAndRead()
  } catch {
    return null
  }
}

export async function fsReveal(path: string): Promise<boolean> {
  if (!bridge) return false
  try {
    const result = await bridge.fsReveal(path)
    return result.ok
  } catch {
    return false
  }
}

/** 后端 FsNode（type 是 dir）→ 前端 FileNode（type 是 folder） */
export function toFileNode(node: FsNode): FileNode {
  return {
    id: node.path,
    name: node.name,
    type: node.type === 'dir' ? 'folder' : 'file',
    path: node.path,
    size: node.size,
    children: (node.children ?? []).map(toFileNode),
  }
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  graphql: 'graphql',
  xml: 'xml',
  svg: 'xml',
  dockerfile: 'dockerfile',
}

/** 扩展名 → 高亮语言。不认识就 text（原样展示） */
export function extToLanguage(ext: string): string {
  return EXT_LANG[String(ext ?? '').toLowerCase()] ?? 'text'
}
