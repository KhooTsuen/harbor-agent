import { join, readFileSync, require, ROOT, SANDBOX } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-042 控制台

   文档要一屏：任务 / 状态 / 当前步骤 / 运行时间 / Tool Calls / Retry / 权限 / 模型 / Token，
   操作 [Pause] [Stop] [查看计划] [查看 Tool] [查看 Diff] [调整权限]。

   这一组管**内核这一侧的数据**：重试次数与 token 要真的记进台账
   （界面只是照着显示；没有数据它就只能显示「—」）。
   界面那一半在 `src/components/chat/__tests__/taskConsole.test.tsx`。
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

export async function run() {
  const created = []
  function newTask(goal = '控制台测试') {
    const task = taskCore.create({ goal, sessionId: 'selftest-ag042' })
    created.push(task.id)
    return taskCore.get(task.id)
  }

  /* ── ① 控制台要的数字 ───────────────────────────────── */
  group('AG-042 / 控制台的数据')
  const task = newTask('把安装步骤改成脚本')
  check('新任务 token / 重试都是 0（不是 undefined）', task.tokens === 0 && task.retries === 0)

  taskCore.update(task.id, { tokens: 42_000, retries: 1 })
  const updated = taskCore.get(task.id)
  check('token 记得下（界面显示 42K）', updated.tokens === 42_000)
  check('重试次数记得下（界面显示 1 次）', updated.retries === 1)
  check(
    '模型、步骤数、运行时间都能从台账里取到',
    Array.isArray(updated.steps) && updated.createdAt > 0,
  )

  /* 预算里的 maxRetries 也要能拿到（「单个工具最多重试几次」那个提示） */
  const budget = require(join(ROOT, 'electron/core/budget.cjs'))
  check('上限来自预算里的 maxRetries', budget.resolve({}, updated).maxRetries === 3)

  /* ── ② 接线 ─────────────────────────────────────────── */
  group('AG-042 / 接线')
  const runSrc = readFileSync(join(ROOT, 'electron/core/loop-run.cjs'), 'utf8')
  check(
    '★ 跑完把 token 与重试次数记进台账',
    runSrc.includes('tokens:') && runSrc.includes('retries: counters.retries'),
  )
  check(
    '★ 重试次数是从 agent.retrying 事件里数的',
    runSrc.includes("event?.type === 'agent.retrying'"),
  )

  const consoleSrc = readFileSync(join(ROOT, 'src/components/chat/TaskConsole.tsx'), 'utf8')
  for (const label of ['暂停', '停止', '查看 Diff', '查看 Tool', '调整权限']) {
    check(`控制台有「${label}」`, consoleSrc.includes(label))
  }
  check('★ 「查看 Tool」打开底部面板的日志', consoleSrc.includes("openBottomPanel('log')"))
  check('★ 状态词走唯一那份（AG-031 的执法测试盯着）', consoleSrc.includes('labelOf(statusOfTask('))
  /*
   * 「当前步骤」只报**计划里还没打勾**的那条。
   * 这里钉住它不许退回「拿上一步的摘要凑」—— 真机上那样会显示成
   * 大段文件内容（nextAction 里塞的是工具结果）。
   */
  const centerSrc = readFileSync(join(ROOT, 'src/components/chat/taskCenterModel.ts'), 'utf8')
  check(
    '★ 当前步骤取计划里第一条没打勾的',
    centerSrc.includes('nextPlanStepOf') && centerSrc.includes('find((line) => !isPlanDone(line))'),
  )
  check('没有计划时不编一条出来', consoleSrc.includes('（没有计划）'))

  /* ── ③ 真跑一遍：那两个数字要真的写进台账 ───────────── */
  /*
   * ★ 上面只验证了「台账存得下」；「循环跑完会不会真的写进去」单测照不到
   *   （变异测试抓到：把写进去的值改成 0 也照样绿）。
   *   这里真跑一轮，并且让第一次工具调用**失败**（读一个不存在的文件）——
   *   只读工具的失败会自动重试一次，于是「重试次数」也有真数据可断言。
   */
  group('AG-042 / 真跑一遍（token 与重试都进台账）')
  const llmModule = require(join(ROOT, 'electron/core/llm.cjs'))
  const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
  const credentialsCore = require(join(ROOT, 'electron/core/credentials.cjs'))
  const { configModule } = require(join(ROOT, 'scripts/selftest/env.mjs'))
  const originalChatStream = llmModule.chatStream
  credentialsCore.set('provider:selftest-ag042', 'sk-selftest-ag042-123456')
  const provider = {
    id: 'selftest-ag042',
    name: '自检供应商',
    baseUrl: 'https://example.invalid/v1',
    credentialRef: 'provider:selftest-ag042',
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
  const emitted = []
  try {
    let round = 0
    llmModule.chatStream = async () => {
      round += 1
      if (round === 1) {
        return {
          content: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'read_file',
              /* 故意读一个不存在的文件 → 只读工具会自动重试一次（AG-016） */
              arguments: JSON.stringify({ path: 'no-such-file-ag042.txt' }),
            },
          ],
          /* 用量：控制台要显示的那个数 */
          usage: { prompt: 100, completion: 23, total: 123 },
        }
      }
      return { content: '读不到就算了。', reasoning: '', toolCalls: [], usage: null }
    }

    const result = await loopCore.run({
      history: [{ role: 'user', content: '读一下那个文件' }],
      config,
      workdir: SANDBOX,
      mode: 'pair',
      goal: '读一下那个文件',
      sessionId: 'selftest-ag042',
      signal: new AbortController().signal,
      emit: (event) => emitted.push(event),
      confirm: async () => true,
    })
    created.push(result.taskId)

    const finished = taskCore.get(result.taskId)
    check('★ 跑完 token 真的写进了台账（不是 0）', finished.tokens === 123, String(finished.tokens))
    check(
      '★ 自动重试次数也写进去了（读不到的文件重试过）',
      finished.retries >= 1,
      `${finished.retries}（retrying 事件 ${emitted.filter((e) => e.type === 'agent.retrying').length} 个）`,
    )
    check(
      '这两项不在界面里编（值对得上事件）',
      emitted.some((e) => e.type === 'agent.retrying'),
    )
  } finally {
    llmModule.chatStream = originalChatStream
    credentialsCore.remove('provider:selftest-ag042')
  }

  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
