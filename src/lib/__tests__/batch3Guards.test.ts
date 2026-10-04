import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ══════════════════════════════════════════════════════════════
   第 3 批（下）：边界与判据

    25 `assistant.model` 不在任何供应商的模型列表里 → 没人提供它，实跑就 4xx
     7 规模授权「答过任何一次就算批过」→ 问一句无关的也能解锁扫全盘
    20 `browse` 与 `run_shell` 的网络策略 ask 口径统一（判据只留一处）

   问题 2 / 6 是**界面提示**（完全访问档下「每次先问」不生效、文件数那条不生效），
   按项目规矩必须真机看（`tmp/b3-machine-probe.cjs`），单测里不假装能验。
   ══════════════════════════════════════════════════════════════ */

const ROOT = join(__dirname, '..', '..', '..')
const require_ = createRequire(import.meta.url)

const modelPick = require_(join(ROOT, 'electron/core/config-model.cjs')) as {
  pickModel: (raw: unknown, providers: unknown, log?: unknown) => string
  serves: (provider: unknown, model: string) => boolean
}
const normalize = require_(join(ROOT, 'electron/core/config-normalize.cjs')) as {
  normalize: (raw: unknown) => {
    assistant: { model: string }
    providers: { id: string; models: string[] }[]
  }
}
const scaleAsk = require_(join(ROOT, 'electron/core/tools/scale-ask.cjs')) as {
  looksLikeScaleAsk: (questions: unknown) => boolean
}
const scaleGate = require_(join(ROOT, 'electron/core/tools/scale-gate.cjs')) as {
  gate: (input: unknown) => { level: string }
  noteAsked: (sessionId: string, questions?: unknown) => string | null
  grantsFor: (sessionId: string) => string[]
  reset: () => void
}
const shared = require_(join(ROOT, 'electron/core/tools/_shared.cjs')) as {
  decideNetAsk: (decided: unknown, upperWillAsk: boolean) => { pass: boolean; byPolicy?: boolean }
}
const browse = require_(join(ROOT, 'electron/core/tools/browse.cjs')) as {
  networkGuard: (url: string, ctx: unknown) => string
}
const runShell = require_(join(ROOT, 'electron/core/tools/run_shell.cjs')) as {
  networkGuard: (command: string, ctx: unknown) => string
}

const noopAudit = () => {}
const WORKDIR = 'D:\\proj'
const blocked = (sessionId: string) =>
  scaleGate.gate({
    name: 'run_shell',
    args: { command: 'dir /s C:\\' },
    ctx: { sessionId, workdir: WORKDIR },
    audit: noopAudit,
  }).level

/** 合规的规模确认提问（拦截文案要求：说清范围与代价、选项里写数字） */
const SCALE_ASK = [
  {
    question: '这次扫多大范围？大概多久？',
    options: [{ label: '整个 C 盘（约 50000 个文件，5 分钟）' }],
  },
]
/** 与规模无关的提问 —— 问题 7 的正身 */
const OFF_TOPIC_ASK = [{ question: '你想要什么风格？', options: [{ label: '简洁' }] }]

describe('问题 25：assistant.model 得真的有人提供', () => {
  it('没人提供 → 回落到第一个声明了模型的供应商，并留痕', () => {
    const notes: string[] = []
    const picked = modelPick.pickModel(
      'deepseek-chat',
      [{ id: 'd', name: 'DeepSeek', models: ['deepseek-flash', 'deepseek-v4-pro'], enabled: true }],
      { warn: (text: string) => notes.push(text) },
    )
    expect(picked).toBe('deepseek-flash')
    expect(notes.join('\n')).toContain('回落到')
  })

  it('有人提供 → 一个字不改（本仓库的默认配置就是这种情况）', () => {
    const providers = [{ id: 'd', models: ['deepseek-chat', 'deepseek-reasoner'], enabled: true }]
    expect(modelPick.pickModel('deepseek-chat', providers)).toBe('deepseek-chat')
  })

  it('models 为空 = 没声明支持哪些 → 当作「都能」（与运行时同口径）', () => {
    expect(modelPick.pickModel('whatever-x', [{ id: 'p', models: [], enabled: true }])).toBe(
      'whatever-x',
    )
  })

  it('一个供应商都没有时不改用户的选择（没依据就别动）', () => {
    expect(modelPick.pickModel('whatever-x', [])).toBe('whatever-x')
  })

  it('★ 真的走一遍 normalize：配置里的死模型被换成能用的', () => {
    const out = normalize.normalize({
      providers: [{ id: 'p', enabled: true, models: ['real-1', 'real-2'] }],
      assistant: { model: 'dead-model' },
    })
    expect(out.providers[0]?.models).toContain('real-1')
    expect(out.assistant.model).toBe('real-1')
  })
})

describe('问题 7：规模授权只认「紧接着那次、且问的是规模」', () => {
  it('判据本身：规模词 + 数字才算规模确认', () => {
    expect(scaleAsk.looksLikeScaleAsk(SCALE_ASK)).toBe(true)
    expect(scaleAsk.looksLikeScaleAsk(OFF_TOPIC_ASK)).toBe(false)
    /* 只有词没数字 / 只有数字没词 → 都不算（宁可再问一次） */
    expect(scaleAsk.looksLikeScaleAsk([{ question: '范围多大？' }])).toBe(false)
    expect(
      scaleAsk.looksLikeScaleAsk([{ question: '选哪个？', options: [{ label: '第 1 个' }] }]),
    ).toBe(false)
    expect(scaleAsk.looksLikeScaleAsk(undefined)).toBe(false)
  })

  it('★ 被答的是无关问题 → 不授权（以前答什么都算批过）', () => {
    scaleGate.reset()
    const session = 'vitest-scale-offtopic'
    expect(blocked(session)).toBe('blocked')
    expect(scaleGate.noteAsked(session, OFF_TOPIC_ASK)).toBe(null)
    expect(scaleGate.grantsFor(session)).toEqual([])
    expect(blocked(session)).toBe('blocked')
    scaleGate.reset()
  })

  it('★ 紧接着那次问的确实是规模 → 授权（功能没改坏）', () => {
    scaleGate.reset()
    const session = 'vitest-scale-ok'
    expect(blocked(session)).toBe('blocked')
    expect(scaleGate.noteAsked(session, SCALE_ASK)).toBe('scan')
    expect(blocked(session)).toBe('ok')
    scaleGate.reset()
  })

  it('★ 拦截后先跑了别的工具 → 那次「等授权」作废', () => {
    scaleGate.reset()
    const session = 'vitest-scale-wander'
    expect(blocked(session)).toBe('blocked')
    scaleGate.gate({
      name: 'read_file',
      args: {},
      ctx: { sessionId: session, workdir: WORKDIR },
      audit: noopAudit,
    })
    expect(scaleGate.noteAsked(session, SCALE_ASK)).toBe(null)
    expect(blocked(session)).toBe('blocked')
    scaleGate.reset()
  })
})

describe('问题 20 收尾：网络策略的 ask 口径只留一处判据', () => {
  it('判据表：allow 放行；deny 按策略拒；ask 看上层会不会问', () => {
    expect(shared.decideNetAsk({ action: 'allow' }, false).pass).toBe(true)
    expect(shared.decideNetAsk({ action: 'deny' }, true)).toEqual({ pass: false, byPolicy: true })
    expect(shared.decideNetAsk({ action: 'ask' }, true).pass).toBe(true)
    expect(shared.decideNetAsk({ action: 'ask' }, false)).toEqual({ pass: false, byPolicy: false })
  })

  it('★ browse 与 run_shell 在「先问」档下走同一条路', () => {
    /* 需要确认档 → 都放行，交给上层的确认框（转授权请求） */
    expect(
      browse.networkGuard('http://example.com/a', {
        netPolicy: { mode: 'ask' },
        permission: 'ask',
      }),
    ).toBe('')
    expect(
      runShell.networkGuard('curl https://example.com/', {
        netPolicy: { mode: 'ask' },
        shellPolicy: { medium: 'ask', high: 'ask', critical: 'block' },
      }),
    ).toBe('')

    /* 完全访问档 → 都不会问，所以都拒（不是一个放行一个拒） */
    expect(
      browse.networkGuard('http://example.com/a', {
        netPolicy: { mode: 'ask' },
        permission: 'full',
      }),
    ).toContain('没人被问')
    expect(
      runShell.networkGuard('curl https://example.com/', {
        netPolicy: { mode: 'ask' },
        shellPolicy: { medium: 'allow', high: 'allow', critical: 'allow' },
      }),
    ).toContain('没人被问')
  })
})
