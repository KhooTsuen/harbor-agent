import { z } from 'zod'

/* ══════════════════════════════════════════════════════════════
   外部数据的运行时校验（zod）

   原则：**凡是来自磁盘 / localStorage / 网络的数据，进来先过 schema**。
   类型层面再严格，也挡不住用户手改过 jsonl 或版本升级带来的脏数据。
   ══════════════════════════════════════════════════════════════ */

/** 会话文件里的一行（jsonl 的每一行都是一个事件） */
export const StoredMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().default(''),
  ts: z.number().optional(),
  reasoning: z.string().optional(),
  toolCallId: z.string().optional(),
  toolRuns: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        ok: z.boolean().default(true),
        output: z.string().default(''),
        ms: z.number().optional(),
      }),
    )
    .optional(),
  error: z.string().optional(),
})

export const SessionMetaSchema = z.object({
  type: z.literal('meta'),
  id: z.string(),
  title: z.string(),
  mode: z.string(),
  model: z.string(),
  createdAt: z.number(),
})

/** 供 setter 用的更宽泛的「任意一行」——按 type 区分 */
export const SessionLineSchema = z.discriminatedUnion('type', [
  SessionMetaSchema,
  StoredMessageSchema.extend({ type: z.literal('message') }),
])

/** 配置里的供应商 */
export const ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  chatPath: z.string(),
  models: z.array(z.string()),
  enabled: z.boolean(),
})

/** 把未知数据安全地收窄成某个类型；失败返回 null（调用方决定回退策略） */
export function safeParse<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const result = schema.safeParse(data)
  return result.success ? result.data : null
}
