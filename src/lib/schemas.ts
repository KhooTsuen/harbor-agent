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

/**
 * 项目登记表里的一条（`data/projects.json` 的 items 元素）。
 *
 * 内核那边新建时字段是全的，但**用户可能手动改过这个文件**，所以全部走默认值：
 * 少一个 `pinned` 不该让整个项目列表读不出来（`projects:list` 会因为这个文件
 * 解析失败而返回空 → 侧栏所有项目一起消失）。
 *
 * ⚠️ 这里同时是渲染层 `ProjectRecord` 类型的来源（见 `types/projects.ts`）——
 * 形状只写一份，才不会「校验放过了、类型却是另一套」。
 */
export const ProjectRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  description: z.string().default(''),
  /** 内核叫 root，界面叫 path */
  root: z.string().default(''),
  branch: z.string().default('main'),
  icon: z.string().default(''),
  color: z.string().default(''),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  /** 跟着工作目录自动登记的 / 用户手建的 —— 界面据此决定空项目要不要显示 */
  auto: z.boolean().default(true),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
})

/** zod 推断出来的登记项类型 —— 渲染层的 `ProjectRecord` 就是它（见 `types/projects.ts`） */
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>

/** `projects:list` 的回执（`counts` 等用不上的字段被 zod 丢掉，不影响解析） */
export const ProjectsPayloadSchema = z.object({
  items: z.array(ProjectRecordSchema).default([]),
  activeId: z.string().default(''),
})

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
