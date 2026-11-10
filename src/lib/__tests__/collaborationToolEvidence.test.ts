import { afterEach, describe, expect, it } from 'vitest'

type Event = Record<string, unknown>
type Reply = {
  ok: boolean
  payload?: { toolOk?: boolean; text?: string }
  error?: { message: string }
}
const { observeCalls } = require('../../../electron/core/codex-mcp-observe.cjs') as {
  observeCalls: (
    invoke: (tool: string, args: Event, id: string) => Promise<Reply>,
  ) => (tool: string, args: Event, id: string) => Promise<Reply>
}
const contexts = require('../../../electron/core/codex-mcp-context.cjs') as {
  register: (id: string, context: Event) => boolean
  unregister: (id: string) => void
}
const id = 'collab-evidence-unit'
afterEach(() => contexts.unregister(id))

describe('collaboration bridge evidence', () => {
  it('keeps the actual tool output and a stable call identity through forwarding', async () => {
    const events: Event[] = []
    contexts.register(id, {
      confirm: () => true,
      collab: true,
      onTool: (event: Event) => events.push(event),
    })
    const response: Reply = { ok: true, payload: { text: 'real file contents', toolOk: true } }
    const invoke = observeCalls(async () => response)
    expect(await invoke('harbor_read_file', { path: 'a' }, id)).toBe(response)
    expect(events[0]).toMatchObject({
      type: 'agent.tool.started',
      name: 'read_file',
      args: { path: 'a' },
    })
    expect(events[1]).toMatchObject({
      type: 'agent.tool.completed',
      result: 'real file contents',
      toolCallId: events[0].toolCallId,
    })
  })

  it('transport success cannot turn a failed tool result into successful evidence', async () => {
    const events: Event[] = []
    contexts.register(id, {
      confirm: () => true,
      collab: true,
      onTool: (event: Event) => events.push(event),
    })
    await observeCalls(async () => ({ ok: true, payload: { text: 'denied', toolOk: false } }))(
      'harbor_write_file',
      {},
      id,
    )
    expect(events[1]).toMatchObject({ type: 'agent.tool.failed', ok: false, result: 'denied' })
  })

  it('records cancellation without swallowing it or producing a successful completion', async () => {
    const events: Event[] = []
    const controller = new AbortController()
    contexts.register(id, {
      confirm: () => true,
      signal: controller.signal,
      collab: true,
      onTool: (event: Event) => events.push(event),
    })
    const invoke = observeCalls(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new DOMException('stopped', 'AbortError')),
            { once: true },
          )
        }),
    )
    const pending = invoke('harbor_run_project_test', {}, id)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(events[1]).toMatchObject({ type: 'agent.tool.failed', ok: false, result: 'stopped' })
    expect(events.some((event) => event.type === 'agent.tool.completed')).toBe(false)
  })

  it('an observer failure cannot change the tool return value', async () => {
    contexts.register(id, {
      confirm: () => true,
      onTool: () => {
        throw new Error('observer unavailable')
      },
    })
    expect(await observeCalls(async () => ({ ok: true }))('harbor_read_file', {}, id)).toEqual({
      ok: true,
    })
  })
})
