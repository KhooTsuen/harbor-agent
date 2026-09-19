import { join, readFileSync, require, ROOT, SANDBOX } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-041：Loop Detection

   文档的图形：

     Tool A → Tool B → Tool A → Tool B → Tool A → Tool B

   检测到之后说「检测到 Agent 可能陷入重复执行。正在重新规划任务…」，
   **超过阈值后请求用户介入**。

   三条设计决定，都在这一组钉住：

     · 判断按「**工具 + 参数**」而不是只按工具名 —— 连着读十个**不同**的文件
       是正常干活（AG-019 的缓存就是为了让它便宜），只有一模一样的调用才是卡住
     · 先改道、后交人：第一次只是把话说清楚让它换法子（和完成门禁同一个路子），
       连着几次不听才停下来问用户
     · 停下来交人时**不是失败**：任务标 paused（可恢复），并记下证据
   ══════════════════════════════════════════════════════════════ */

const guard = require(join(ROOT, 'electron/core/loop-guard.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskNotify = require(join(ROOT, 'electron/core/task-notify.cjs'))

const sig = (name, args) => guard.signatureOf({ name, args })
const A = sig('read_file', { path: 'a.txt' })
const B = sig('run_shell', { command: 'ls' })
const C = sig('search_web', { query: 'x' })

export async function run() {
  const created = []

  /* ── ① 认得出重复 ───────────────────────────────────── */
  group('AG-041 / 什么算转圈')
  const cycle = guard.detect([A, B, A, B, A, B])
  check('★ A B A B A B → 认出来（文档那个例子）', cycle.looping === true, JSON.stringify(cycle))
  check('认成周期 2', cycle.kind === 'cycle' && cycle.period === 2, JSON.stringify(cycle))
  check('算得出重复了几遍', cycle.count === 6)
  check(
    '把重复的东西带上（界面要显示）',
    Array.isArray(cycle.samples) && cycle.samples.length === 2,
  )

  const triple = guard.detect([A, B, C, A, B, C, A, B, C])
  check(
    '★ 周期 3 也认（A B C 重复三遍）',
    triple.looping && triple.kind === 'cycle' && triple.period === 3,
    JSON.stringify(triple),
  )

  check('同一个调用连三次 → repeat', guard.detect([A, A, A]).kind === 'repeat')
  check('连两次不算（可能只是重试一次）', guard.detect([A, A]).looping === false)
  check('A B 只来两遍不算（碰巧）', guard.detect([A, B, A, B]).looping === false)

  /* ── ② 不许误判正常干活 ─────────────────────────────── */
  group('AG-041 / 别把正常干活当转圈')
  check(
    '★ 连着读十个不同的文件 → 不算（AG-019 的缓存就是为这个）',
    guard.detect(Array.from({ length: 10 }, (_, i) => sig('read_file', { path: `f${i}.txt` })))
      .looping === false,
  )
  check(
    '★ 参数里对象键顺序不同也算同一个调用（JSON 得归一化）',
    guard.detect([
      sig('read_file', { a: 1, b: 2 }),
      sig('read_file', { b: 2, a: 1 }),
      sig('read_file', { a: 1, b: 2 }),
    ]).looping === true,
  )
  check(
    '参数是数组 / 嵌套也归一化',
    guard.stableArgs({ list: [1, 2], deep: { z: 1, a: 2 } }) ===
      guard.stableArgs({ deep: { a: 2, z: 1 }, list: [1, 2] }),
  )
  check('长参数截断（提示里别糊一大坨）', guard.stableArgs({ text: 'x'.repeat(500) }).length < 260)
  check(
    '没有参数不炸',
    guard.signatureOf({ name: 'x' }) === 'x()' && guard.signatureOf(null) === '()',
  )
  check('空序列不炸', guard.detect([]).looping === false && guard.detect(null).looping === false)
  check(
    '前面正常、只有尾巴在转 → 也认（看的是最近一段）',
    guard.detect([sig('x', {}), sig('y', {}), A, B, A, B, A, B]).looping === true,
  )

  /* ── ③ 改道的说法 ───────────────────────────────────── */
  group('AG-041 / 改道提示')
  const message = guard.nudgeMessage(cycle)
  check('说清「已陷入重复」', message.includes('陷入重复执行'), message.slice(0, 40))
  check('★ 点名重复的是什么', message.includes('read_file') && message.includes('run_shell'))
  check('★ 要求换法子（不是简单重试）', message.includes('换一个办法'))
  check('也允许「这事做不到，直说」', message.includes('直接说出来'))
  check('要求给出更新后的计划', message.includes('```plan'))
  const repeatMessage = guard.nudgeMessage(guard.detect([A, A, A]))
  check(
    'repeat 的措辞和 cycle 不一样',
    repeatMessage.includes('连着来了 3 次'),
    repeatMessage.slice(0, 40),
  )

  /* ── ④ 停下来交人 ───────────────────────────────────── */
  group('AG-041 / 超过阈值交给用户')
  const loopTask = taskCore.create({ goal: 'AG-041 转圈测试', sessionId: 'selftest-ag041' })
  created.push(loopTask.id)
  taskCore.update(loopTask.id, {
    status: 'paused',
    pausedAt: Date.now(),
    pauseReason: 'loop',
    pauseDetail: 'cycle',
    loopHit: { kind: 'cycle', period: 2, count: 6, samples: [A, B] },
  })
  const stopped = taskCore.get(loopTask.id)
  check('标成 paused（**不是 failed**）', stopped.status === 'paused')
  check('记下原因与证据', stopped.pauseReason === 'loop' && stopped.loopHit?.count === 6)
  check(
    '能接着做（可恢复）',
    require(join(ROOT, 'electron/core/task-resume.cjs')).canResume(loopTask.id) === true,
  )

  const notice = taskNotify.endNotice('paused', stopped)
  check('★ 转圈交人也要通知（用户多半没在看）', Boolean(notice), JSON.stringify(notice))
  check('是提醒不是错误', notice?.kind === 'warning', notice?.kind)
  check('正文说清重复了几遍', notice?.description.includes('3 遍'), notice?.description)

  /* ── ⑤ 接线：循环里真的查 ───────────────────────────── */
  group('AG-041 / 接线')
  const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
  check('★ 轮次边界查重复', loopSrc.includes('loopGuard.detect('))
  check(
    '★ 顶够次数就交人（带着 loopHit 停下来）',
    loopSrc.includes('loopNudges >= LOOP_NUDGE_LIMIT') && loopSrc.includes('loopHit,'),
  )
  check('★ 没到阈值只是改道（把提示塞回给模型）', loopSrc.includes('loopGuard.nudgeMessage('))
  check('推了 loop 事件（界面据此说话）', loopSrc.includes("type: 'loop'"))
  const runSrc = readFileSync(join(ROOT, 'electron/core/loop-run.cjs'), 'utf8')
  check('★ 停下来时记 pauseReason: loop', runSrc.includes("pauseReason: 'loop'"))

  /* ── ⑥ 真跑一遍：模型转圈，看它先改道、再交人 ───────── */
  group('AG-041 / 真跑一遍（模型一直 A B A B）')
  const llmModule = require(join(ROOT, 'electron/core/llm.cjs'))
  const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
  const credentialsCore = require(join(ROOT, 'electron/core/credentials.cjs'))
  const { configModule } = require(join(ROOT, 'scripts/selftest/env.mjs'))
  const originalChatStream = llmModule.chatStream
  credentialsCore.set('provider:selftest-ag041', 'sk-selftest-ag041-123456')
  const provider = {
    id: 'selftest-ag041',
    name: '自检供应商',
    baseUrl: 'https://example.invalid/v1',
    credentialRef: 'provider:selftest-ag041',
    chatPath: '/chat/completions',
    models: ['probe-model'],
    enabled: true,
  }
  const config = {
    ...configModule.get(),
    activeProvider: provider,
    providers: [provider],
    assistant: { ...configModule.get().assistant, model: 'probe-model' },
    /* 预算放大，免得它先撞预算停下来（这一组测的是转圈） */
    budget: { maxSteps: 50, maxToolCalls: 100, maxRuntime: 1800, maxRetries: 3, maxTokens: 0 },
    tools: { ...configModule.get().tools, permission: 'full' },
    memory: { ...configModule.get().memory, autoWrite: 'off' },
  }
  const emitted = []
  /* 交人时的相位（AG-043：必须是 paused —— 用 waiting_user 会让 Composer 卡在生成中）*/
  const life = require(join(ROOT, 'electron/core/lifecycle.cjs'))
  const phases = []
  const offPhases = life.onTransition((e) => phases.push(e.to))
  try {
    /* 永远 A → B → A → B…，每次都成功 */
    let call = 0
    llmModule.chatStream = async () => {
      call += 1
      const odd = call % 2 === 1
      return {
        content: '',
        reasoning: '',
        toolCalls: [
          odd
            ? {
                id: `c${call}`,
                name: 'read_file',
                arguments: JSON.stringify({ path: 'hello.txt' }),
              }
            : { id: `c${call}`, name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
        ],
        usage: null,
      }
    }

    const result = await loopCore.run({
      history: [{ role: 'user', content: '一直读同一个文件' }],
      config,
      workdir: SANDBOX,
      mode: 'pair',
      goal: '一直读同一个文件',
      sessionId: 'selftest-ag041',
      signal: new AbortController().signal,
      emit: (event) => emitted.push(event),
      confirm: async () => true,
    })
    created.push(result.taskId)

    check(
      '★ 转圈被发现并停下来（没跑满轮数）',
      result.exhausted === true && result.loopHit,
      JSON.stringify(result.loopHit),
    )
    check(
      '认成周期重复',
      result.loopHit?.kind === 'cycle' && result.loopHit?.period === 2,
      JSON.stringify(result.loopHit),
    )
    check('给用户的话里有「重新规划」和两个选择', String(result.content).includes('重新规划'))
    const loopEvents = emitted.filter((e) => e.type === 'loop')
    check(
      '★ 第一次是「改道」不是直接停',
      loopEvents.some((e) => e.handedOver === false),
    )
    check(
      '★ 顶够次数才交人',
      loopEvents.some((e) => e.handedOver === true),
      JSON.stringify(loopEvents.map((e) => e.handedOver)),
    )
    check('改道时把提示塞回了对话（模型看得见）', loopEvents.length >= 1)

    check(
      '★ 交人停下推的也是 paused 相位（不是 waiting_user）',
      phases.includes('paused') && !phases.includes('waiting_user'),
      JSON.stringify(phases),
    )
    const stoppedTask = taskCore.get(result.taskId)
    check('★ 任务标成 paused（不是 failed）', stoppedTask.status === 'paused', stoppedTask.status)
    check(
      '★ 台账里记着转圈的证据',
      stoppedTask.pauseReason === 'loop' && stoppedTask.loopHit?.period === 2,
      JSON.stringify(stoppedTask.loopHit),
    )
  } finally {
    offPhases()
    llmModule.chatStream = originalChatStream
    credentialsCore.remove('provider:selftest-ag041')
  }

  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
