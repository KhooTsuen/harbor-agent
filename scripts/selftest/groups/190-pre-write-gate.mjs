/**
 * 自检 / 190 —— 设置里那两个开关**真的会拦人**（B / C 硬化闸）
 *
 * 起因（用户 2026-11-01 原话）：「我想要点击之后真正的起作用，而不是靠提示句来约束」。
 *
 * 本组钉三件事，缺一件就会退回「只改提示词」的老样子：
 *
 *   ① **契约同源**：系统提示里列给模型的「停手说法的说法清单」，每一句内核都真的认
 *      （`user-constraints.cjs` 的 STOP_PHRASES）。2026-11-01 实测过：提示词列了 6 种，
 *      内核只认 1 种 —— 「等我确认」照着提示词说，写工具照样放行。
 *   ② **B 闸**：`planFirst` 开着 → 已经改过文件、计划还是空的 → 再改就被拦；
 *      有计划 / 开关关 / 已拦过一次 → 放行。
 *   ③ **C 闸**：`clarifyFirst` 开着 → 覆盖已存在的文件而本任务还没问过用户 → 拦；
 *      问过之后放行；**新建**文件不拦（那不是不可逆）。
 *
 * ⚠️ 判据一律用**模块本身**（`pre-write-gate.cjs` / `user-constraints.cjs`），
 *    不在这里重写一份 —— 重写就等于又开第二处真相源（硬约束 9）。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, disposeTasks, join, readFileSync, require, writeFileSync } from '../env.mjs'

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const U = require(join(ROOT, 'electron/core/user-constraints.cjs'))
const gate = require(join(ROOT, 'electron/core/tools/pre-write-gate.cjs'))

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 造一条 running 的任务；`writes` = 先在台账里记几次成功的写 */
function makeTask(goal, writes = 0) {
  const t = taskCore.create({ goal, sessionId: 'selftest-pre-write' })
  for (let i = 0; i < writes; i += 1) {
    taskCore.addStep(t.id, { tool: 'write_file', ok: true, summary: `改第 ${i + 1} 个文件` })
  }
  return t
}

export async function run() {
  const created = []
  const ctxOf = (taskId) => ({ workdir: SANDBOX, permission: 'full', taskId, sessionId: 'selftest-pre-write' })
  gate.reset()

  /* ─────────── ① 契约同源：提示词里列的说法，内核全都认 ─────────── */
  group('190 / ① 「停手」契约：提示词列几句，内核就得认几句')
  const promptGate = require(join(ROOT, 'electron/core/prompt-rules.cjs')).PLAN_GATE_RULE
  const listed = U.STOP_PHRASES.filter((one) => promptGate.includes(one))
  check(
    '★ 提示词里列出的说法来自 STOP_PHRASES（不是另抄一份）',
    listed.length === U.STOP_PHRASES.length,
    `提示词里只找到 ${listed.length}/${U.STOP_PHRASES.length}`,
  )
  const recognised = U.STOP_PHRASES.filter((one) => U.noWriteIn(`你先${one}，我先看看`) === true)
  check(
    '★ 每一句都真的会让本轮 allowWrite=false（照着提示词说就有效）',
    recognised.length === U.STOP_PHRASES.length,
    `只认 ${recognised.length}/${U.STOP_PHRASES.length}：${U.STOP_PHRASES.filter((o) => !recognised.includes(o)).join('、')}`,
  )
  check(
    '★ 反向：说「继续做」不该被当成停手（这道闸不能常态误拦）',
    U.noWriteIn('继续吧，把那个 bug 修一下') === false,
  )
  check(
    '★ 反向：指定了具体对象仍按老规矩放行（「别动那个文件」不是整轮锁死）',
    U.noWriteIn('别动那个文件，其他随便改') === false,
  )

  /* ─────────── ② B 闸：先给计划再动手 ─────────── */
  group('190 / ② planFirst 硬闸：改过文件、计划还空 → 第二次写被拦')
  const tPlan = makeTask('B 闸测试', 1)
  created.push(tPlan.id)
  const file = join(SANDBOX, 'gate-plan.txt')
  writeFileSync(file, 'x\n', 'utf8')
  const planSwitches = { planFirst: true, clarifyFirst: false }

  const blocked = gate.check({
    name: 'write_file',
    args: { path: 'gate-plan.txt', content: 'y\n' },
    ctx: ctxOf(tPlan.id),
    switches: planSwitches,
  })
  check('★ 有计划闸前提：确实拦下了', blocked.length > 0)
  check('★ 拦下的话术要求它先给 ```plan 块', blocked.includes('plan'))
  check('★ 话术带脱身出口（说清「只有一步」才放行）', blocked.includes('只有一步'))
  check(
    '★ 刹车：同一条任务只拦一次（第二次放行，不能把模型卡死）',
    gate.check({
      name: 'write_file',
      args: { path: 'gate-plan.txt', content: 'y\n' },
      ctx: ctxOf(tPlan.id),
      switches: planSwitches,
    }) === '',
  )

  gate.reset()
  const tWithPlan = makeTask('有计划就不拦', 1)
  created.push(tWithPlan.id)
  taskCore.setPlan?.(tWithPlan.id, ['[ ] 第一步'])
  /* setPlan 不一定有 —— 走 recordVersion 那条正规路径 */
  if (!(taskCore.get(tWithPlan.id)?.plan ?? []).length) {
    require(join(ROOT, 'electron/core/task-plan.cjs')).recordVersion(taskCore.get(tWithPlan.id), ['[ ] 第一步'])
  }
  check(
    '★ 有计划 → 放行',
    gate.check({
      name: 'write_file',
      args: { path: 'gate-plan.txt', content: 'z\n' },
      ctx: ctxOf(tWithPlan.id),
      switches: planSwitches,
    }) === '',
  )

  gate.reset()
  check(
    '★ 开关关着 → 回到老行为（不拦）',
    gate.check({
      name: 'write_file',
      args: { path: 'gate-plan.txt', content: 'w\n' },
      ctx: ctxOf(tPlan.id),
      switches: { planFirst: false, clarifyFirst: false },
    }) === '',
  )
  check(
    '★ 第一次写（台账里还没写过）→ 不拦',
    (() => {
      const fresh = makeTask('第一次写')
      created.push(fresh.id)
      return (
        gate.check({
          name: 'write_file',
          args: { path: 'gate-plan.txt', content: 'v\n' },
          ctx: ctxOf(fresh.id),
          switches: planSwitches,
        }) === ''
      )
    })(),
  )

  /* ─────────── ③ C 闸：覆盖已有文件之前必须先问过一次 ─────────── */
  group('190 / ③ clarifyFirst 硬闸：覆盖已有文件先问一声')
  gate.reset()
  const tAsk = makeTask('C 闸测试')
  created.push(tAsk.id)
  writeFileSync(join(SANDBOX, 'exists.txt'), '原来的内容\n', 'utf8')
  const askSwitches = { planFirst: false, clarifyFirst: true }

  const asked = gate.check({
    name: 'edit_file',
    args: { path: 'exists.txt', oldText: '原来的内容', newText: '新的内容' },
    ctx: ctxOf(tAsk.id),
    switches: askSwitches,
  })
  check('★ 覆盖已存在的文件 → 拦下', asked.length > 0)
  check('★ 话术要求先调 ask_user(gate: true)', asked.includes('ask_user') && asked.includes('gate'))
  check(
    '★ 刹车：同一任务不再第二次拦',
    gate.check({
      name: 'edit_file',
      args: { path: 'exists.txt', oldText: '原来的内容', newText: '新的内容' },
      ctx: ctxOf(tAsk.id),
      switches: askSwitches,
    }) === '',
  )

  gate.reset()
  const tAsked = makeTask('问过就放行')
  created.push(tAsked.id)
  gate.noteAsked(tAsked.id)
  check(
    '★ 问过用户之后 → 放行',
    gate.check({
      name: 'edit_file',
      args: { path: 'exists.txt', oldText: '原来的内容', newText: '新的内容' },
      ctx: ctxOf(tAsked.id),
      switches: askSwitches,
    }) === '',
  )

  gate.reset()
  const tNew = makeTask('新建文件不算不可逆')
  created.push(tNew.id)
  check(
    '★ 新建文件（目标还不存在）→ 不拦',
    gate.check({
      name: 'write_file',
      args: { path: 'brand-new.txt', content: 'hi\n' },
      ctx: ctxOf(tNew.id),
      switches: askSwitches,
    }) === '',
  )
  check(
    '★ 开关关着 → 回到老行为（不拦）',
    gate.check({
      name: 'edit_file',
      args: { path: 'exists.txt', oldText: '原来的内容', newText: '新的内容' },
      ctx: ctxOf(tNew.id),
      switches: { planFirst: false, clarifyFirst: false },
    }) === '',
  )

  /* ─────────── ④ 不该拦的地方 ─────────── */
  group('190 / ④ 不该拦的地方：没任务 / 不是 running / 只管两个写工具')
  gate.reset()
  check(
    '★ 没有 taskId（普通聊天）→ 不拦，行为与升级前一字不差',
    gate.check({ name: 'write_file', args: { path: 'exists.txt', content: 'x' }, ctx: { workdir: SANDBOX } }) === '',
  )
  const tPaused = makeTask('暂停的任务')
  created.push(tPaused.id)
  taskCore.update(tPaused.id, { status: 'paused' })
  check(
    '★ paused 的任务 → 不拦（用户主动停的，拦它没道理）',
    gate.check({
      name: 'edit_file',
      args: { path: 'exists.txt', oldText: 'a', newText: 'b' },
      ctx: ctxOf(tPaused.id),
      switches: askSwitches,
    }) === '',
  )
  check(
    '★ run_shell 不归它管（危险度归 risk-gate）',
    gate.check({ name: 'run_shell', args: { command: 'dir' }, ctx: ctxOf(tAsked.id), switches: askSwitches }) === '',
  )

  /* ─────────── ⑤ 接线：真的在咽喉上 ─────────── */
  group('190 / ⑤ 接线')
  check('★ tools/index.cjs 调了 preWriteGate.check', read('electron/core/tools/index.cjs').includes('preWriteGate.check('))
  check('★ ask_user 成功路径记了通行证（noteAsked）', read('electron/core/tools/ask_user.cjs').includes('preWriteGate.noteAsked('))
  check(
    '★ 拦下的调用会进审计（不是悄悄拒绝）',
    read('electron/core/tools/pre-write-gate.cjs').includes("'../config.cjs'"),
  )

  disposeTasks(created)
  gate.reset()
}
