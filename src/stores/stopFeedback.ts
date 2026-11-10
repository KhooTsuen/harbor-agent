import { create } from 'zustand'

/** UI acknowledgement only; the execution's terminal state still comes from the backend. */
export const useStopFeedback = create<{
  requests: Record<string, string>
  request: (threadId: string, execution: string) => void
  clear: (threadId: string, execution: string) => void
}>((set) => ({
  requests: {},
  request: (threadId, execution) =>
    set((state) => ({ requests: { ...state.requests, [threadId]: execution } })),
  clear: (threadId, execution) =>
    set((state) => {
      if (state.requests[threadId] !== execution) return state
      const requests = { ...state.requests }
      delete requests[threadId]
      return { requests }
    }),
}))
