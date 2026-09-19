import { SANDBOX, configModule, existsSync, join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-035：自动 Checkpoint ——「往台账里记什么」

   文档要记七样：Plan / State / Completed Steps / Files Changed /
   Tool Results / **Permissions** / **Model**。审计下来缺两样：

     · Model —— 台账里根本没这个字段（模型中途换过就看不出来）
     · Permissions —— 只记「批准」，**拒绝不记**（于是「任务怎么停了」查不出来）

   这一组盯这两样的「记」：能不能记、换模型留不留痕、拒绝留不留痕，
   外加**真跑一遍循环**确认接线没断（光有函数没人调，单测照不到 —— AG-027 的老教训）。
   另一半（把台账读成人话）在 36-diagnose 组。

   ★ 这一组会真的往 `data/tasks` 里写东西，所以整体套 try/finally：
     除了文件干净，还有别的原因 —— 「最近 20 条未完成任务」是别的组读真实目录
     算出来的，留一条 `paused` 在那里，下一轮就把那些组带红（这事真发生过）。
   ══════════════════════════════════════════════════════════════ */

const diag = require(join(ROOT, 'electron/core/task-diagnose.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const approvals = require(join(ROOT, 'electron/core/tools/approval.cjs'))

export async function run() {
  const created = []
  function newTask(goal = '把配置读一遍') {
    const task = taskCore.create({ goal, sessionId: 'selftest-ag035' })
    created.push(task.id)
    return task
  }

  try {
    /* ── ① Model ───────────────────────────────────────── */
    group('AG-035 / 记模型')
    const t1 = newTask('换模型的任务')
    check('新建时没有模型', (taskCore.get(t1.id).model ?? '') === '')
    check('★ 台账里得有这个字段（哪怕还是空的）', 'model' in taskCore.get(t1.id))

    taskCore.recordModel(t1.id, 'deepseek-flash')
    check('记下模型', taskCore.get(t1.id).model === 'deepseek-flash')

    const before = taskCore.get(t1.id).updatedAt
    taskCore.recordModel(t1.id, 'deepseek-flash')
    check('同一个模型不重复写盘（updatedAt 不动）', taskCore.get(t1.id).updatedAt === before)

    taskCore.recordModel(t1.id, 'deepseek-v4-pro')
    const switched = taskCore.get(t1.id)
    check('换模型后 model 是新的', switched.model === 'deepseek-v4-pro')
    check(
      '★ 换过的模型都留着（诊断里要写「换过几次」）',
      switched.models.join('|') === 'deepseek-flash|deepseek-v4-pro',
    )
    check(
      '同一个模型记两次不重复进列表',
      (() => {
        taskCore.recordModel(t1.id, 'deepseek-flash')
        return taskCore.get(t1.id).models.length === 2
      })(),
    )
    check(
      '没有 id / 空模型名不炸',
      taskCore.recordModel('', 'x') === null && taskCore.recordModel(t1.id, '') === null,
    )

    /* ── ② Permissions：拒绝也要留痕 ─────────────────────── */
    group('AG-035 / 记授权（含拒绝）')
    const t2 = newTask('要授权的任务')
    const denyCtx = { taskId: t2.id, granted: new Map(), confirm: async () => false }
    const denied = await approvals.ask(denyCtx, { kind: 'write', name: 'a.txt' })
    check('用户点拒绝 → 不放行', denied === false)
    const afterDeny = taskCore.get(t2.id).permissions
    check(
      '★ 拒绝被记下来了（以前只在批准时记）',
      afterDeny.length === 1 && afterDeny[0]?.approved === false,
    )
    check('记下了是什么操作', afterDeny[0]?.kind === 'write' && afterDeny[0]?.name === 'a.txt')

    const allowCtx = { taskId: t2.id, granted: new Map(), confirm: async () => true }
    await approvals.ask(allowCtx, { kind: 'write', name: 'a.txt' })
    check('批准也记（approved: true）', taskCore.get(t2.id).permissions?.[1]?.approved === true)
    /* 窗口内同类不再问 —— 这条记成 auto，诊断里要区分开 */
    await approvals.ask(allowCtx, { kind: 'write', name: 'b.txt' })
    check('窗口内自动放行的记成 auto', taskCore.get(t2.id).permissions?.[2]?.auto === true)

    /* 诊断报告得把这些**分类数出来**（不然「谁拒了我」还是看不出来） */
    const permReport = diag.diagnose(taskCore.get(t2.id)).text
    check(
      '★ 诊断里区分手动批准 / 自动放行 / 被拒',
      /手动批准 1 次.*自动放行 1 次.*被拒 1 次/.test(permReport),
      permReport.split(String.fromCharCode(10)).at(-3),
    )
    check('★ 被拒的那条点名写出来', permReport.includes('被拒：write'))

    /* ── ③ 接线：**真跑一遍循环** ───────────────────────── */
    /*
     * 上面测的是 recordModel / record 本身好不好用；「没人调它」这种拆法
     * 单测照不到（AG-027 的老教训）。第一版这里写的是源码守卫 —— 结果把调用
     * 改成 `if (false) taskCore.recordModel(...)` 它照样绿（正则匹配的是
     * 字符串，不是行为）。所以改成真跑一轮：模型与授权都得**从台账读出来**
     * 才算数。
     */
    group('AG-035 / 接线（真跑一遍循环）')
    const llmModule = require(join(ROOT, 'electron/core/llm.cjs'))
    const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
    const credentialsCore = require(join(ROOT, 'electron/core/credentials.cjs'))
    const originalChatStream = llmModule.chatStream
    credentialsCore.set('provider:selftest-ag035', 'sk-selftest-ag035-123456')
    const probeProvider = {
      id: 'selftest-ag035',
      name: '自检供应商',
      baseUrl: 'https://example.invalid/v1',
      credentialRef: 'provider:selftest-ag035',
      chatPath: '/chat/completions',
      models: ['probe-model'],
      enabled: true,
    }
    const loopConfig = {
      ...configModule.get(),
      activeProvider: probeProvider,
      providers: [probeProvider],
      assistant: { ...configModule.get().assistant, model: 'probe-model' },
      tools: { ...configModule.get().tools, permission: 'ask' },
      memory: { ...configModule.get().memory, autoWrite: 'off' },
    }
    const runOnce = (history, confirm) =>
      loopCore.run({
        history,
        config: loopConfig,
        workdir: SANDBOX,
        mode: 'pair',
        goal: history[0].content,
        sessionId: 'selftest-ag035',
        signal: new AbortController().signal,
        emit: () => {},
        confirm,
      })

    try {
      /* ① 一轮纯回答：用的是哪个模型要记进台账 */
      llmModule.chatStream = async () => ({
        content: '看完了',
        reasoning: '',
        toolCalls: [],
        usage: null,
      })
      const plain = await runOnce([{ role: 'user', content: '随便看看' }], async () => true)
      created.push(plain.taskId)
      const plainTask = taskCore.get(plain.taskId)
      check(
        '★ 真跑一轮后台账里有模型（接线没断）',
        plainTask?.model === 'probe-model',
        String(plainTask?.model),
      )

      /* ② 用户点拒绝：走一遍真循环，拒绝要落到台账的「授权」里 */
      let round = 0
      llmModule.chatStream = async () => {
        round += 1
        if (round === 1) {
          return {
            content: '',
            reasoning: '',
            toolCalls: [
              {
                id: 'call_deny',
                name: 'write_file',
                arguments: JSON.stringify({ path: 'denied.txt', content: 'x' }),
              },
            ],
            usage: null,
          }
        }
        return { content: '好', reasoning: '', toolCalls: [], usage: null }
      }
      const deniedRun = await runOnce([{ role: 'user', content: '写个文件' }], async () => false)
      created.push(deniedRun.taskId)
      const rec = (taskCore.get(deniedRun.taskId)?.permissions ?? [])[0]
      check('★ 用户拒绝 → 台账里留下「被拒」的记录', rec?.approved === false, JSON.stringify(rec))
      check('记下了是哪个工具在要权限', String(rec?.name) === 'write_file', String(rec?.name))
      check('拒绝是真的拒绝：文件没被写出去', existsSync(join(SANDBOX, 'denied.txt')) === false)
    } finally {
      llmModule.chatStream = originalChatStream
      credentialsCore.remove('provider:selftest-ag035')
    }
  } finally {
    for (const id of created) taskCore.remove(id)
    check(
      '测试任务已清理（不留未完成的垃圾给别的组）',
      created.every((id) => taskCore.get(id) === null),
    )
  }
}
