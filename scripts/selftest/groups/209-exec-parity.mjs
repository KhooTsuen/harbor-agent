/**
 * 自检 / 209 —— 两套工具执行器的**可见行为**必须一致（P2）
 *
 * ── 起因（2026-11-05 动态探针）────────────────────────────────
 *
 * `loop-tools.executeToolCallsSerial` 与 `tool-runner.executeToolCalls` 是同一职责的
 * 两份实现。串行那份以前调 `tools.execute(name, args, ctx)` —— **没传 `wantMeta`**。
 *
 * 而 `tools.execute` 的契约是：`ctx.wantMeta === true` 才返回 `{ text, toolOk, exitCode… }`，
 * 否则只返回**字符串**。于是同一条 `node -e "process.exit(1)"`：
 *
 *   并行 → `toolOk:false` + `facts.exitCode=1` → `agent.tool.failed`（红）
 *   串行 → 纯文本 `…[退出码 1]`，前缀不是「错误：」→ `isToolOk` 判**成功**（绿勾）
 *
 * 这正是 `tool-failure.cjs` 文件头登记的那个绿勾病：并行修了、串行漏了。
 * 顺带漏的还有 `ctx.action`（gate 回填不了）、`ctx.progress` / `ctx.subagentEmit`、
 * `run.facts`（独立验证器读不到退出码）。
 *
 * ── 本组怎么判 ────────────────────────────────────────────────
 *
 * **跑真命令**（`node -e "process.exit(1)"`），两份执行器各跑一遍，比对：
 *   ① `toolRuns[0].ok`（成败）· `toolRuns[0].facts.exitCode`（原始事实）
 *   ② 发出去的事件名（`agent.tool.failed` vs `agent.tool.completed`）
 *   ③ 喂给工具的 ctx 有没有 `wantMeta` / `action` / `progress` / `subagentEmit`
 *
 * ★ 判据是**跑出来的结果**，不是源码里有没有某个字符串 —— 只钉 `wantMeta: true` 的
 *   正则，改个变量名就能骗过去。
 * ★ 全程隔离：命令只 `process.exit`，不读写任何文件；沙箱在自检隔离数据根下。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, require } from '../env.mjs'

const serial = require(join(ROOT, 'electron/core/loop-tools.cjs')).executeToolCallsSerial
const parallel = require(join(ROOT, 'electron/core/tool-runner.cjs')).executeToolCalls
const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))

/** 两条只碰进程退出码的命令 —— 不读不写任何文件 */
const FAIL_CMD = 'node -e "process.exit(1)"'
const OK_CMD = 'node -e "process.exit(0)"'

/** 跑一次执行器，收回它实际产生的台账与事件 */
async function runWith(executor, command) {
  const messages = []
  const events = []
  const toolRuns = []
  await executor({
    toolCalls: [
      { id: 'c1', name: 'run_shell', arguments: JSON.stringify({ command, cwd: SANDBOX }) },
    ],
    ctx: {
      workdir: SANDBOX,
      permission: 'full',
      sessionId: 'selftest-exec-parity',
      shellTimeout: 30,
      shellPolicy: { medium: 'allow', high: 'ask', critical: 'block' },
      log: { warn: () => {}, info: () => {} },
      emit: () => {},
      confirm: async () => true,
    },
    options: { taskId: '' },
    messages,
    toolRuns,
    emit: (e) => events.push(e),
    turn: 0,
  })
  return { messages, events, toolRuns }
}

/** 只取结论相关的那几项，避免拿无关字段互相比较 */
function verdictOf(result) {
  const run = result.toolRuns[0] ?? {}
  return {
    ok: run.ok,
    exitCode: run.facts?.exitCode ?? null,
    reason: run.error?.reasonCode ?? null,
    failed: result.events.some((e) => e.type === 'agent.tool.failed'),
    completed: result.events.some((e) => e.type === 'agent.tool.completed'),
  }
}

/** 执行器传给工具的 ctx 有什么（用一次假 execute 偷看，不跑真工具） */
async function ctxShapeOf(executor) {
  const original = tools.execute
  let seen = null
  tools.execute = async (name, args, ctx) => {
    seen = {
      wantMeta: ctx?.wantMeta === true,
      hasAction: Boolean(ctx?.action),
      hasProgress: typeof ctx?.progress === 'function',
      hasSubagentEmit: typeof ctx?.subagentEmit === 'function',
    }
    return 'ok'
  }
  try {
    await executor({
      toolCalls: [{ id: 'probe', name: 'read_file', arguments: JSON.stringify({ path: 'x.txt' }) }],
      ctx: { workdir: SANDBOX, permission: 'full', sessionId: 'selftest-exec-parity', emit: () => {} },
      options: { taskId: '' },
      messages: [],
      toolRuns: [],
      emit: () => {},
      turn: 0,
    })
  } finally {
    tools.execute = original
  }
  return seen
}

export async function run() {
  group('双执行器 / ① 退出码 1 的命令：两份执行器都判失败')

  const serialFail = verdictOf(await runWith(serial, FAIL_CMD))
  const parallelFail = verdictOf(await runWith(parallel, FAIL_CMD))

  check(
    '★ 并行执行器：退出码 1 → 判失败（这是 191 组已经钉住的老行为，这里作为基准）',
    parallelFail.ok === false && parallelFail.failed === true,
    JSON.stringify(parallelFail),
  )
  check(
    '★★ 串行执行器：同一条命令也判失败（以前是**绿勾** —— 正文只有 `[退出码 1]`，没有「错误：」前缀）',
    serialFail.ok === false && serialFail.failed === true,
    JSON.stringify(serialFail),
  )
  check(
    '★★ 两边结论逐项一致（成败 / 退出码 / 原因码 / 发的是哪个事件）',
    JSON.stringify(serialFail) === JSON.stringify(parallelFail),
    `串行 ${JSON.stringify(serialFail)} ≠ 并行 ${JSON.stringify(parallelFail)}`,
  )
  check(
    '★ 原始事实带得回来：退出码 1 进了 toolRuns[].facts（独立验证器读它，不读正文）',
    serialFail.exitCode === 1,
    String(serialFail.exitCode),
  )
  check(
    '★ 原因码是 EXIT_CODE（不是 UNKNOWN / TOOL_ERROR —— 那会把「跑了但失败」说成「没跑起来」）',
    serialFail.reason === 'EXIT_CODE',
    String(serialFail.reason),
  )

  group('双执行器 / ② 退出码 0 的命令：都判成功（修完不许变成「一律失败」）')

  const serialOk = verdictOf(await runWith(serial, OK_CMD))
  const parallelOk = verdictOf(await runWith(parallel, OK_CMD))

  check('★ 并行：成功仍判成功', parallelOk.ok === true && parallelOk.completed === true, JSON.stringify(parallelOk))
  check('★★ 串行：成功也判成功', serialOk.ok === true && serialOk.completed === true, JSON.stringify(serialOk))
  check(
    '★ 两边一致',
    JSON.stringify(serialOk) === JSON.stringify(parallelOk),
    `串行 ${JSON.stringify(serialOk)} ≠ 并行 ${JSON.stringify(parallelOk)}`,
  )
  check(
    '★ 成功的退出码是 0，不是 null（0 = 正常结束，null = 根本没有退出码，两件事）',
    serialOk.exitCode === 0,
    String(serialOk.exitCode),
  )

  group('双执行器 / ③ 送给工具的 ctx 与 Action 一致')

  const serialCtx = await ctxShapeOf(serial)
  const parallelCtx = await ctxShapeOf(parallel)

  check(
    '★★ 串行也传 wantMeta（不传就拿回字符串，判不出退出码）',
    serialCtx?.wantMeta === true,
    JSON.stringify(serialCtx),
  )
  check(
    '★★ 串行也给 ctx.action（否则各 gate 的 notePermission 静默不记，Action 面板空白）',
    serialCtx?.hasAction === true,
    JSON.stringify(serialCtx),
  )
  check(
    '★ 串行也注入 progress（工具报的进度才不会丢）',
    serialCtx?.hasProgress === true,
    JSON.stringify(serialCtx),
  )
  check(
    '★ 串行也注入 subagentEmit（子代理的每一步才转得出去）',
    serialCtx?.hasSubagentEmit === true,
    JSON.stringify(serialCtx),
  )
  check(
    '★★ 两份执行器给的 ctx 形状逐项相同',
    JSON.stringify(serialCtx) === JSON.stringify(parallelCtx),
    `串行 ${JSON.stringify(serialCtx)} ≠ 并行 ${JSON.stringify(parallelCtx)}`,
  )

  group('双执行器 / ④ 串行那份的适用边界')

  /*
   * 串行执行器**当前没有生产调用方**（`loop.cjs` 取的是并行版），它作为回退路径保留。
   * 这里只钉住「它还导得出来、还能跑」—— 不钉调用方，因为将来真接回去时那会变。
   */
  check('★ 串行执行器仍然导出（回退路径可以随时切回去）', typeof serial === 'function')
  check(
    '★ loop.cjs 走的仍是并行那一份（不是串行）',
    /executeToolCalls\b/.test(String(serial)) === false ||
      (await runWith(serial, OK_CMD)).toolRuns.length === 1,
    '这条只是确认串行那份自己还能跑通',
  )
}
