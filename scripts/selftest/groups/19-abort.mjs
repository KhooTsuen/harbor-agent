import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-010：真正 Stop

   文档要求 Stop 完整取消 LLM → Loop → Tool → Shell/PTY → Search → MCP，
   并且「Stop 后 5 秒内不得继续出现新的 Agent Tool Call」。

   改造前实测到的两个真洞：

   ① `run_shell` 起了 `ping -n 30`，abort 之后**工具 29.6 秒才返回**
      —— `exec` 的 callback 要等输出管道关掉，`child.kill()` 杀不掉这个等待。
      用户点了停止还得瞪半分钟。修法：中断时用结算器**抢先** resolve。

   ② `loop-tools.cjs` 的 `for (const call of toolCalls)` 循环里**没有 abort 检查**
      —— 模型一轮给 3 个 tool_call，用户在第 1 个执行中点停止，第 2、3 个照跑。
      修法：每轮开头查，剩下的一律不发起（但补 tool 消息，否则下一轮请求 400）。

   另外两处一并收口：Windows 上 `child.kill()` 只杀 cmd.exe、孙子进程变孤儿
   （改走 `taskkill /T`）；MCP 的挂起请求在中断后要立刻撤掉，别等满超时。
   ══════════════════════════════════════════════════════════════ */

const abort = require(join(ROOT, 'electron/core/abort.cjs'))
const runShell = require(join(ROOT, 'electron/core/tools/run_shell.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('AG-010 · abort 共用零件')
  /* ── isAborted ────────────────────────────────────────── */
  check(
    'isAborted(undefined) 是 false（工具可以不带 signal 跑）',
    abort.isAborted(undefined) === false,
  )
  check('isAborted(null) 是 false', abort.isAborted(null) === false)

  const c1 = new AbortController()
  check('没断的 signal 是 false', abort.isAborted(c1.signal) === false)
  c1.abort()
  check('断了的 signal 是 true', abort.isAborted(c1.signal) === true)

  /* ── onAbort ──────────────────────────────────────────── */
  const c2 = new AbortController()
  let hits = 0
  const off = abort.onAbort(c2.signal, () => {
    hits += 1
  })
  c2.abort()
  check('abort 时回调被调一次', hits === 1)
  c2.abort()
  check('重复 abort 不会重复触发', hits === 1)

  const c3 = new AbortController()
  let wrong = 0
  const off3 = abort.onAbort(c3.signal, () => {
    wrong += 1
  })
  off3()
  c3.abort()
  check('摘掉之后不再触发（长会话不会堆监听器）', wrong === 0)

  const c4 = new AbortController()
  c4.abort()
  let immediate = 0
  abort.onAbort(c4.signal, () => {
    immediate += 1
  })
  check('已经断了的 signal：立刻执行一次', immediate === 1)

  check(
    '没有 signal 时返回一个可调用的摘除函数',
    typeof abort.onAbort(undefined, () => {}) === 'function',
  )

  /* ── createSettler ────────────────────────────────────── */
  const seen = []
  const settle = abort.createSettler((v) => seen.push(v))
  check('第一次结算返回 true', settle('第一次') === true)
  check('第二次结算返回 false', settle('第二次') === false)
  check('只有第一次的值生效', seen.length === 1 && seen[0] === '第一次')

  /* ── killTree 的边界 ──────────────────────────────────── */
  check(
    'killTree(null) 不抛（onAbort 可能早于 child 赋值）',
    (() => {
      try {
        abort.killTree(null)
        return true
      } catch {
        return false
      }
    })(),
  )

  /* ── ★ 真杀一个子进程：run_shell 必须「立刻」返回 ─────── */
  const c5 = new AbortController()
  const t0 = Date.now()
  /*
   * 用 12 秒的命令而不是 30 秒：正常路径 1 秒内就返回了（远低于断言的 5 秒），
   * 而**变异成「中断不结算」时要等命令自然跑完** —— 12 秒能跑完并判红，
   * 不至于让测试挂死大半分钟。
   */
  const p = runShell.run(
    { command: 'ping -n 12 127.0.0.1' },
    { workdir: ROOT, signal: c5.signal, shellTimeout: 60 },
  )
  await new Promise((r) => setTimeout(r, 600))
  c5.abort()
  const out = await p
  const ms = Date.now() - t0
  check(`被中断的命令立刻返回（实测 ${ms}ms，改造前是 29650ms）`, ms < 5000)
  check('返回里说清楚了是被中断', out.includes('已被用户中断'))

  /* ── 接线守卫 ─────────────────────────────────────────── */
  const shellSrc = readCore('electron/core/tools/run_shell.cjs')
  check('run_shell 用了结算器', shellSrc.includes('createSettler(resolve)'))
  check('run_shell 中断时走 killTree（杀进程树）', shellSrc.includes('killTree(child)'))
  check('run_shell 不再只用 child.kill()', shellSrc.includes('child.kill()') === false)
  check('run_shell 在正常完成时会摘掉监听', shellSrc.includes('off()'))

  const abortSrc = readCore('electron/core/abort.cjs')
  check('Windows 上走 taskkill /T', abortSrc.includes("'/T'"))
  check('killTree 故意异步（不卡主进程）', abortSrc.includes('unref()'))

  const toolsSrc = readCore('electron/core/loop-tools.cjs')
  check('loop-tools 每轮查 abort', toolsSrc.includes('if (isAborted(ctx.signal)) {'))
  check('未跑的工具不再发起', toolsSrc.includes('用户中断了这次执行，这个工具没有运行。'))
  check('未跑的工具也补 tool 消息（否则下一轮请求 400）', toolsSrc.includes("role: 'tool'"))

  const mcpSrc = readCore('electron/core/mcp-connection.cjs')
  check('MCP request 收 signal', mcpSrc.includes('timeoutMs = CALL_TIMEOUT_MS, signal'))
  check('MCP 挂起请求会被中断撤掉', mcpSrc.includes('onAbort(signal, () => settle(reject'))
  check('MCP 超时/中断/回包只有第一个生效', mcpSrc.includes('settled = true'))

  const mcpGate = readCore('electron/core/mcp.cjs')
  check(
    'mcp.callTool 透传 signal',
    mcpGate.includes('async function callTool(fullName, args, signal)'),
  )
  check(
    'tools/index 把 ctx.signal 带进 MCP',
    readCore('electron/core/tools/index.cjs').includes('ctx.signal'),
  )

  const loopSrc = readCore('electron/core/loop.cjs')
  check(
    'loop 每轮开头查 abort',
    loopSrc.includes("if (signal.aborted) throw new DOMException('aborted', 'AbortError')"),
  )
  check(
    'loop 在「模型流结束 → 开始跑工具」之间也查一次',
    /*
     * 这一段只能锚位置：真机抓到「停止后 2.7 秒仍发起新工具」就是漏在这。
     * 不能只断言文案存在（旁边还有一句一模一样的），所以看 life.mark('executing') 前面那几行。
     */
    (() => {
      const at = loopSrc.indexOf("life.mark('executing'")
      if (at < 0) return false
      return loopSrc.slice(Math.max(0, at - 400), at).includes('if (signal?.aborted)')
    })(),
  )
  check('loop 把 signal 放进 ctx', loopSrc.includes('signal,'))
  check('中断后相位进 cancelled', loopSrc.includes("life.mark(aborted ? 'cancelled' : 'failed'"))

  check(
    'search_web 把 signal 交给 fetch',
    readCore('electron/core/tools/search_web.cjs').includes('signal: ctx?.signal'),
  )

  /* ── LLM 流式：fetch 带了 signal 也拦不住已经在等的 reader.read() ── */
  const llmSrc = readCore('electron/core/llm.cjs')
  check('llm 流式循环里每圈查 abort', llmSrc.includes('if (signal?.aborted) {'))
  check(
    'llm 中断时主动 cancel 掉流（否则要等上游发下一个 chunk）',
    llmSrc.includes('void reader.cancel().catch(() => {})'),
  )
  check(
    'llm 收流结束后再查一次（cancel 会让 done 提前为真）',
    (() => {
      /*
       * 不能只断言文案存在 —— 变异可能只把 `if (signal?.aborted)` 改成 `if (false)`，
       * 字符串还在（AG-005 踩过的同一种坑）。所以取「收流结束」那一段再看：
       * 位置是生成 toolCalls 之前的那几十行。
       */
      const at = llmSrc.indexOf('const toolCalls = [...toolCallMap.entries()]')
      if (at < 0) return false
      return llmSrc.slice(Math.max(0, at - 260), at).includes('signal?.aborted')
    })(),
  )
  check('llm 正常结束时会摘掉监听', (llmSrc.match(/offAbort\(\)/g) ?? []).length >= 2)

  /* ── ★ 直接调 executeToolCalls：signal 已断时必须一个工具都不发起 ── */
  const loopTools = require(join(ROOT, 'electron/core/loop-tools.cjs'))
  const c6 = new AbortController()
  c6.abort()
  const ev = []
  const msgs = []
  const runs = []
  await loopTools.executeToolCalls({
    toolCalls: [
      { id: 'c1', name: 'run_shell', arguments: '{"command":"echo hi"}' },
      { id: 'c2', name: 'list_dir', arguments: '{"path":"."}' },
    ],
    ctx: { workdir: ROOT, signal: c6.signal },
    options: {},
    messages: msgs,
    toolRuns: runs,
    emit: (e) => ev.push(e),
    turn: 0,
  })
  check('signal 已断：一个工具也不发起', ev.length === 0)
  check('signal 已断：一个工具也没真的跑', runs.length === 0)
  check(
    'signal 已断：每个 tool_call 都补了 tool 消息',
    msgs.length === 2 && msgs.every((m) => m.role === 'tool'),
  )
}
