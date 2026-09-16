import { z } from 'zod'

/* ══════════════════════════════════════════════════════════════
   导入 / 迁移用的 schema

   和 src/types 里的类型一一对应，但**所有可选字段都给默认值** ——
   导入的是别人导出的文件、或者是旧版本导出的，缺字段很正常，
   缺了就给默认，而不是整个文件作废。
   ══════════════════════════════════════════════════════════════ */

const CodeBlockSchema = z.object({
  id: z.string(),
  language: z.string().default('text'),
  code: z.string().default(''),
})

const DiffLineSchema = z.object({
  type: z.enum(['add', 'remove', 'context']),
  content: z.string().default(''),
  oldLineNumber: z.number().optional(),
  newLineNumber: z.number().optional(),
})

const DiffFileSchema = z.object({
  path: z.string(),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  hunks: z
    .array(z.object({ header: z.string().default(''), lines: z.array(DiffLineSchema).default([]) }))
    .default([]),
})

const TerminalLineSchema = z.object({
  id: z.string(),
  type: z.enum(['input', 'output', 'error', 'info']),
  content: z.string().default(''),
  timestamp: z.number().default(0),
})

const ToolRunSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string().optional(),
  ok: z.boolean().default(true),
  output: z.string().default(''),
  ms: z.number().optional(),
})

export const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string().default(''),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().default(''),
  kind: z.enum(['text', 'code', 'diff', 'terminal', 'error']).default('text'),
  status: z.enum(['sending', 'streaming', 'sent', 'error']).default('sent'),
  timestamp: z.number().default(0),
  codeBlocks: z.array(CodeBlockSchema).optional(),
  diffs: z.array(DiffFileSchema).optional(),
  terminalLines: z.array(TerminalLineSchema).optional(),
  reasoning: z.string().optional(),
  toolRuns: z.array(ToolRunSchema).optional(),
  errorText: z.string().optional(),
  edited: z.boolean().optional(),
  regenerated: z.boolean().optional(),
  parentId: z.string().optional(),
})

export const ThreadSchema = z.object({
  id: z.string(),
  projectId: z.string().default(''),
  title: z.string().default('未命名'),
  messages: z.array(MessageSchema).default([]),
  status: z.enum(['idle', 'running', 'success', 'error', 'waiting']).default('idle'),
  mode: z.enum(['plan', 'pair', 'execute', 'goal']).default('pair'),
  model: z.string().default(''),
  reasoning: z
    .preprocess((v) => (v === 'medium' ? 'high' : v), z.enum(['low', 'high', 'max']))
    .default('high'),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  exportedAt: z.number().default(0),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
})

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().default('未命名项目'),
  description: z.string().default(''),
  path: z.string().default(''),
  branch: z.string().default('main'),
  icon: z.string().default(''),
  color: z.string().default(''),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
})

/**
 * 导出的文件格式。
 *
 * 注意 threads 是**必填**（不能给 default）—— 否则 `{nope: true}` 这种
 * 明显不对的文件也会通过校验，被当成「空导入包」，用户会以为导入成功了但什么都没有。
 */
export const ExportBundleSchema = z.object({
  exportedAt: z.string().optional(),
  version: z.number().default(1),
  threads: z.array(z.unknown()),
  projects: z.array(z.unknown()).optional(),
})
