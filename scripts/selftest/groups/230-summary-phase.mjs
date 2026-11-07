/**
 * 自检 / 230 —— 工作对话与总结对话分离
 *
 * ── 要钉的是什么（2026-11-08）──────────────────────────────────
 *
 * 工作阶段（有工具，能改文件）与总结阶段（只汇报，没有工具）是两个独立上下文。
 * 这一组钉四条：
 *   ① 分离判据：干过工具才开总结；纯聊天不开（不多花一次请求）
 *   ② 交接材料：只吃台账 + toolRuns，不靠模型自述；失败/未完成绝不裁
 *   ③ 工具隔离：总结请求体没有 tools，且返回的 tool_calls 一律不执行
 *   ④ 续写只在总结上下文里发生，回不到工作阶段
 *
 * ⚠️ 全走假上游（替换 llm.chatStream），不联网、不碰真实会话。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, require } from '../env.mjs'

const OPENAI_KIND = 'openai'

export async function run() {
  const paths = require(join(ROOT, 'electron/core/paths.cjs'))
  void paths
  const credentials = require(join(ROOT, 'electron/core/credentials.cjs'))
  const configModule = require(join(ROOT, 'electron/core/config.cjs'))
  const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
  const llm = require(join(ROOT, 'electron/core/llm.cjs'))
  const handoff = require(join(ROOT, 'electron/core/summary-handoff.cjs'))
  const summaryPhase = require(join(ROOT, 'electron/core/summary-phase.cjs'))
  const read = (rel) => require('node:fs').readFileSync(join(ROOT, rel), 'utf8')

  /* ══ ① 分离判据 ══════════════════════════════════════════════ */
  group('工作/总结分离 / ① 什么情况才开总结')
  check('★★ 干过工具 → 开总结', summaryPhase.wantSummary({ toolRuns: [{ name: 'x' }] }) === true)
  check('★★ 纯聊天（0 次工具）→ 不开总结（不多花一次请求）', summaryPhase.wantSummary({ toolRuns: [] }) === false)
  check('★ 没传 toolRuns 也不开（默认保守）', summaryPhase.wantSummary({}) === false)

  /* 判据**只**回答「要不要开」，不回答「做完没」 */
  const handoffSrc = read('electron/core/summary-handoff.cjs')
  check(
    '★★ 完成的判定走台账证据（不是在 wantSummary 里看 toolRuns 数量）',
    /verdictOf/.test(handoffSrc) && /outcomeOf/.test(handoffSrc),
    'verdictOf + taskOutcome.outcomeOf',
  )

  /* ══ ② 交接材料 ══════════════════════════════════════════════ */
  group('工作/总结分离 / ② 交接材料（控 token 但不漏关键项）')

  const mkTask = (over = {}) => ({
    id: 'task_probe',
    goal: '把导出按钮改成异步',
    star: '',
    plan: [
      { text: '第一步：读现有实现', done: true },
      { text: '第二步：改成异步', done: true },
      { text: '第三步：补测试', done: false },
    ],
    changedFiles: ['src/a.ts', 'src/b.ts'],
    commands: [
      { command: 'npm test', exitOk: true, result: '通过 100 项' },
      { command: 'npm run build', exitOk: false, result: '失败：找不到模块' },
    ],
    errors: [],
    steps: [],
    ...over,
  })
  const mkRuns = () => [
    { name: 'read_file', ok: true, output: '一大堆文件内容'.repeat(200), ms: 12 },
    { name: 'edit_file', ok: true, output: '改好了', ms: 30 },
    { name: 'run_shell', ok: false, output: '命令失败', ms: 900, error: { message: '退出码 1', reasonCode: 'EXIT_CODE', exitCode: 1 } },
  ]

  const built = handoff.buildHandoff({ task: mkTask(), toolRuns: mkRuns(), goal: '把导出按钮改成异步' })
  check('★★ 有失败项 → 判为部分完成（不谎报全部成功）', built.verdict === 'partial', built.verdict)
  check('★★ 失败项里有原因码与退出码', /EXIT_CODE/.test(built.text) && /退出码 1/.test(built.text))
  check('★★ 没做完的计划项写出来了', /第三步：补测试/.test(built.text))
  check('★★ 测试失败的事实写出来了', /失败/.test(built.text) && /npm run build/.test(built.text))
  check(
    '★★ 成功工具的输出正文没有整段塞进去（只留次数）',
    !built.text.includes('一大堆文件内容一大堆文件内容'),
    `材料长 ${built.text.length} 字`,
  )
  check('★ 材料总长可控（正常任务 < 2500 字）', built.text.length < 2500, `${built.text.length} 字`)
  check('★ 改动文件与命令的**数量**都报了', /改动文件 2 个/.test(built.text) && /执行命令 2 条/.test(built.text))

  /* 极端：失败项很多时**不许被截掉** */
  const manyFailures = Array.from({ length: 15 }, (_, i) => ({
    name: 'run_shell', ok: false, output: `失败 ${i}`,
    error: { message: `第 ${i} 条命令失败`, reasonCode: 'EXIT_CODE', exitCode: 1 },
  }))
  const manyBuilt = handoff.buildHandoff({ task: mkTask({ plan: [] }), toolRuns: manyFailures })
  check('★★★ 15 条失败全在（固定字符上限会先吃掉它们）', (manyBuilt.text.match(/第 \d+ 条命令失败/g) ?? []).length >= 10)
  check('★★ 全失败 → 判为没成功', manyBuilt.verdict === 'failed', manyBuilt.verdict)

  /* 全成功的正常任务 */
  const cleanBuilt = handoff.buildHandoff({
    task: mkTask({ plan: [{ text: '做完', done: true }], commands: [{ command: 'npm test', exitOk: true }] }),
    toolRuns: [{ name: 'read_file', ok: true }, { name: 'edit_file', ok: true }],
  })
  check('★ 全成功且计划勾完 → 判为完成', cleanBuilt.verdict === 'done', cleanBuilt.verdict)
  check('★ 完成时的措辞是「全部按计划完成」', /全部按计划完成/.test(cleanBuilt.text))

  /* ══ ③ 工具隔离（结构性的，不是靠提醒） ═══════════════════════ */
  group('工作/总结分离 / ③ 总结阶段不可能执行工具')
  const sumSrc = read('electron/core/summary-phase.cjs')
  check('★★★ 总结请求体里 tools 是空数组', /tools: \[\]/.test(sumSrc))
  /* ★ 剥掉注释再判（这个坑踩过多次：文件头里正写着「不接 executeToolCalls」） */
  const sumCode = sumSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★★★ 总结模块不引用 executeToolCalls（硬返回 tool_calls 也没人执行）', !/executeToolCalls/.test(sumCode))
  check(
    '★★ 只取 content，不看 toolCalls（pickText 是唯一出口）',
    /function pickText/.test(sumSrc) && /result\?\.content/.test(sumSrc),
  )
  check('★ 系统提示里明说「你没有工具」', /你没有工具/.test(sumSrc))

  /* ══ ④ 独立上下文 + 只跑两条消息 ═══════════════════════════════ */
  group('工作/总结分离 / ④ 总结不继承工作历史')

  const realChatStream = llm.chatStream
  const seen = []
  let nth = 0
  const sse = (text, finish) => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(c) {
        const enc = new TextEncoder()
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`))
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`))
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    }),
  })

  const provider = {
    id: 'selftest-summary', kind: OPENAI_KIND, baseUrl: 'https://summary.example/v1',
    credentialRef: 'provider:selftest-summary', chatPath: '/chat/completions',
    models: ['probe-model'], enabled: true,
  }
  credentials.set('provider:selftest-summary', 'sk-selftest-summary-123456')
  const cfg0 = configModule.get()
  const base = {
    ...cfg0, activeProvider: provider, providers: [provider],
    assistant: { ...cfg0.assistant, model: 'probe-model' },
    tools: { ...cfg0.tools, permission: 'full' },
    memory: { ...cfg0.memory, autoWrite: 'off' },
    fallback: { enabled: false, attempts: 0, retryOn: [] },
  }

  const created = []
  try {
    llm.chatStream = async (options) => {
      seen.push({
        tools: Array.isArray(options.tools) ? options.tools.length : -1,
        hasTools: 'tools' in options,
        messages: Array.isArray(options.messages) ? options.messages.length : 0,
        roles: (options.messages ?? []).map((m) => m.role).join(','),
        purpose: options.purpose ?? '(未传)',
        systemHasSummary: /汇报阶段/.test(String((options.messages ?? [])[0]?.content ?? '')),
      })
      nth += 1
      /* 第一轮：要工具（工作阶段）；第二轮：收尾（无工具调用）；第三轮：总结 */
      if (nth === 1) {
        return {
          content: '我读一下文件', reasoning: '', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          finishReason: 'tool_calls', sawDone: true, ttftMs: 1, latencyMs: 10,
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
        }
      }
      if (nth === 2) {
        return {
          content: '干活时的中间说明', reasoning: '', usage: null,
          finishReason: 'stop', sawDone: true, ttftMs: 1, latencyMs: 10, toolCalls: [],
        }
      }
      return {
        content: '汇报：改好了，测试通过。', reasoning: '', usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        finishReason: 'stop', sawDone: true, ttftMs: 1, latencyMs: 12, toolCalls: [],
      }
    }

    const runOnce = (history) =>
      loopCore.run({
        config: base, workdir: SANDBOX, mode: 'pair',
        signal: new AbortController().signal, emit: () => {}, confirm: async () => true,
        history, goal: '把导出按钮改成异步',
        sessionId: 'sess_selftest_summary', traceId: 'req_selftest_summary',
      })

    /* ── 有工具：应该在工作阶段之后多一次总结请求 ── */
    nth = 0
    const out = await runOnce([{ role: 'user', content: '把导出按钮改成异步' }])
    if (out?.taskId) created.push(out.taskId)

    check('★★★ 干过工具 → 真的多了一次独立请求（工作 2 次 + 总结 1 次）', seen.length === 3, `${seen.length} 次`)
    const sum = seen[2]
    check('★★★ 总结那次 tools 是空数组（结构上给不出工具）', sum?.tools === 0, JSON.stringify({ tools: sum?.tools, hasTools: sum?.hasTools }))
    check('★ 工作阶段那两次是带了工具的（对照组）', seen[0]?.tools > 0, String(seen[0]?.tools))
    check('★★★ 总结只有两条消息（system + 交接），不继承工作历史', sum?.messages === 2, `${sum?.messages} 条`)
    check('★★ 第一条是 system 且是汇报专用提示', sum?.roles === 'system,user' && sum?.systemHasSummary === true, sum?.roles)
    check('★★★ 总结请求带了 purpose=summary（用量能分开记）', sum?.purpose === 'summary', String(sum?.purpose))
    check('★★ 最终返回的是总结那段话，不是工作过程那段', /汇报：改好了/.test(out.content), out.content.slice(0, 60))
    check('★ 总结完整 → 不标截断', !out.truncated, String(out.truncated))

    /* ── 纯聊天：不该多出一次请求 ── */
    nth = 0
    seen.length = 0
    llm.chatStream = async (options) => {
      seen.push({ tools: Array.isArray(options.tools) ? options.tools.length : -1, messages: (options.messages ?? []).length, purpose: options.purpose ?? '(未传)' })
      return {
        content: '1+1 等于 2。', reasoning: '', usage: null, finishReason: 'stop',
        sawDone: true, ttftMs: 1, latencyMs: 5, toolCalls: [],
      }
    }
    const chat = await runOnce([{ role: 'user', content: '1+1 等于几' }])
    if (chat?.taskId) created.push(chat.taskId)

    check('★★★ 纯聊天只发 1 次请求（不为分离多花钱）', seen.length === 1, `${seen.length} 次`)
    check('★★ 纯聊天的回答就是模型原话（没被总结改写）', chat.content === '1+1 等于 2。', chat.content)
    check('★ 纯聊天那次 purpose 是 chat', seen[0]?.purpose === 'chat', String(seen[0]?.purpose))

    /* ── 总结阶段硬返回 tool_calls：不许被执行 ── */
    nth = 0
    seen.length = 0
    let execAfterSummary = false
    llm.chatStream = async (options) => {
      nth += 1
      seen.push({ tools: Array.isArray(options.tools) ? options.tools.length : -1 })
      if (nth === 1) {
        return {
          content: '读文件', reasoning: '', usage: null, finishReason: 'tool_calls', sawDone: true,
          ttftMs: 1, latencyMs: 5,
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
        }
      }
      if (nth === 2) {
        return { content: '好了', reasoning: '', usage: null, finishReason: 'stop', sawDone: true, ttftMs: 1, latencyMs: 5, toolCalls: [] }
      }
      /* 第 3 次是总结：恶意/异常地返回一个 write_file 调用 */
      execAfterSummary = true
      return {
        content: '汇报正文。', reasoning: '', usage: null, finishReason: 'tool_calls', sawDone: true,
        ttftMs: 1, latencyMs: 5,
        toolCalls: [{ id: 'evil', name: 'write_file', arguments: '{"path":"evil.txt","content":"x"}' }],
      }
    }
    const evil = await runOnce([{ role: 'user', content: '干点活' }])
    if (evil?.taskId) created.push(evil.taskId)
    check('★★★ 总结返回 tool_calls 时，正文仍取自 content', /汇报正文/.test(evil.content), evil.content.slice(0, 40))
    check('★★★ 那次工具调用没有被执行（结果里没有 write_file 的工具记录）', !(evil.toolRuns ?? []).some((r) => r.name === 'write_file'), JSON.stringify((evil.toolRuns ?? []).map((r) => r.name)))
    check('★ 对照：确实走到了总结那次（否则上面两条是空对空）', execAfterSummary === true)

    /* ── 总结被 length 截断 → 只续总结 ── */
    nth = 0
    seen.length = 0
    llm.chatStream = async (options) => {
      nth += 1
      const n = Array.isArray(options.messages) ? options.messages.length : 0
      seen.push({ n, tools: Array.isArray(options.tools) ? options.tools.length : -1, purpose: options.purpose ?? '' })
      if (nth === 1) {
        return { content: '读文件', reasoning: '', usage: null, finishReason: 'tool_calls', sawDone: true, ttftMs: 1, latencyMs: 5, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }] }
      }
      if (nth === 2) return { content: '好了', reasoning: '', usage: null, finishReason: 'stop', sawDone: true, ttftMs: 1, latencyMs: 5, toolCalls: [] }
      if (nth === 3) return { content: '汇报第一段。', reasoning: '', usage: null, finishReason: 'length', sawDone: true, ttftMs: 1, latencyMs: 5, toolCalls: [] }
      return { content: '汇报第二段。', reasoning: '', usage: null, finishReason: 'stop', sawDone: true, ttftMs: 1, latencyMs: 5, toolCalls: [] }
    }
    const cut = await runOnce([{ role: 'user', content: '干活' }])
    if (cut?.taskId) created.push(cut.taskId)

    check('★★★ 总结被截断 → 又发了一次（续写）', seen.length === 4, `${seen.length} 次`)
    /*
     * 续写那次是 4 条：原来的 2 条（system + 交接）+ 上一轮回复 + 「接着写」指令。
     * **关键是它仍然只含总结上下文** —— 绝不夹带工作对话的历史。
     */
    const cont = seen[3]
    check(
      '★★★ 续写仍只在总结上下文里（不夹带工作历史）',
      cont?.n === 4 && cont?.purpose === 'summary',
      `${cont?.n} 条 · purpose=${cont?.purpose}`,
    )
    check('★★★ 续写那次 tools 也是空（第二道闸同样成立）', cont?.tools === 0, String(cont?.tools))
    check('★★ 续写拼上后正文完整', /汇报第一段/.test(cut.content) && /汇报第二段/.test(cut.content), cut.content.slice(0, 60))
  } finally {
    llm.chatStream = realChatStream
    const dispose = await import('../env.mjs')
    dispose.disposeTasks(created)
  }

  /* ══ ⑤ 没破坏别的 ═════════════════════════════════════════════ */
  group('工作/总结分离 / ⑤ 没顺手改坏原有机制')
  const loopSrc = read('electron/core/loop.cjs')
  check('★★ 收尾走 finishTurn（分离的入口）', /finishTurn\(/.test(loopSrc))
  check('★ 截断标记仍往上带', /truncated: reply\.truncated/.test(loopSrc))
  check('★★ 工作阶段仍是原来的 Agent Loop（工具执行没动）', /executeToolCalls\(/.test(loopSrc))
  check('★ loop-model 的 purpose 可传（不再写死 chat）', /options\.purpose \?\? 'chat'/.test(read('electron/core/loop-model.cjs')))
  check('★ 旧接口 finishReply 还在（老调用方不受影响）', /finishReply/.test(read('electron/core/loop-reply.cjs')))
}
