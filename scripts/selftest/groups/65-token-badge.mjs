import { join, readFileSync, require, ROOT, SANDBOX, configModule } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-044 每轮用量：合计之外，入 / 出分开记

   为什么要入 / 出：只记合计看不出贵在哪 —— 同样 1 万 token，
   「每轮重发整个上下文」（入多）和「模型话多」（出多）是两种毛病，
   修法完全不同。台账里多这两个数，界面上就能说清。

   这一组钉三件事：
     ① 一条上游 usage 拆成 `{ total, input, output }`（名字 / 空值 / 垃圾值）
     ② **台账真的存得下** —— `taskCore.update` 只写白名单字段，
        名字没进白名单就被静默丢掉（我第一版想当然以为「多字段自动能存」）
     ③ **真跑一遍**，三个数真的写进台账；恢复（接着做）是「接着加」而不是从头算

   ⚠️ 本组**没有**登记进 `scripts/selftest.mjs`（按本轮任务要求）——
      它现在只有手动跑才生效。要让它进验证链，得在 selftest.mjs 的 GROUPS 里加一行。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const budget = require(join(ROOT, 'electron/core/budget.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

  /* ── ① 形状：一条 usage 怎么拆 ──────────────────────── */
  group('AG-044 / usage 拆成入与出')
  const parts = budget.usageParts({
    prompt_tokens: 100,
    completion_tokens: 23,
    total_tokens: 123,
  })
  check('入 = 上游的 prompt_tokens', parts.input === 100, JSON.stringify(parts))
  check('出 = 上游的 completion_tokens', parts.output === 23, JSON.stringify(parts))
  check('合计走的是同一个 usageTotal（不另算一套）', parts.total === 123)
  check(
    '★ 合计不是「入 + 出」硬加出来的（上游给了 total_tokens 就听它的）',
    budget.usageParts({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 999 }).total === 999,
  )

  /* 站点之间字段名不一致（AG-042 的账：把 total_tokens 读成 total，真机上永远是 0） */
  const alias = budget.usageParts({ prompt: 30, completion: 12 })
  check(
    '短名也认（prompt / completion）',
    alias.input === 30 && alias.output === 12 && alias.total === 42,
    JSON.stringify(alias),
  )
  const none = budget.usageParts(null)
  check(
    '没有 usage 时三个数都是 0（不 NaN）',
    none.total === 0 && none.input === 0 && none.output === 0,
    JSON.stringify(none),
  )
  const junk = budget.usageParts({ prompt_tokens: 'x', completion_tokens: undefined })
  check('垃圾值给 0（不 NaN）', junk.input === 0 && junk.output === 0 && junk.total === 0)

  /* ── ② 台账存得下吗 ─────────────────────────────────── */
  group('AG-044 / 台账存得下入与出')
  const probe = taskCore.create({ goal: '用量字段能不能落盘', sessionId: 'selftest-ag044' })
  try {
    taskCore.update(probe.id, { tokens: 123, tokensIn: 100, tokensOut: 23 })
    const saved = taskCore.get(probe.id)
    /*
     * ★ 这两条是本组的**要害**：`taskCore.update` 只写白名单里的字段，
     *   没进白名单的名字会被**静默丢掉** —— 界面上永远只能看到总数。
     */
    check('★ tokensIn 真落进台账（update 是白名单，不是随便合并）', saved.tokensIn === 100, String(saved.tokensIn))
    check('★ tokensOut 真落进台账', saved.tokensOut === 23, String(saved.tokensOut))
    check(
      '新建的任务**没有**这两个字段（AG-044 之前的老任务也一样 → 界面按「没分开记」显示）',
      probe.tokensIn === undefined && probe.tokensOut === undefined,
      JSON.stringify({ tokensIn: probe.tokensIn, tokensOut: probe.tokensOut }),
    )
  } finally {
    taskCore.remove(probe.id)
  }

  /* ── ③ 真跑一遍：三个数都进台账 ─────────────────────── */
  group('AG-044 / 真跑一遍（入与出都进台账）')
  const llmModule = require(join(ROOT, 'electron/core/llm.cjs'))
  const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
  const credentialsCore = require(join(ROOT, 'electron/core/credentials.cjs'))
  const originalChatStream = llmModule.chatStream
  const created = []

  credentialsCore.set('provider:selftest-ag044', 'sk-selftest-ag044-123456')
  const provider = {
    id: 'selftest-ag044',
    name: '自检供应商',
    baseUrl: 'https://example.invalid/v1',
    credentialRef: 'provider:selftest-ag044',
    chatPath: '/chat/completions',
    models: ['probe-model'],
    enabled: true,
  }
  const config = {
    ...configModule.get(),
    activeProvider: provider,
    providers: [provider],
    assistant: { ...configModule.get().assistant, model: 'probe-model' },
    /* maxTokens 关掉，免得撞预算把任务停下（这一组只关心用量怎么记） */
    budget: { maxSteps: 50, maxToolCalls: 100, maxRuntime: 1800, maxRetries: 3, maxTokens: 0 },
    tools: { ...configModule.get().tools, permission: 'full' },
    memory: { ...configModule.get().memory, autoWrite: 'off' },
  }
  /* ★ 上游真实字段名，一个都不省 —— 编错形状会让「读错字段」照样全绿 */
  const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }

  try {
    let round = 0
    llmModule.chatStream = async () => {
      round += 1
      if (round === 1) {
        return {
          content: '先看一眼\n\n```plan\n# 用量测试\n1. 读 hello.txt\n2. 汇报\n```',
          reasoning: '',
          toolCalls: [
            { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) },
          ],
          usage: USAGE,
        }
      }
      return { content: '读完了。', reasoning: '', toolCalls: [], usage: null }
    }

    const first = await loopCore.run({
      history: [{ role: 'user', content: '读一下 hello.txt' }],
      config,
      workdir: SANDBOX,
      mode: 'pair',
      goal: '读一下 hello.txt',
      sessionId: 'selftest-ag044',
      signal: new AbortController().signal,
      emit: () => {},
      confirm: async () => true,
    })
    created.push(first.taskId)

    const afterFirst = taskCore.get(first.taskId)
    check('合计进了台账', afterFirst.tokens === 150, String(afterFirst.tokens))
    check('★ 入进了台账（120）', afterFirst.tokensIn === 120, String(afterFirst.tokensIn))
    check('★ 出进了台账（30）', afterFirst.tokensOut === 30, String(afterFirst.tokensOut))
    check(
      '入 + 出 = 合计（不是各记一套口径）',
      afterFirst.tokensIn + afterFirst.tokensOut === afterFirst.tokens,
      `${afterFirst.tokensIn} + ${afterFirst.tokensOut} != ${afterFirst.tokens}`,
    )

    /* ── ④ 接着做：从基线往下加，不从头算 ── */
    taskCore.update(first.taskId, { status: 'paused', pausedAt: Date.now() })
    round = 0
    const second = await loopCore.run({
      history: [{ role: 'user', content: '接着做完' }],
      config,
      workdir: SANDBOX,
      mode: 'pair',
      goal: '接着做完',
      sessionId: 'selftest-ag044',
      resumeTaskId: first.taskId,
      signal: new AbortController().signal,
      emit: () => {},
      confirm: async () => true,
    })
    const afterSecond = taskCore.get(first.taskId)
    check('恢复复用的是同一条任务（没新建）', second.taskId === first.taskId, second.taskId)
    /*
     * ★ 这条盯的是「base 在**开始前**取」：turn_end 的 usage 是这次 run 的累计，
     *   从 0 重算的话，每「继续」一次就把之前的用量抹掉一次。
     */
    check(
      '★ 接着做是「加上去」而不是从头算（入 / 出也一样）',
      afterSecond.tokens === 300 &&
        afterSecond.tokensIn === 240 &&
        afterSecond.tokensOut === 60,
      `${afterSecond.tokens} / ${afterSecond.tokensIn} / ${afterSecond.tokensOut}`,
    )
  } finally {
    llmModule.chatStream = originalChatStream
    credentialsCore.remove('provider:selftest-ag044')
  }

  /* ── ⑤ 接线：这两个数真的能走到界面上 ───────────────── */
  group('AG-044 / 接线（界面拿得到这两个数）')
  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
  const runSrc = readFileSync(join(ROOT, 'electron/core/loop-run.cjs'), 'utf8')
  check(
    '★ loop-run 写的是三个字段（tokens / tokensIn / tokensOut）',
    runSrc.includes('tokensIn:') && runSrc.includes('tokensOut:') && runSrc.includes('tokens:'),
  )
  const typesSrc = readFileSync(join(ROOT, 'src/types/task.ts'), 'utf8')
  check(
    '★ 台账类型里有 tokensIn / tokensOut',
    typesSrc.includes('tokensIn?: number') && typesSrc.includes('tokensOut?: number'),
  )
  const badgeSrc = readFileSync(join(ROOT, 'src/components/chat/TaskTokenBadge.tsx'), 'utf8')
  const consoleSrc = readFileSync(join(ROOT, 'src/components/chat/TaskConsole.tsx'), 'utf8')
  check('★ 控制台挂上了用量徽标', consoleSrc.includes('<TaskTokenBadge task={task} />'))
  check(
    '徽标读的就是台账那三个数',
    badgeSrc.includes('task.tokensIn') &&
      badgeSrc.includes('task.tokensOut') &&
      badgeSrc.includes('task.tokens'),
  )
  check(
    '★ 缺入 / 出就只显示总数（不编一个「出 0」出来）',
    badgeSrc.includes('input > 0 && output > 0'),
  )
}
