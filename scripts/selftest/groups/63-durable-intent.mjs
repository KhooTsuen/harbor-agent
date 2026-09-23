/**
 * 自检 / 工具执行可判定：`run_shell` 的「意图」与「结果」
 *
 * 为什么要这一组：Agent 循环原来是「执行 → 记录结果」，**没有「先记录意图」**。
 * 如果 Electron 在执行一条 shell 命令的**瞬间**崩掉，重启后恢复器无法判断
 * 那条命令到底执行了没有，只能重跑 —— 而重跑一条已经产生副作用的命令是危险的。
 *
 * 这一组锁四件事：
 *   ① 执行前：意图（含 `commandHash`）已经落盘，`completed === false`
 *   ② 执行后：`completed === true` + `ok` / `outcome` + 结果摘要（**成败都写**）
 *   ③ 顺序：源码里 `beginShell` 必须在 `runWithPathPermission` **之前**（铁律）
 *   ④ 没真正执行的（参数不合法 / 被拦下）**不留意图** —— 免得恢复器误判「动过」
 *
 * ⚠️ 本组**还没有**注册进 `scripts/selftest.mjs`（集成交付时统一加）。单独跑：
 *    node --input-type=module -e "await (await import('./scripts/selftest/groups/63-durable-intent.mjs')).run()"
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, ctx, join, mkdirSync, readFileSync, require, taskCore, tools } from '../env.mjs'

const intent = require(join(ROOT, 'electron/core/task-intent.cjs'))

/** 会失败但**能走到 run()** 的命令：只有空白，参数校验放行、`run()` 里 trim 完抛错 */
const BLANK = '   '

export async function run() {
  group('工具执行可判定 / run_shell 的意图与结果')

  /* 沙箱目录由 01 组建；本组单独跑（或顺序被调）时自己兜一下：cwd 不存在 exec 直接失败 */
  mkdirSync(SANDBOX, { recursive: true })

  const task = taskCore.create({ goal: '可判定执行自检', sessionId: 'selftest-ag-intent' })
  const own = { ...ctx, taskId: task.id }
  const steps = () => taskCore.get(task.id)?.steps ?? []
  const byHash = (command) =>
    steps().find((step) => step.intent?.commandHash === intent.commandHash(command))

  /* ══════════ ① 成功一条：意图与结果都落盘 ══════════ */
  const echo = await tools.execute('run_shell', { command: 'echo durable-intent-ok' }, own)
  check('命令跑成功了', echo.includes('durable-intent-ok'), echo.slice(0, 60))

  const okStep = byHash('echo durable-intent-ok')
  check('台账里多出一条带 intent 的 step', Boolean(okStep))
  check('intent.tool 记的是 run_shell', okStep?.intent?.tool === 'run_shell')
  check(
    'commandHash 是 sha256 前 12 位',
    /^[0-9a-f]{12}$/.test(String(okStep?.intent?.commandHash)),
    String(okStep?.intent?.commandHash),
  )
  check(
    'intent.startedAt 是数字（执行开始的时刻）',
    typeof okStep?.intent?.startedAt === 'number' && okStep.intent.startedAt > 0,
  )
  check('★ 执行后 completed === true', okStep?.completed === true)
  check('成功态：ok=true 且 outcome=ok', okStep?.ok === true && okStep?.outcome === 'ok')
  check(
    '摘要落的是**结果**，不是 pending 占位',
    Boolean(okStep?.summary) && okStep.summary !== intent.PENDING,
    String(okStep?.summary).slice(0, 60),
  )
  check('耗时记了下来（ms 是数字）', typeof okStep?.ms === 'number')
  check('不同命令的指纹不同', intent.commandHash('echo a') !== intent.commandHash('echo b'))

  /* ══════════ ② 崩在半路的那种状态：有意图、没结果 ══════════ */
  const pendingId = intent.beginShell(task.id, 'run_shell', { command: 'echo 崩在半路' })
  const readPending = () => taskCore.get(task.id)?.steps.find((step) => step.id === pendingId)

  check('只落了意图时 completed === false', readPending()?.completed === false, String(pendingId))
  check('★ 恢复器认得出「动过、但结果不明」', intent.isPending(readPending()) === true)
  check('pending 的摘要把「结果没落盘」写明了', readPending()?.summary === intent.PENDING)

  intent.markCompleted(task.id, pendingId, { ok: true, summary: '补上的结果', ms: 7 })
  check('补上结果后 completed === true', readPending()?.completed === true)
  check('补上结果后不再是 pending', intent.isPending(readPending()) === false)
  check('补上的摘要与耗时都在', readPending()?.summary === '补上的结果' && readPending()?.ms === 7)

  /* ══════════ ③ 失败一条：也要落 completed，而且必须是失败态 ══════════ */
  const bad = await tools.execute('run_shell', { command: BLANK }, own)
  check('空命令在执行期被拒（走的是 run_shell 自己抛错）', bad.startsWith('错误：'), bad.slice(0, 60))

  const badStep = byHash(BLANK)
  check('失败也落了 step（不是没记录）', Boolean(badStep))
  check(
    '★ 失败：completed=true，但 ok=false / outcome=failed',
    badStep?.completed === true && badStep?.ok === false && badStep?.outcome === 'failed',
    JSON.stringify({ c: badStep?.completed, ok: badStep?.ok, o: badStep?.outcome }),
  )
  check('失败摘要非空（错误信息落下来了）', Boolean(badStep?.summary), String(badStep?.summary))

  /* ══════════ ④ 没真正执行的：不许留意图 ══════════ */
  const invalid = await tools.execute('run_shell', { command: '' }, own)
  check(
    '空字符串在参数校验就被拦下',
    invalid.startsWith('错误：') && invalid.includes('参数不合法'),
    invalid.slice(0, 60),
  )
  check('★ 参数不合法的不留意图（本来就没执行）', byHash('') === undefined)

  const blocked = await tools.execute('run_shell', { command: 'format c:' }, own)
  check('危急命令被拦下', blocked.includes('拦下'), blocked.slice(0, 40))
  check('★ 被拦下的不留意图', byHash('format c:') === undefined)

  /* ══════════ ⑤ 老台账 / 拿不到任务：不炸、也不误判 ══════════ */
  check(
    '没有 intent 的老记录不算 pending（属于不可判定）',
    intent.isPending({ tool: 'read_file', ok: true, summary: '老记录' }) === false,
  )
  check(
    '拿不到任务时返回空 / null，不抛',
    intent.beginShell('task_不存在', 'run_shell', { command: 'echo x' }) === '' &&
      intent.markIntent('task_不存在', 's1', {}) === null,
  )
  check(
    '不是 run_shell 的工具不落意图（现在只覆盖 shell 这一条）',
    intent.beginShell(task.id, 'read_file', { path: 'a.txt' }) === '',
  )
  const noTask = await tools.execute('run_shell', { command: 'echo no-task-id' }, { ...ctx, taskId: '' })
  check('没有 taskId 时工具照常返回（别的自检组用的就是这种 ctx）', noTask.includes('no-task-id'))

  /* ══════════ ⑥ 顺序铁律：源码里意图必须写在执行之前 ══════════ */
  check(
    'task.cjs 把两个辅助函数转出来了（markIntent / markCompleted）',
    typeof taskCore.markIntent === 'function' && typeof taskCore.markCompleted === 'function',
  )
  const src = readFileSync(join(ROOT, 'electron/core/tools/index.cjs'), 'utf8')
  const iIntent = src.indexOf('taskIntent.beginShell(')
  const iRun = src.indexOf('await runWithPathPermission(')
  const iEnd = src.indexOf('taskIntent.endShell(')
  check('★ 意图写在 run() 之前（铁律，顺序颠倒就该报红）', iIntent > 0 && iIntent < iRun, `${iIntent} < ${iRun}`)
  check('结果写在 run() 之后', iEnd > iRun, `${iRun} < ${iEnd}`)

  taskCore.remove(task.id)
}
