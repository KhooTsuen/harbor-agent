import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import { expect } from 'vitest'

// Source coverage only in this delivery: do not run without the user's approval.
export type Event = Record<string, unknown>
export type Emit = ((event: Event) => void) & { requestId?: string }
export type Review = {
  verdict: 'PASS' | 'NEEDS_CHANGES' | 'BLOCKED'
  reasons: string[]
  issues: string[]
  nextSteps: string[]
  answer: string
}
export type Context = { round: number; previousResult: string; feedback?: Review }
export type Input = {
  signal: AbortSignal
  confirm: (request: Event) => Promise<boolean>
  sessionId: string
}
export type Execution = { finalContent: string; usage?: { total_tokens: number }; paused?: boolean }
export type Result = {
  accepted: boolean
  code?: string
  finalContent: string
  toolRuns: Array<{ id: string; output: string }>
  collaboration: {
    status: string
    rounds: Array<{ round: number; summary?: string }>
    usage: { knownTokens: number; unknownCalls: number }
  }
}
type ModuleBox = { exports: unknown }
type Wrapper = (
  exports: unknown,
  require: (id: string) => unknown,
  module: ModuleBox,
  filename: string,
  directory: string,
) => void

const core = resolve(__dirname, '../../../electron/core')
const nativeRequire = createRequire(import.meta.url)
function isolatedLoad(stubs: Record<string, unknown>) {
  const cache = new Map<string, ModuleBox>()
  const load = (file: string): unknown => {
    if (Object.hasOwn(stubs, file)) return stubs[file]
    const cached = cache.get(file)
    if (cached) return cached.exports
    const box: ModuleBox = { exports: {} }
    cache.set(file, box)
    const wrapper = runInThisContext(
      `(function(exports, require, module, __filename, __dirname) {\n${readFileSync(file, 'utf8')}\n})`,
      { filename: file },
    ) as Wrapper
    wrapper(
      box.exports,
      (id) => (id.startsWith('.') ? load(resolve(dirname(file), id)) : nativeRequire(id)),
      box,
      file,
      dirname(file),
    )
    return box.exports
  }
  return load
}

export const review = (verdict: Review['verdict'], answer = ''): Review => ({
  verdict,
  reasons: ['依据当前结果检查'],
  issues: verdict === 'PASS' ? [] : ['缺少第二个比较项'],
  nextSteps: verdict === 'NEEDS_CHANGES' ? ['补充第二项并解释差异'] : [],
  answer,
})

export function harness(
  options: {
    reviews?: Review[]
    maxRounds?: number
    maxTokens?: number
    execute?: (input: Input, emit: Emit, context: Context) => Execution | Promise<Execution>
    approve?: boolean
  } = {},
) {
  const controller = new AbortController()
  const events: Event[] = []
  const contexts: Context[] = []
  let reviews = 0
  let confirmations = 0
  let closed = 0
  let gateStopped = false
  const emit: Emit = Object.assign((event: Event) => events.push(event), { requestId: 'request' })
  const stubs: Record<string, unknown> = {
    [resolve(core, 'task.cjs')]: {
      update: () => {},
      recordModel: () => {},
      finish: () => {},
    },
    [resolve(core, 'task-resume.cjs')]: { openForRun: () => ({ id: 'parent-task' }) },
    [resolve(core, 'redact.cjs')]: {
      scrubStorage: (value: unknown) => value,
      redact: (text: string) => text,
    },
    [resolve(core, 'gate-denied.cjs')]: { stopped: () => gateStopped },
    [resolve(core, 'collab-images.cjs')]: {
      prepareRoles: async () => ({
        planner: { images: [], analysis: '' },
        executor: { images: [], analysis: '' },
      }),
    },
    [resolve(core, 'collab-stages.cjs')]: {
      runPlan: async () => ({
        ok: true,
        plan: { kind: 'writing', problem: '比较两种方案', scope: [] },
        usage: { total_tokens: 10 },
      }),
      runExecutor: async (
        input: Input,
        _root: string,
        _images: unknown,
        _plan: unknown,
        stageEmit: Emit,
        context: Context,
      ) => {
        contexts.push(context)
        expect(stageEmit.requestId).toBe('request')
        return options.execute
          ? options.execute(input, stageEmit, context)
          : { finalContent: `第 ${context.round} 轮成果`, usage: { total_tokens: 10 } }
      },
      runReview: async () => ({
        ok: true,
        review: (options.reviews ?? [review('PASS', 'A 的最终答复')])[reviews++],
        usage: { total_tokens: 10 },
      }),
      incomplete: (result: Execution) => (result.paused ? ['EXEC_PAUSED', '执行已暂停'] : null),
      constrainReview: (value: Review) => value,
    },
  }
  const { perform } = isolatedLoad(stubs)(resolve(core, 'collab-supervisor.cjs')) as {
    perform: (input: Record<string, unknown>, root: string) => Promise<Result>
  }
  const role = { kind: 'openai', providerId: 'p', model: 'm', label: 'model' }
  return {
    controller,
    contexts,
    events,
    denyGate: () => {
      gateStopped = true
    },
    counts: () => ({ reviews, confirmations, closed }),
    run: () =>
      perform(
        {
          goal: '比较两种方案并给结论',
          phaseKey: 'supervision',
          sessionId: 'session',
          roles: { planner: role, executor: { ...role, model: 'worker' } },
          providers: {},
          config: {},
          images: [],
          threadSettings: {},
          emit,
          limits: {
            maxRounds: options.maxRounds ?? 3,
            maxRuntime: 60,
            maxTokens: options.maxTokens ?? 0,
          },
          signal: controller.signal,
          closePending: () => {
            closed += 1
          },
          confirm: async () => {
            confirmations += 1
            return options.approve !== false
          },
        },
        core,
      ),
  }
}
