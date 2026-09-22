import { join, readFileSync, require, ROOT, SANDBOX } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-043 真跑一遍：接回旧任务 + 记「用户改方向」

   从 44-steering.mjs 拆出来的 —— 那边加了「随口发新问题不许拉起旧任务」的回归守卫
   之后到了 330 行（上限 300）。这一组自带一整套 llm / 凭证 / config 替身，
   搬出来最干净。

   ★ 这里用的会话 id 是**独立的**：同一个会话里要是还留着别的 running /
     waiting_user 任务，activeForSession 会先挑中它们 —— 那就是在赌
     「目录恰好干净」，这个坑在这个项目里踩过好几次。
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

export async function run() {
  const created = []
  const SESSION = 'selftest-ag043b'
  function newTask(goal = '改方向测试') {
    const task = taskCore.create({ goal, sessionId: SESSION })
    created.push(task.id)
    return taskCore.get(task.id)
  }

  group('AG-043 / 真跑一遍（改方向落在原任务上）')
  const llmModule = require(join(ROOT, 'electron/core/llm.cjs'))
  const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
  const credentialsCore = require(join(ROOT, 'electron/core/credentials.cjs'))
  const { configModule } = require(join(ROOT, 'scripts/selftest/env.mjs'))
  const originalChatStream = llmModule.chatStream
  credentialsCore.set('provider:selftest-ag043', 'sk-selftest-ag043-123456')
  const provider = {
    id: 'selftest-ag043',
    name: '自检供应商',
    baseUrl: 'https://example.invalid/v1',
    credentialRef: 'provider:selftest-ag043',
    chatPath: '/chat/completions',
    models: ['probe-model'],
    enabled: true,
  }
  const config = {
    ...configModule.get(),
    activeProvider: provider,
    providers: [provider],
    assistant: { ...configModule.get().assistant, model: 'probe-model' },
    budget: { maxSteps: 50, maxToolCalls: 100, maxRuntime: 1800, maxRetries: 3, maxTokens: 0 },
    tools: { ...configModule.get().tools, permission: 'full' },
    memory: { ...configModule.get().memory, autoWrite: 'off' },
  }
  const liveTask = newTask('跑着跑着被叫停的活')
  taskCore.update(liveTask.id, { status: 'paused', pausedAt: Date.now() })
  const emittedSteer = []
  try {
    llmModule.chatStream = async () => ({
      content: '照你说的改。',
      reasoning: '',
      toolCalls: [],
      usage: null,
    })
    const steerResult = await loopCore.run({
      history: [{ role: 'user', content: '不要方案 A，改用方案 B' }],
      config,
      workdir: SANDBOX,
      mode: 'pair',
      goal: '不要方案 A，改用方案 B',
      /* 走「点继续」那条路：显式带 resumeTaskId —— 复用旧任务 + 说了新话 → 记改方向 */
      resumeTaskId: liveTask.id,
      sessionId: liveTask.sessionId,
      signal: new AbortController().signal,
      emit: (event) => emittedSteer.push(event),
      confirm: async () => true,
    })
    check('★ 接回的是原任务（不是新建）', steerResult.taskId === liveTask.id, steerResult.taskId)
    const after = taskCore.get(liveTask.id)
    check(
      '★ 用户那句话被记进台账',
      after.steering?.at(-1)?.text === '不要方案 A，改用方案 B',
      JSON.stringify(after.steering),
    )
    check('记的是原话（复盘时最有用）', (after.steering ?? []).length === 1)
  } finally {
    llmModule.chatStream = originalChatStream
    credentialsCore.remove('provider:selftest-ag043')
  }

  /* ── 任务**停着等你回话**时改方向：接回原任务 + 记 steering ── */
  /*
   * ★ 这条路以前没有行为测试（只有源码守卫）—— 我改「接回」逻辑时把它改坏了却没人红。
   *   waiting_user = 那一轮正停着等你说话，你这句话既是「回答」也可能「改方向」，
   *   所以本来就该接回（reopen 也只肯接 paused / waiting_user）。
   */
  group('AG-043 / 等你回话时改方向（waiting_user 接回 + 记 steering）')
  const waitingTask = taskCore.create({
    goal: '等你回话的任务',
    sessionId: 'selftest-ag043-wait',
    workdir: ROOT,
  })
  created.push(waitingTask.id)
  taskCore.setPlan(waitingTask.id, ['[x] 一', '[ ] 二'])
  taskCore.update(waitingTask.id, { status: 'waiting_user' })
  credentialsCore.set('provider:selftest-ag043', 'sk-selftest-ag043-123456')
  try {
    llmModule.chatStream = async () => ({
      content: '好，按你说的改。',
      reasoning: '',
      toolCalls: [],
      usage: null,
    })
    const r2 = await loopCore.run({
      history: [{ role: 'user', content: '换个思路，先做第二步' }],
      config,
      workdir: SANDBOX,
      mode: 'pair',
      goal: '换个思路，先做第二步',
      sessionId: 'selftest-ag043-wait',
      signal: new AbortController().signal,
      emit: () => {},
      confirm: async () => true,
    })
    check('★ 等你回话时说的新话 → 接回原任务', r2.taskId === waitingTask.id, r2.taskId)
    const afterWaiting = taskCore.get(waitingTask.id)
    check(
      '★ 而且记下了「用户改方向」',
      afterWaiting.steering?.at(-1)?.text === '换个思路，先做第二步',
      JSON.stringify(afterWaiting.steering),
    )
  } finally {
    llmModule.chatStream = originalChatStream
    credentialsCore.remove('provider:selftest-ag043')
  }

  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
