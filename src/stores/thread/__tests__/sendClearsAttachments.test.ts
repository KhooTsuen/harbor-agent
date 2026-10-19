import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   发送后「待发附件区」必须清空

   2026-10-13 真机报的：贴图（粘贴）→ 输入框上方出现待发图片区 → 发出去之后，
   那条「N 张 · 会一起发给模型」还挂在那儿，得手动点掉。

   根因是 `sendMessage` 的两条出路清得不一致：
     · 排队那条（正在跑时发）清了三样：input / inputImages / inputFiles
     · **正常发送那条只清了 input / inputFiles —— 漏了 inputImages**
   所以图发是发出去了（消息里带着 images），预览条却赖着不走。

   这一组就钉「发完那一下 inputImages 必须空」。
   ══════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({ sent: [] as Array<{ requestId: string }> }))

vi.mock('@/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend')>()
  return {
    ...actual,
    useRealBackend: true,
    /* 新对话会先落盘建会话 —— 给个假的让流程往下走 */
    createSession: async () => ({ id: 'sess_test' }),
    subscribeChatEvents: () => () => {},
    sendChat: async (payload: { requestId: string }) => {
      h.sent.push(payload)
      return { ok: true }
    },
    abortChat: async () => {},
    confirmChat: async () => {},
  }
})

import { useAppStore } from '@/stores/useAppStore'
import { useThreadStore } from '@/stores/useThreadStore'
import { drainQueued } from '@/stores/thread/turnControl'

/* 真的 1×1 PNG —— 头里有 IHDR，发送前的图片闸门能免解码透传（见 imageFormat.probeSize） */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('发送后待发附件清空', () => {
  beforeEach(() => {
    useAppStore.getState().resetAll()
    useThreadStore.setState({ sendingThreads: [], input: '', inputImages: [], inputFiles: [] })
    h.sent = []
  })

  it('切换对话分别恢复图片、文件和文字', () => {
    const first = useAppStore.getState().createThread()
    useThreadStore.setState({
      input: 'first',
      inputImages: [PNG],
      inputFiles: [{ ok: true, name: 'first.txt', text: 'a' }],
    })
    const second = useAppStore.getState().createThread()
    expect(useThreadStore.getState().inputImages).toEqual([])
    useThreadStore.setState({
      input: 'second',
      inputFiles: [{ ok: true, name: 'second.txt', text: 'b' }],
    })
    useAppStore.getState().setActiveThread(first)
    expect(useThreadStore.getState().input).toBe('first')
    expect(useThreadStore.getState().inputImages).toEqual([PNG])
    expect(useThreadStore.getState().inputFiles[0].name).toBe('first.txt')
    useAppStore.getState().setActiveThread(second)
    expect(useThreadStore.getState().input).toBe('second')
    expect(useThreadStore.getState().inputFiles[0].name).toBe('second.txt')
  })

  it('后台对话出队保留附件，不使用当前对话草稿', async () => {
    const first = useAppStore.getState().createThread()
    useAppStore.getState().replaceThreadId(first, 'queue-owner')
    useThreadStore.setState({
      sendingThreads: ['queue-owner'],
      input: 'queued',
      inputImages: [PNG],
      inputFiles: [{ ok: true, name: 'queued.txt', text: 'queue-body' }],
    })
    useThreadStore.getState().sendMessage()
    expect(useThreadStore.getState().queuedMessages['queue-owner'][0]).toMatchObject({
      text: 'queued',
      images: [PNG],
    })
    const other = useAppStore.getState().createThread()
    useThreadStore.setState({
      sendingThreads: [],
      input: 'keep this',
      inputFiles: [{ ok: true, name: 'other.txt', text: 'other-body' }],
    })
    drainQueued('queue-owner')
    await vi.waitFor(() => expect(h.sent.length).toBe(1))
    const message = useAppStore
      .getState()
      .threads.find((t) => t.id === 'queue-owner')
      ?.messages.find((m) => m.role === 'user')
    expect(message?.images).toEqual([PNG])
    expect(message?.content).toContain('queue-body')
    expect(message?.content).not.toContain('other-body')
    expect(useAppStore.getState().activeThreadId).toBe(other)
    expect(useThreadStore.getState().input).toBe('keep this')
    expect(useThreadStore.getState().inputFiles[0].name).toBe('other.txt')
  })

  it('★ 贴图发出去之后 inputImages 清空（待发图片区不再残留）', async () => {
    const app = useAppStore.getState()
    const t = app.createThread()
    useAppStore.getState().setActiveThread(t)
    useThreadStore.setState({ input: '看这张图', inputImages: [PNG] })

    useThreadStore.getState().sendMessage()

    await vi.waitFor(() => expect(h.sent.length).toBe(1))
    expect(useThreadStore.getState().inputImages).toEqual([])
  })

  it('顺带：文字 + 文件也要清（别只修图那条）', async () => {
    const app = useAppStore.getState()
    const t = app.createThread()
    useAppStore.getState().setActiveThread(t)
    useThreadStore.setState({
      input: '看这两个',
      inputImages: [PNG],
      inputFiles: [{ ok: true, name: 'a.txt', kind: 'text', text: 'hi' }],
    })

    useThreadStore.getState().sendMessage()

    await vi.waitFor(() => expect(h.sent.length).toBe(1))
    expect(useThreadStore.getState().inputImages).toEqual([])
    expect(useThreadStore.getState().inputFiles).toEqual([])
    expect(useThreadStore.getState().input).toBe('')
  })
})
