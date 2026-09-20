import { create } from 'zustand'
import { profileClearAvatar, profileGet, profilePickAvatar, profileSetName } from '@/lib/profileApi'

/* ══════════════════════════════════════════════════════════════
   个人资料（头像 + 名字）

   侧栏左下角那个圆用它。原来那是个**写死的装饰**（一个圆里一个「我」字，
   `aria-hidden`，点了没反应）—— 历史遗留，这个 store 把它接上。

   名字即时改（输入框每敲一下就写配置：几十字节，无所谓），头像走系统选图框。
   ══════════════════════════════════════════════════════════════ */

interface ProfileState {
  name: string
  /** 头像的 data URL；空 = 没设过，界面显示名字首字 */
  avatar: string
  loaded: boolean
  /** 打开应用时读一次 */
  load: () => Promise<void>
  setName: (name: string) => void
  /** 选头像；返回错误信息（空串 = 成功或用户取消） */
  pickAvatar: () => Promise<string>
  clearAvatar: () => void
}

export const useProfileStore = create<ProfileState>((set) => ({
  name: '',
  avatar: '',
  loaded: false,

  load: async () => {
    const { name, avatar } = await profileGet()
    set({ name, avatar, loaded: true })
  },

  setName: (name) => {
    set({ name })
    void profileSetName(name)
  },

  pickAvatar: async () => {
    const { avatar, error } = await profilePickAvatar()
    if (avatar) set({ avatar })
    return error
  },

  clearAvatar: () => {
    set({ avatar: '' })
    void profileClearAvatar()
  },
}))

/** 侧栏那个圆里显示什么：有头像用头像，否则用名字首字，都没有就是「我」 */
export function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed ? [...trimmed][0].toUpperCase() : '我'
}
