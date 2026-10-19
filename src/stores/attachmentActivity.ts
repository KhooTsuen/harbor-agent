import { create } from 'zustand'
import { resolveDraftOwner } from '@/stores/thread/draftOwner'

interface PendingRead {
  token: number
  owner: string | null
}
interface FailedRead {
  owner: string | null
  message: string
}

interface AttachmentActivity {
  reads: PendingRead[]
  failures: FailedRead[]
  nextToken: number
  begin: (owner: string | null) => number
  end: (token: number) => void
  fail: (owner: string | null, message: string) => void
}

/** 读取任务只属于发起时的对话；切换对话不会把“处理中”投到另一条草稿。 */
export const useAttachmentActivity = create<AttachmentActivity>((set, get) => ({
  reads: [],
  failures: [],
  nextToken: 1,
  begin: (owner) => {
    const token = get().nextToken
    set((state) => ({
      nextToken: token + 1,
      reads: [...state.reads, { token, owner }],
      failures: state.failures.filter(
        (item) => resolveDraftOwner(item.owner) !== resolveDraftOwner(owner),
      ),
    }))
    return token
  },
  end: (token) => set((state) => ({ reads: state.reads.filter((read) => read.token !== token) })),
  fail: (owner, message) =>
    set((state) => ({
      failures: [
        ...state.failures.filter(
          (item) => resolveDraftOwner(item.owner) !== resolveDraftOwner(owner),
        ),
        { owner, message },
      ],
    })),
}))

export function pendingReadsFor(reads: PendingRead[], owner: string | null): number {
  if (!owner) return 0
  return reads.filter((read) => resolveDraftOwner(read.owner) === owner).length
}

export function attachmentFailureFor(failures: FailedRead[], owner: string | null): string | null {
  if (!owner) return null
  return failures.find((item) => resolveDraftOwner(item.owner) === owner)?.message ?? null
}
