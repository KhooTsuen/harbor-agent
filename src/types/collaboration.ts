import { z } from 'zod'

const roleSchema = z.object({
  kind: z.enum(['openai', 'codex-cli']),
  providerId: z.string(),
  model: z.string(),
  label: z.string(),
})
const statusSchema = z.enum([
  'running',
  'waiting_user',
  'completed',
  'blocked',
  'paused',
  'cancelled',
  'failed',
])
const phaseSchema = z.enum(['plan', 'approval', 'execute', 'review', 'deliver'])
const planSchema = z.object({
  problem: z.string(),
  scope: z.array(z.string()),
  expected: z.string(),
  verify: z.string(),
  kind: z.enum(['research', 'writing', 'development', 'general']).optional(),
  steps: z.array(z.string()).optional(),
  criteria: z.array(z.string()).optional(),
})
const reviewSchema = z.object({
  verdict: z.enum(['PASS', 'NEEDS_CHANGES', 'BLOCKED']),
  reasons: z.array(z.string()),
  issues: z.array(z.string()),
  answer: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
  evidence: z
    .array(
      z.object({
        toolId: z.string(),
        claim: z.string(),
        quote: z.string(),
        purpose: z.enum(['fact', 'execution']).optional(),
      }),
    )
    .optional(),
})
const limitsSchema = z.object({
  maxRounds: z.number().int().positive(),
  maxRuntime: z.number().int().positive(),
  maxTokens: z.number().int().nonnegative(),
})

/** Optional additions preserve version 1 records without rewriting old history. */
export const collaborationSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  taskId: z.string(),
  roles: z.object({ planner: roleSchema, executor: roleSchema }),
  phase: phaseSchema,
  status: statusSchema,
  stages: z.array(
    z.object({
      phase: phaseSchema,
      role: z.enum(['planner', 'executor']),
      status: statusSchema,
      startedAt: z.number(),
      endedAt: z.number().optional(),
      taskId: z.string().optional(),
      round: z.number().int().nonnegative().optional(),
      note: z.string().optional(),
    }),
  ),
  plan: planSchema.optional(),
  review: reviewSchema.optional(),
  mode: z.literal('supervised').optional(),
  round: z.number().int().nonnegative().optional(),
  limits: limitsSchema.optional(),
  usage: z
    .object({
      knownTokens: z.number().nonnegative(),
      unknownCalls: z.number().int().nonnegative(),
    })
    .optional(),
  rounds: z
    .array(
      z.object({
        round: z.number().int().positive(),
        status: statusSchema,
        review: reviewSchema.optional(),
        summary: z.string().optional(),
      }),
    )
    .optional(),
  finalAnswer: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

export type CollaborationRecord = z.infer<typeof collaborationSchema>
export type CollabLimits = z.infer<typeof limitsSchema>
