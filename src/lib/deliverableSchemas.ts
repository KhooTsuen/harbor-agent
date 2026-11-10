import { z } from 'zod'

export const citationSchema = z.object({
  id: z.string(),
  kind: z.enum(['web', 'file']),
  title: z.string(),
  url: z.string().optional(),
  path: z.string().optional(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  domain: z.string().optional(),
  snippet: z.string().optional(),
  fetchedAt: z.number().optional(),
  sourceToolId: z.string().optional(),
  sourceExecId: z.string().optional(),
})

export const artifactSchema = z.object({
  id: z.string(),
  type: z.enum(['document', 'code', 'patch', 'report', 'generated_file']),
  name: z.string(),
  path: z.string().optional(),
  content: z.string().optional(),
  version: z.number().optional(),
  threadId: z.string().optional(),
  taskId: z.string().optional(),
  sourceMessageId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
  versions: z
    .array(
      z.object({
        version: z.number(),
        content: z.string().optional(),
        path: z.string().optional(),
        createdAt: z.number(),
      }),
    )
    .optional(),
})
