import { join, require, ROOT, SANDBOX, paths, writeFileSync, taskCore } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   P0-3 步骤 4：Permission 收到 Action 上（**只收结论，不改判断**）

   `tool-runner` 把组装好的 Action 挂成 `ctx.action` 交给执行层；各层门判完顺手把
   **结论**回填到 `Action.permission`（`layer → decision`）。判据与触发条件一个字没改
   （「这次不做什么」写在 `docs/安全模型.md` §8）。

   这一组钉三件事：
     ① **只加字段**：没挂 Action 时门照常工作、不崩（老路径一字不改）；
     ② 三层门（risk / scale / path）的结论真的写上了；
     ③ ★ **判断没变**：低风险不拦、critical 照拦、全盘递归照拦 —— 与回填前一致。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const action = require(join(ROOT, 'electron/core/action.cjs'))
  const risk = require(join(ROOT, 'electron/core/risk.cjs'))
  const riskGate = require(join(ROOT, 'electron/core/tools/risk-gate.cjs'))
  const scaleGate = require(join(ROOT, 'electron/core/tools/scale-gate.cjs'))
  const perm = require(join(ROOT, 'electron/core/tools/permission.cjs'))
  const noopAudit = () => {}

  group('P0-3·4 / notePermission：只写字段，空输入不崩，不改判断')
  check(
    '无 ctx 不抛',
    (() => {
      action.notePermission(null, 'risk', 'x')
      return true
    })(),
  )
  check(
    '无 action 不抛',
    (() => {
      action.notePermission({}, 'risk', 'x')
      return true
    })(),
  )
  const fresh = action.of({ name: 'run_shell', args: { command: 'dir' } })
  check('新组装的 Action 带 permission:null（形状稳）', fresh.permission === null)
  action.notePermission({ action: fresh }, 'risk', 'allowed')
  check('回填写上了', fresh.permission?.risk === 'allowed')
  action.notePermission({ action: fresh }, 'risk', 'blocked')
  check('同名再写覆盖（后判的说了算）', fresh.permission?.risk === 'blocked')

  group('P0-3·4 / risk-gate：结论回填 + 判断不变')
  const gateRisk = (cmd, verdict, confirm, a) =>
    riskGate.gate({
      name: 'run_shell',
      args: { command: cmd },
      ctx: { permission: 'ask', confirm, sessionId: 'p4-risk', workdir: SANDBOX, action: a },
      verdict,
      summary: 'x',
      startedAt: Date.now(),
      audit: noopAudit,
      impact: [],
    })

  const cmdLow = 'dir'
  const aLow = action.of({ name: 'run_shell', args: { command: cmdLow } })
  const rLow = await gateRisk(cmdLow, risk.classify(cmdLow), async () => true, aLow)
  check(
    '低风险：不弹卡、结论 allowed（与回填前一致）',
    rLow.asked !== true && aLow.permission?.risk === 'allowed',
    JSON.stringify(aLow.permission),
  )

  const cmdBad = 'rm -rf /'
  const aBad = action.of({ name: 'run_shell', args: { command: cmdBad } })
  const rBad = await gateRisk(cmdBad, risk.classify(cmdBad), async () => true, aBad)
  check('★ critical：照拦（blocked 非空）且结论 blocked', rBad.blocked != null && aBad.permission?.risk === 'blocked')

  let asked = false
  const aHigh = action.of({ name: 'run_shell', args: { command: 'whatever' } })
  const rHigh = await gateRisk(
    'whatever',
    { level: 'high', reasons: ['自检构造'] },
    async () => {
      asked = true
      return true
    },
    aHigh,
  )
  check('★ 高风险 + 需确认档：真弹了卡、结论 asked', asked && rHigh.asked === true && aHigh.permission?.risk === 'asked')

  const aDeny = action.of({ name: 'run_shell', args: { command: 'whatever' } })
  await gateRisk('whatever', { level: 'high', reasons: ['自检构造'] }, async () => false, aDeny)
  check('用户拒绝：结论 denied', aDeny.permission?.risk === 'denied')

  group('P0-3·4 / scale-gate：结论回填 + 判断不变')
  const gateScale = (cmd, a) =>
    scaleGate.gate({
      name: 'run_shell',
      args: { command: cmd },
      ctx: { sessionId: 'p4-scale', workdir: SANDBOX, action: a },
      audit: noopAudit,
    })

  const aOk = action.of({ name: 'run_shell', args: { command: 'dir' } })
  const rOk = await gateScale('dir', aOk)
  check('单条命令：不拦、结论 ok', rOk.level === 'ok' && aOk.permission?.scale === 'ok')

  const aNote = action.of({ name: 'run_shell', args: { command: 'npm test' } })
  const rNote = await gateScale('npm test', aNote)
  check('有界重活：只 note、不拦，结论 note', rNote.level === 'note' && aNote.permission?.scale === 'note')

  const aBig = action.of({ name: 'run_shell', args: { command: 'dir /s C:\\' } })
  const rBig = await gateScale('dir /s C:\\', aBig)
  check('★ 全盘递归：照拦（blocked）、结论 blocked', rBig.level === 'blocked' && aBig.permission?.scale === 'blocked')
  scaleGate.reset()

  group('P0-3·4 / path 层：越界文件的结论回填（批 / 拒 / 完全访问）')
  const outside = join(paths.DIRS.data, 'p4-outside.txt')
  writeFileSync(outside, 'x\n', 'utf8')
  /* 第一次调 run() 抛 PERMISSION_REQUIRED（越界），批准后重试第二次返回内容 */
  const makeTool = () => {
    let calls = 0
    return {
      name: 'read_file',
      run: async () => {
        calls += 1
        if (calls === 1) {
          const e = new Error(`拒绝访问 ${outside}`)
          e.code = 'PERMISSION_REQUIRED'
          e.target = outside
          e.reason = '在工作目录之外'
          throw e
        }
        return '内容'
      },
    }
  }
  const aGrant = action.of({ name: 'read_file', args: { path: outside } })
  await perm.runWithPathPermission(
    makeTool(),
    { path: outside },
    { permission: 'ask', confirm: async () => true, sessionId: 'p4-path', action: aGrant },
  )
  check('用户批了：结论 granted', aGrant.permission?.path === 'granted', JSON.stringify(aGrant.permission))

  const aDenyPath = action.of({ name: 'read_file', args: { path: outside } })
  await perm.runWithPathPermission(
    makeTool(),
    { path: outside },
    { permission: 'ask', confirm: async () => false, sessionId: 'p4-path', action: aDenyPath },
  )
  check('用户拒了：结论 denied', aDenyPath.permission?.path === 'denied')

  const aBypass = action.of({ name: 'read_file', args: { path: outside } })
  await perm.runWithPathPermission(
    makeTool(),
    { path: outside },
    { permission: 'full', confirm: async () => true, sessionId: 'p4-path', action: aBypass },
  )
  check('完全访问档：不问但留痕，结论 bypassed', aBypass.permission?.path === 'bypassed')

  group('P0-3·4 / 老路径：没挂 Action 时门照常工作（一字不改）')
  const rNoAction = await scaleGate.gate({
    name: 'run_shell',
    args: { command: 'dir /s C:\\' },
    ctx: { sessionId: 'p4-noaction', workdir: SANDBOX },
    audit: noopAudit,
  })
  check('没挂 Action：照常拦下、不崩（老路径一字不改）', rNoAction.level === 'blocked')
  scaleGate.reset()

  group('P0-3·4 / 落盘：permission 进 task.steps[].action（只加字段，白名单没松）')
  const t = taskCore.create({ goal: 'perm 落盘自检', sessionId: 'selftest-p4-store' })
  const aStore = action.of({ name: 'run_shell', args: { command: 'rm -rf /' } })
  action.notePermission({ action: aStore }, 'risk', 'blocked')
  taskCore.addStep(t.id, { tool: 'run_shell', ok: false, summary: 'x', action: aStore })
  const stored = (taskCore.get(t.id)?.steps ?? [])[0]
  check(
    '★ 落盘的 action 带 permission（risk:blocked 事后可查）',
    stored?.action?.permission?.risk === 'blocked',
    JSON.stringify(stored?.action?.permission ?? null),
  )
  check(
    '★ 仍然不含命令原文（落盘白名单没松口子）',
    stored?.action != null && !('command' in stored.action),
  )
}
