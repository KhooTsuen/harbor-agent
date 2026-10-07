import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   A 案（2026-10-07）：执行前的**计划复核**（`ask_user` 的 `gate: true` 那条路）

   用户报的场景：他说了「先分析不要动、我确认再执行」，模型分析完却直接开工 ——
   92 次文件移动只批了一回（审批粒度是「每次工具调用」，而「写脚本 + 跑命令」
   只批一次）。这条把「等明确同意」变成**执行前的一次往返**。

   ★ 与澄清（fail-open）**相反**，这条是 **fail-closed**：拿不到界面 / 用户离场
     → **停手**，不是放行。所以下面每条都往「保守」那一侧钉。

   实现住在 `core/tools/ask-user-gate.cjs`（从 ask_user.cjs 拆出来的，那边顶到 300 行）。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const clarify = require(join(ROOT, 'electron/core/clarify.cjs'))
  const askUser = require(join(ROOT, 'electron/core/tools/ask_user.cjs'))
  const gate = require(join(ROOT, 'electron/core/tools/ask-user-gate.cjs'))

  group('A / 执行前计划复核（gate：只认「明确点执行」，拿不到界面就停手）')

  const runGate = (reply, ctx = {}) =>
    askUser.run(
      { gate: true, question: '就按上面这个动手吗？' },
      { sessionId: 'selftest-gate', clarify: async () => reply, ...ctx },
    )

  const approve = await runGate({ approved: true, answers: [{ choice: gate.GATE_APPROVE_LABEL }] })
  check('★ 明确点「就按这个计划执行」→ 放行', /批准/.test(approve) && !/没有批准/.test(approve), approve.slice(0, 60))

  const pickStop = await runGate({ approved: true, answers: [{ choice: gate.GATE_DEFAULT_LABEL }] })
  check('★ 选「先别动」→ 停手', /没有批准/.test(pickStop) && /停手/.test(pickStop), pickStop.slice(0, 60))

  const freeform = await runGate({ approved: true, answers: [{ choice: '', text: '改一下第 3 步' }] })
  check('★ 自己写了话（没点执行）→ 也算没批准（保守）', /没有批准/.test(freeform))

  const skip = await runGate({ skipped: true })
  check('★ 跳过 → 没批准', /没有批准/.test(skip), skip.slice(0, 60))

  const leave = await runGate({ skipped: true, timeout: true, answers: [] })
  check(
    '★ 离场超时 → 没批准（与澄清相反：那边采纳默认，这里停手）',
    /没有批准/.test(leave) && !/批准了这个计划/.test(leave),
    leave.slice(0, 60),
  )

  const noChan = await askUser.run({ gate: true }, { sessionId: 'selftest-gate-none', clarify: null })
  check(
    '★ 拿不到界面 → 停手（fail-closed，不是放行）',
    /先不动手/.test(noChan) && /拿不到界面/.test(noChan),
    noChan.slice(0, 60),
  )

  const unmark = clarify.markUnattended('selftest-gate-unattended')
  const unattended = await askUser.run(
    { gate: true },
    { sessionId: 'selftest-gate-unattended', clarify: async () => ({}) },
  )
  unmark()
  check('无人值守 → 不动手（没人能确认计划）', /不动手/.test(unattended), unattended.slice(0, 60))

  /* 卡片形状：默认必须是「先别动」—— 离场也按它走，所以这条是安全底线 */
  let seen = null
  await askUser.run(
    { gate: true, question: '就按上面这个动手吗？' },
    {
      sessionId: 'selftest-gate-shape',
      clarify: async (input) => {
        seen = input.questions
        return { approved: true, answers: [{ choice: gate.GATE_APPROVE_LABEL }] }
      },
    },
  )
  check(
    '★ gate 的默认选项是「先别动」（离场也按它走）',
    seen?.[0]?.defaultValue === gate.GATE_DEFAULT_LABEL,
    JSON.stringify(seen?.[0]?.defaultValue),
  )
  check(
    'gate 问一行、两个选项、允许自由回答',
    seen?.length === 1 && seen[0].options.length === 2 && seen[0].allowFreeform === true,
  )
  /* 复用澄清那条 `chat:confirm` 往返 —— 不新增 IPC 通道、不 require electron */
  const gateSrc = require('node:fs').readFileSync(
    join(ROOT, 'electron/core/tools/ask-user-gate.cjs'),
    'utf8',
  )
  check('★ gate 不碰 IPC、不 require electron（复用现成往返）', !/ipcMain|require\('electron'\)/.test(gateSrc))

  /* ══ 2026-10-07 补：硬拦截（被拒之后，不能只靠「回话里写着停手」）══
     真实教训：真机走查逮到过「判定没批准之后 36 秒，模型照样去 read_file」。
     现在把结果记进 `core/gate-denied.cjs`，由工具咽喉 `tools/index.cjs` 拦下。 */
  const denied = require(join(ROOT, 'electron/core/gate-denied.cjs'))
  const askGate = (sessionId, reply) =>
    askUser.run(
      { gate: true, question: '就按上面这个动手吗？' },
      { sessionId, clarify: async () => reply },
    )

  denied.reset()
  await askGate('selftest-gate-deny', {
    approved: true,
    answers: [{ choice: gate.GATE_DEFAULT_LABEL }],
  })
  check('★ 选了「先别动」→ 这个会话被标记「已停手」', denied.stopped('selftest-gate-deny') === true)
  check('★ 别的会话不受波及', denied.stopped('selftest-gate-fresh') === false)

  await askGate('selftest-gate-ok', {
    approved: true,
    answers: [{ choice: gate.GATE_APPROVE_LABEL }],
  })
  check('★ 明确点执行 → 不标记（也把旧的清掉）', denied.stopped('selftest-gate-ok') === false)

  /* 工具咽喉真的拦得住：同一个会话里，execute 直接返回停手文本、不执行 */
  denied.reset()
  denied.deny('selftest-gate-block')
  const tools = require(join(ROOT, 'electron/core/tools/index.cjs'))
  const blocked = await tools.execute(
    'read_file',
    { path: 'package.json' },
    { sessionId: 'selftest-gate-block', workdir: ROOT },
  )
  check(
    '★ 被否决后，工具咽喉直接拦下（返回停手文本，不执行）',
    blocked === denied.STOP_TEXT,
    String(blocked).slice(0, 40),
  )
  denied.reset()
  const pass = await tools.execute(
    'read_file',
    { path: 'package.json' },
    { sessionId: 'selftest-gate-pass', workdir: ROOT },
  )
  check('放行的会话照常能读文件', !String(pass).startsWith('错误：'), String(pass).slice(0, 40))
  denied.reset()

  /* 接线（硬约束 9：契约从源码抠出来钉住）—— 咽喉与新轮清零各一处 */
  const idxSrc = require('node:fs').readFileSync(join(ROOT, 'electron/core/tools/index.cjs'), 'utf8')
  check(
    '★ tools/index.cjs 接了硬拦截',
    idxSrc.includes('gate-denied.cjs') && idxSrc.includes('gateDenied.stopped'),
  )
  const loopSrc = require('node:fs').readFileSync(join(ROOT, 'electron/core/loop-run.cjs'), 'utf8')
  check('★ 新一轮开头会清（loop-run.cjs 调 gateDenied.allow）', loopSrc.includes('gateDenied.allow'))
}
