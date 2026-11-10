import type { InputAction } from '@/types/inputReply'

/** Legacy local callbacks remain local; only an explicit backend ack means received. */
export async function runInputCardAction(action: InputAction | undefined): Promise<{
  state: 'accepted' | 'local' | 'failed'
  error?: string
}> {
  try {
    if (!action) throw new Error('此请求暂时没有可用的提交入口，请等待新的请求。')
    const ack = await action()
    const result = ack && typeof ack === 'object' && typeof ack.ok === 'boolean' ? ack : undefined
    if (result && !result.ok) throw new Error(result.error || '后台未接受这次答复，请重试')
    return { state: result?.ok === true ? 'accepted' : 'local' }
  } catch (cause) {
    return {
      state: 'failed',
      error:
        (cause instanceof Error ? cause.message : String(cause)) || '提交时发生错误，请返回重试。',
    }
  }
}
