import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type Data = Record<string, unknown>
type Reply = { ok: boolean; payload?: Data; error?: { code: string } }
const { runConversationTool, recheckConversation } =
  require('../../../electron/core/codex-mcp-collab.cjs') as {
    runConversationTool: (input: Data) => Promise<Reply>
    recheckConversation: (name: string, request: Data, id: string) => boolean
  }
const { cleanSearch } = require('../../../electron/core/codex-mcp-search-tool.cjs') as {
  cleanSearch: (input: Data) => { ok: boolean; args?: Data }
}
const contexts = require('../../../electron/core/codex-mcp-context.cjs') as {
  register: (id: string, context: Data) => boolean
  unregister: (id: string) => void
}
const { versionOf } = require('../../../electron/core/codex-mcp-edit-rules.cjs') as {
  versionOf: (file: string) => string
}
const root = path.dirname(require.resolve('../../../package.json'))
const id = 'supervision-bridge-safety'
afterEach(() => contexts.unregister(id))

function fixture(overrides: Data = {}) {
  const calls: { name: string; args: Data; ctx: Data }[] = []
  const ctx = { workdir: root, sessionId: id, permission: 'ask', allowNetwork: true }
  return {
    calls,
    input: {
      tool: 'harbor_search_web',
      args: { query: 'current attractions' },
      entry: { workdir: root, sessionId: id, allowNetwork: true, threadSettings: {} },
      ctx,
      toolsIndex: {
        execute: async (name: string, args: Data, context: Data) => {
          calls.push({ name, args, ctx: context })
          return 'actual host output'
        },
      },
      toolReply: (text: string, meta: Data) => ({ ok: true, payload: { text, meta } }),
      startedAt: Date.now(),
      writeEnabled: true,
      ...overrides,
    },
  }
}

describe('supervision MCP boundary', () => {
  it('keeps search endpoints and credentials outside model-controlled arguments', () => {
    expect(
      cleanSearch({ query: '  museums  ', endpoint: 'https://untrusted', apiKey: 'ignored' }),
    ).toEqual({
      ok: true,
      args: { query: 'museums' },
    })
    expect(cleanSearch({ query: 'museums', maxResults: 21 }).ok).toBe(false)
    expect(cleanSearch({ query: 'museums', fresh: 'true' }).ok).toBe(false)
  })

  it('uses the actual host search result with the original context', async () => {
    const { calls, input } = fixture({ args: { query: 'museums', fresh: true } })
    const reply = await runConversationTool(input)
    expect(calls).toEqual([
      { name: 'search_web', args: { query: 'museums', fresh: true }, ctx: input.ctx },
    ])
    expect(reply.payload?.text).toBe('actual host output')
  })

  it('does not call search when the conversation disallows network access', async () => {
    const { calls, input } = fixture({
      entry: { workdir: root, sessionId: id, allowNetwork: false, threadSettings: {} },
    })
    expect((await runConversationTool(input)).error?.code).toBe('NETWORK_DISABLED')
    expect(calls).toEqual([])
  })

  it('cannot bypass the bridge write switch with a full-permission conversation', async () => {
    const { calls, input } = fixture({
      tool: 'harbor_write_file',
      writeEnabled: false,
      ctx: { workdir: root, sessionId: id, permission: 'full' },
    })
    expect((await runConversationTool(input)).error?.code).toBe('WRITE_DISABLED')
    expect(calls).toEqual([])
  })

  it('carries the version into the approval request without performing a real edit', async () => {
    const file = path.join(root, 'package.json')
    const before = fs.readFileSync(file, 'utf8')
    const expectHash = versionOf(file)
    const { calls, input } = fixture({
      tool: 'harbor_edit_file',
      args: { path: 'package.json', oldText: before, newText: before, expectHash },
    })
    await runConversationTool(input)
    expect(calls[1]).toMatchObject({
      name: 'edit_file',
      args: { expectHash },
      ctx: { expectHash, freshApproval: true },
    })
  })

  it('rechecks the live write switch after the asynchronous prerequisite read', async () => {
    const file = path.join(root, 'package.json')
    const before = fs.readFileSync(file, 'utf8')
    const { calls, input } = fixture({
      tool: 'harbor_edit_file',
      args: { path: 'package.json', oldText: before, newText: before, expectHash: versionOf(file) },
      getSwitch: () => ({ mcpEnabled: true, writeEnabled: false }),
    })
    expect((await runConversationTool(input)).error?.code).toBe('WRITE_DISABLED')
    expect(calls.map((call) => call.name)).toEqual(['read_file'])
  })

  it('keeps read and project-test approvals independent of write permission', () => {
    contexts.register(id, {
      confirm: () => true,
      workdir: root,
      allowWrite: false,
      permission: 'readonly',
    })
    expect(recheckConversation('read_file', {}, id)).toBe(true)
    expect(recheckConversation('run_shell', {}, id)).toBe(true)
    expect(recheckConversation('write_file', {}, id)).toBe(false)
    contexts.unregister(id)
    expect(recheckConversation('read_file', {}, id)).toBe(false)
  })
})
