import { create } from 'zustand'

interface ConfigSaveStatus {
  pending: number
  failedInBatch: boolean
  state: 'idle' | 'saving' | 'saved' | 'failed'
  begin: () => void
  finish: (ok: boolean) => void
}

/** 只记录本次界面发起的保存；主进程返回成功前绝不显示“已保存”。 */
export const useConfigSaveStatus = create<ConfigSaveStatus>((set) => ({
  pending: 0,
  failedInBatch: false,
  state: 'idle',
  begin: () =>
    set((s) => ({
      pending: s.pending + 1,
      failedInBatch: s.pending > 0 && s.failedInBatch,
      state: 'saving',
    })),
  finish: (ok) =>
    set((s) => ({
      pending: Math.max(0, s.pending - 1),
      failedInBatch: s.failedInBatch || !ok,
      state: s.failedInBatch || !ok ? 'failed' : s.pending > 1 ? 'saving' : 'saved',
    })),
}))
