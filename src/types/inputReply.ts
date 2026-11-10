import { z } from 'zod'

export interface ConfirmationAck {
  ok: boolean
  error?: string
}

export const inputReplySchema = z.object({
  confirmId: z.string().min(1),
  execId: z.string().min(1),
  title: z.string(),
  details: z.array(z.string()),
  state: z.enum(['submitting', 'accepted', 'failed']),
  at: z.number(),
  error: z.string().optional(),
})

export type StoredInputReply = z.infer<typeof inputReplySchema>
export type InputAction = (() => void) | (() => Promise<void | ConfirmationAck>)
