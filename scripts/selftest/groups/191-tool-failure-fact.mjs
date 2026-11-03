import { check, group } from '../harness.mjs'
import { ROOT, join, readFileSync, require } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   工具失败事实（`electron/core/tool-failure.cjs`）—— 蓝图阶段 A 的第一切片

   **要钉的就是一句话：工具真失败时，事件 / 界面 / 磁盘三处读到同一份
   exitCode 与 reasonCode，不再靠文字前缀猜。**

   为什么非要有这一组：以前 `run_shell` 跑一条退出码 1 的命令，正文里只有
   `[退出码 1]` 而没有 `错误：` 前缀 —— `isToolOk` 判成功，界面显示绿勾。
   这类「测试全绿但行为是错的」正是 AGENT.md 第 4 节说的那种事故：
   `tsc` 过得去、单测也过得去，因为**没有任何一条测试真的跑过一条会失败的命令、
   再把三处的字段对一遍**。这里就是补这一条。

   ── 四条不能松的 ──
   ① 真跑：`run_shell` 真的执行一条退出码 7 的命令，不是塞一个假对象
      （`exit /b 7` 只是 cmd.exe 的语法；POSIX 上 `/bin/sh` 会把 `/b` 当非法参数、
       退出码成 2 —— 2026-11-04 CI 连红就是这条，见下面 FAIL_CMD）
   ② 三处一致：事件里的 error、toolRuns 记录里的 error、台账落盘的 step 三份对得上
   ③ `0` 与 `null` 不能混：成功是 exitCode 0，超时/中断是 null
   ④ 形状只有一处：前端 `rounds.ts` 的字段名与 `SHAPE_KEYS` 集合相同
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  group('错误事实 / 工具失败结构化（蓝图阶段 A）')

  const facts = require(join(ROOT, 'electron/core/tool-failure.cjs'))
  const { executeToolCalls } = require(join(ROOT, 'electron/core/tool-runner.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
  const kinds = require(join(ROOT, 'electron/core/error-kinds.cjs'))

  /* ── ① 真跑一条会失败的命令，看原始事实 ── */
  const shell = require(join(ROOT, 'electron/core/tools/run_shell.cjs'))
  const shellCtx = { workdir: ROOT, permission: 'full', log: { info() {}, warn() {} } }
  /* 退出码 7 的写法**按平台**：cmd 要 `/b`，sh 给了 `/b` 会变成 "Illegal number"、退出码 2。
     与 19-abort 组同一个口径 —— 判据要求的是「退出码 7」，不是「某个 shell 的语法」。 */
  const FAIL_CMD = process.platform === 'win32' ? 'exit /b 7' : 'exit 7'
  const failed = await shell.run({ command: FAIL_CMD }, shellCtx)
  check(
    '★ 非零退出：run_shell 自己就报 toolOk=false（不再靠文本前缀）',
    failed && failed.toolOk === false,
    JSON.stringify(failed).slice(0, 200),
  )
  check(
    '★ 退出码是独立字段，而且是 7',
    failed?.exitCode === 7,
    `exitCode=${failed?.exitCode}`,
  )
  check(
    '正文里那行 `[退出码 7]` 一字未动（两条按文本认状态的路径靠它）',
    String(failed?.text ?? '').includes('[退出码 7]'),
    String(failed?.text ?? '').slice(-60),
  )

  const okRun = await shell.run({ command: 'echo hi' }, shellCtx)
  check(
    '★ 成功时 exitCode 是 0，不是 null（「跑完了」和「没跑完」要分得开）',
    okRun?.toolOk === true && okRun?.exitCode === 0,
    JSON.stringify(okRun).slice(0, 160),
  )

  /* ── ② 组装：退出码优先于文本分类 ── */
  const fromExit = facts.of({
    toolName: 'run_shell',
    ok: false,
    output: '[退出码 7]',
    exitCode: 7,
  })
  check(
    '★ 退出码非 0 → reasonCode=EXIT_CODE，且 domain=code',
    fromExit?.reasonCode === 'EXIT_CODE' && fromExit?.domain === 'code' && fromExit?.exitCode === 7,
    JSON.stringify(fromExit),
  )
  const timedOut = facts.of({ toolName: 'run_shell', ok: false, output: '', timedOut: true })
  check(
    '★ 超时 → TIMEOUT 且 exitCode 必须是 null（不是 0、也不是 -1）',
    timedOut?.reasonCode === 'TIMEOUT' && timedOut?.exitCode === null,
    JSON.stringify(timedOut),
  )
  const aborted = facts.of({ toolName: 'run_shell', ok: false, output: '[用户已停止：命令没有启动]' })
  check('中断 → ABORTED（认的是 run_shell 里那两个写死的字面量）', aborted?.reasonCode === 'ABORTED')
  const missing = facts.of({ toolName: 'read_file', ok: false, output: '错误：文件不存在：x' })
  check(
    '文件不存在 → FILE_NOT_FOUND，domain=file',
    missing?.reasonCode === 'FILE_NOT_FOUND' && missing?.domain === 'file',
    JSON.stringify(missing),
  )
  check('成功时不产生失败事实（返回 null，不是空对象）', facts.of({ toolName: 'x', ok: true }) === null)

  /* ── ③ 分类表与原因码表不许漂 ── */
  /*
   * 两条兜底行为必须钉住 —— 它们是「退出码优先于文本分类」这个设计的底座：
   *
   *   · `classifyToolOutput` 只在「一个特征都没命中 + 以『错误：』开头」时兜底成
   *     tool_failure。这条被删掉的话，工具自报的错会掉进 unknown → needsUser=true
   *     → 界面让用户去看，而其实只是一条命令失败了。
   *   · 正文里的 `[退出码 N]` 被认成 process_exit（不是 timeout、更不是 unknown）——
   *     `MESSAGE_RULES` 里 `timeout` 排在 `退出码` 前面，命令输出里恰好有 "timeout"
   *     这个词时就会先命中超时。所以这里真跑一次，钉住「退出码这条路自己成立」。
   */
  const errorsCore = require(join(ROOT, 'electron/core/errors.cjs'))
  const fallbackInfo = errorsCore.classifyToolOutput('错误：说不清的失败')
  check(
    '工具只报了「错误：…」而无任何特征命中 → 兜底 tool_failure（不是 unknown）',
    fallbackInfo.kind === 'tool_failure',
    fallbackInfo.kind,
  )
  const exitKind = errorsCore.classifyToolOutput('[退出码 7]', { name: 'run_shell' })
  check(
    '★ 非零退出的正文被认成 process_exit（不是 unknown，不需要用户介入）',
    exitKind.kind === 'process_exit' && exitKind.needsUser === false,
    `${exitKind.kind} / needsUser=${exitKind.needsUser}`,
  )
  const unmapped = Object.keys(kinds.KINDS).filter(
    (kind) => !(kind in facts.FROM_KIND) && kind !== 'unknown',
  )
  check(
    '★ errors.KINDS 每一类都有原因码映射（新加一类忘了映射会红）',
    unmapped.length === 0,
    `没映射的：${unmapped.join(', ')}`,
  )

  /* ── ④ 三处一致：事件 = 记录 = 台账 ── */
  const task = taskCore.create({ title: 'selftest-191-工具失败事实' })
  const events = []
  const messages = []
  const runs = []
  await executeToolCalls({
    toolCalls: [
      {
        id: 'call_fail_191',
        name: 'run_shell',
        arguments: JSON.stringify({ command: FAIL_CMD }),
      },
    ],
    ctx: { ...shellCtx, taskId: task.id, signal: undefined },
    options: { taskId: task.id, history: [] },
    messages,
    toolRuns: runs,
    emit: (event) => events.push(event),
    turn: 0,
  })

  const failedEvent = events.find((e) => e.type === 'agent.tool.failed')
  const record = runs.find((r) => r.id === 'call_fail_191')
  const stored = taskCore.get(task.id)?.steps?.find((s) => s.tool === 'run_shell')

  check('★ 事件是 agent.tool.failed（成败写在事件名里）', Boolean(failedEvent))
  check(
    '★ 事件里的 error.exitCode = 7（界面能直接读，不用翻正文）',
    failedEvent?.error?.exitCode === 7,
    JSON.stringify(failedEvent?.error ?? null),
  )
  check(
    '★ 界面记录 toolRuns[].error 与事件是同一份（exitCode 7 / EXIT_CODE）',
    record?.error?.exitCode === 7 && record?.error?.reasonCode === 'EXIT_CODE',
    JSON.stringify(record?.error ?? null),
  )
  check('★ 界面记录 ok=false（这一行会画成失败，不再是绿勾）', record?.ok === false)
  check(
    '★ 台账落盘也带着同一份事实（reasonCode + exitCode 两个标量）',
    stored?.reasonCode === 'EXIT_CODE' && stored?.exitCode === 7,
    JSON.stringify(stored ?? null),
  )
  check('★ 台账那一步 ok=false（以前这里也是绿的）', stored?.ok === false)
  check(
    '★ 三处的 exitCode 完全相等（这就是「不再各算各的」）',
    failedEvent?.error?.exitCode === record?.error?.exitCode &&
      record?.error?.exitCode === stored?.exitCode,
    `${failedEvent?.error?.exitCode} / ${record?.error?.exitCode} / ${stored?.exitCode}`,
  )

  /* 成功的那次不该带 error（否则界面得自己判断「这个 error 算不算数」） */
  events.length = 0
  runs.length = 0
  messages.length = 0
  await executeToolCalls({
    toolCalls: [
      { id: 'call_ok_191', name: 'run_shell', arguments: JSON.stringify({ command: 'echo hi' }) },
    ],
    ctx: { ...shellCtx, taskId: task.id, signal: undefined },
    options: { taskId: task.id, history: [] },
    messages,
    toolRuns: runs,
    emit: (event) => events.push(event),
    turn: 0,
  })
  const okEvent = events.find((e) => e.type === 'agent.tool.completed')
  check(
    '成功的一步**没有** error 键（不是 null，是压根没有）',
    okEvent && !('error' in okEvent) && !('error' in runs[0]),
    JSON.stringify(okEvent ?? null).slice(0, 160),
  )

  taskCore.update(task.id, { status: 'cancelled' })
  taskCore.removeSafe(task.id)

  /* ── ⑤ 形状只有一处：前端声明的字段名必须与 SHAPE_KEYS 一致 ── */
  const types = readFileSync(join(ROOT, 'src/types/rounds.ts'), 'utf8')
  const block = /export interface ToolFailure \{([\s\S]*?)\n\}/.exec(types)
  const declared = block
    ? [...block[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
    : []
  const missingInTs = facts.SHAPE_KEYS.filter((key) => !declared.includes(key))
  const extraInTs = declared.filter((key) => !facts.SHAPE_KEYS.includes(key))
  check(
    '★ 内核 SHAPE_KEYS 与前端 ToolFailure 字段一一对应（少一个界面就读不到）',
    missingInTs.length === 0 && extraInTs.length === 0,
    `TS 缺：${missingInTs.join(',') || '无'}；TS 多：${extraInTs.join(',') || '无'}`,
  )

  /* zod 侧：不声明的话重开会话后字段被静静剥掉（子代理卡片消失就是这么来的） */
  const schemas = readFileSync(join(ROOT, 'src/lib/schemas.ts'), 'utf8')
  const missingInZod = facts.SHAPE_KEYS.filter((key) => !new RegExp(`\\b${key}:`).test(schemas))
  check(
    '★ zod 里每个字段都声明了（否则落盘后读不回来）',
    missingInZod.length === 0,
    `zod 缺：${missingInZod.join(',') || '无'}`,
  )

  /* ── ⑥ 源码守卫：两份执行器共用同一个判据，不许各写一套 ── */
  const runner = readFileSync(join(ROOT, 'electron/core/tool-runner.cjs'), 'utf8')
  const serial = readFileSync(join(ROOT, 'electron/core/loop-tools.cjs'), 'utf8')
  check(
    '★ 两份执行器都从 tool-failure 取 isToolOk（不再各写一份判据）',
    runner.includes("const { isToolOk, outTextOf } = toolFailure") &&
      serial.includes("const { isToolOk, outTextOf } = toolFailure"),
  )
  check(
    '★ 两份执行器都调 outcomeOf（失败事实只组装一处）',
    runner.includes('toolFailure.outcomeOf(') && serial.includes('toolFailure.outcomeOf('),
  )
  check(
    '★ run_shell 真的把退出码往回传（不是只写进文本）',
    readFileSync(join(ROOT, 'electron/core/tools/run_shell.cjs'), 'utf8').includes('exitCode,'),
  )
}
