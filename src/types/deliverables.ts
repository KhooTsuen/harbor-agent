export interface Citation {
  id: string
  kind: 'web' | 'file'
  title: string
  url?: string
  path?: string
  startLine?: number
  endLine?: number
  domain?: string
  snippet?: string
  fetchedAt?: number
  sourceToolId?: string
  sourceExecId?: string
}

export interface Artifact {
  id: string
  type: 'document' | 'code' | 'patch' | 'report' | 'generated_file'
  name: string
  path?: string
  content?: string
  version?: number
  threadId?: string
  taskId?: string
  sourceMessageId?: string
  createdAt: number
  updatedAt?: number
  versions?: Array<{ version: number; content?: string; path?: string; createdAt: number }>
}

export interface FileProbe {
  ok: boolean
  exists?: boolean
  file?: boolean
  size?: number
  path?: string
  error?: string
}
