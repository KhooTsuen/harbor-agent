import { bridge } from './backend'

/* 个人资料：名字 + 头像（见 types/profile.ts 的说明） */

export async function profileGet(): Promise<{ name: string; avatar: string }> {
  try {
    const result = await bridge?.profileGet?.()
    return { name: String(result?.name ?? ''), avatar: String(result?.avatar ?? '') }
  } catch {
    return { name: '', avatar: '' }
  }
}

export async function profileSetName(name: string): Promise<void> {
  try {
    await bridge?.profileSetName?.(name)
  } catch {
    /* 存不上就算了：界面上的名字是即时生效的，不该因为写盘失败而回滚 */
  }
}

/**
 * 选头像。返回错误信息（空串 = 成功）。
 *
 * 「用户取消了」不算错 —— 那种情况也返回空串，界面静默。
 */
export async function profilePickAvatar(): Promise<{ avatar: string; error: string }> {
  try {
    const result = await bridge?.profilePickAvatar?.()
    if (result?.ok) return { avatar: String(result.avatar ?? ''), error: '' }
    return { avatar: '', error: result?.canceled ? '' : String(result?.error ?? '选图失败') }
  } catch (error) {
    return { avatar: '', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function profileClearAvatar(): Promise<void> {
  try {
    await bridge?.profileClearAvatar?.()
  } catch {
    /* 同上：删不掉也就是头像还在，界面不用报错 */
  }
}
