import { describe, expect, it } from 'vitest'

type Reply = {
  content: string
  finalContent: string
  truncated: string
  verdict: string
}
const { finishTurn } = require('../../../electron/core/loop-reply.cjs') as {
  finishTurn: (input: Record<string, unknown>) => Promise<Reply>
}
const { buildToolContext } = require('../../../electron/core/loop-tool-context.cjs') as {
  buildToolContext: (input: Record<string, unknown>) => {
    allowWrite: boolean
    allowNetwork: boolean
    lastUserText: string
  }
}
const protocol = '{"problem":"查资料","scope":[],"kind":"research"}'
function structured(result: Record<string, unknown>) {
  return {
    structuredOutput: true,
    result,
    toolRuns: [{ id: 'old-read', name: 'read_file', ok: false, output: 'missing file' }],
    transcript: { soFar: (tail: string) => ({ content: `earlier analysis\n${tail}` }) },
    callModel: () => {
      throw new Error('Structured protocol must not call a summary or continuation model')
    },
  }
}
function context(
  authorizationText: string | undefined,
  userText = '本轮明确授权修改相关源码并联网',
  threadSettings: Record<string, unknown> = {},
) {
  return buildToolContext({
    options: {
      collabSubStep: true,
      ...(authorizationText === undefined ? {} : { authorizationText }),
    },
    config: { tools: {} },
    mode: 'pair',
    userText,
    threadSettings,
  })
}

describe('supervised role output boundary', () => {
  it('keeps the last protocol response separate from chatter and failed earlier tools', async () => {
    const reply = await finishTurn(structured({ content: protocol, finishReason: 'stop' }))
    expect(reply.finalContent).toBe(protocol)
    expect(reply.content).toContain('earlier analysis')
    expect(reply.truncated).toBe('')
    expect(reply.verdict).toBe('chat')
  })

  it('does not adopt truncated JSON or spend another request continuing it', async () => {
    const reply = await finishTurn(structured({ content: protocol, finishReason: 'length' }))
    expect(reply.truncated).toBe('length')
    expect(reply.finalContent).toBe(protocol)
  })

  it('keeps an explicitly interrupted stream unaccepted even if its JSON parses', async () => {
    const reply = await finishTurn(structured({ content: protocol, sawDone: false }))
    expect(reply.truncated).toBe('stream_cut')
  })

  it('does not synthesize a missing protocol answer from successful-looking tool output', async () => {
    const reply = await finishTurn(structured({ content: '', finishReason: 'stop' }))
    expect(reply.finalContent).toBe('')
  })
})

describe('delegation authority boundary', () => {
  it('keeps original human write and network restrictions despite permissive plan text', () => {
    expect(context('只分析，不要联网')).toMatchObject({
      allowWrite: false,
      allowNetwork: false,
      lastUserText: '只分析，不要联网',
    })
  })

  it('does not turn a guide description of read-only work into a human restriction', () => {
    const original = '请修改项目里的这个问题'
    expect(context(original, '只分析，不要联网')).toMatchObject({
      allowWrite: true,
      allowNetwork: true,
      lastUserText: original,
    })
  })

  it('keeps explicit conversation permissions ahead of a human request', () => {
    expect(context('请修改项目', '', { allowWrite: false, allowNetwork: false })).toMatchObject({
      allowWrite: false,
      allowNetwork: false,
    })
  })

  it('retains the existing text authority behavior when no internal override is supplied', () => {
    expect(context(undefined, '只分析，不要联网')).toMatchObject({
      allowWrite: false,
      allowNetwork: false,
      lastUserText: '只分析，不要联网',
    })
  })
})
