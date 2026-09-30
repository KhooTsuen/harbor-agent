import { join, readFileSync, require, ROOT, disposeTasks } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   三个「死开关」的接线守卫

   2026-09-30 查出来的账：`assistant.planFirst` / `verifyAfterEdit` / `streamOutput`
   在配置里有默认值、有归一化，但**全仓库没有任何地方读它们** ——
   也就是「有配置、没界面、也没行为」。设置界面里同样一个入口都没有。

   接上之后，这一组只回答一个问题：**那段代码有没有被人调用**。
   行为本身由别的组测（`06-prompt-state` 测提示词内容、`44-steering` 测门禁逻辑、
   `messageRounds.test.tsx` 测渲染）。

   为什么要单独钉「接线」：本项目真发生过「函数写好了、没人调」——
   `tsc` 全绿、lint 全过、测试全过，功能整个不在（见 docs/踩坑记录.md 坑 #2）。
   ══════════════════════════════════════════════════════════════ */

const promptStack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
const taskSteering = require(join(ROOT, 'electron/core/task-steering.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  /* ── planFirst：落点在系统提示的「先给计划」那一条 ── */
  group('开关接线 / planFirst')
  const planOn = promptStack.workRules({ planFirst: true })
  const planOff = promptStack.workRules({ planFirst: false })
  check('★ 开着：真的要求先给 ```plan 块', planOn.includes('```plan 块'))
  check('★ 关掉：不再要求', !planOff.includes('```plan 块'))
  check(
    '其余规矩一条不少（关的是那一条，不是整层）',
    planOff.includes('先看再改') && planOff.includes('不要编'),
  )
  check(
    '★ loop-prompt 按**配置**传进来（不是写死的）',
    read('electron/core/loop-prompt.cjs').includes('planFirst: config.assistant?.planFirst'),
  )

  /* ── verifyAfterEdit：落点是收尾门禁 ── */
  group('开关接线 / verifyAfterEdit')
  check('★ 门禁函数存在且导出了', typeof taskSteering.shouldVerify === 'function')
  check(
    '★ loop.cjs 真的调它，而且把配置传进去了',
    read('electron/core/loop.cjs').includes('taskContext.completionGate(') &&
      read('electron/core/loop.cjs').includes('verifyAfterEdit: config.assistant?.verifyAfterEdit'),
  )
  check(
    '★ 两道门禁是**一起**调用的（计划 + 验证），而且账分开存',
    typeof taskSteering.completionGate === 'function' &&
      read('electron/core/task-steering.cjs').includes('const planSeen = seen.plan ?? {}') &&
      read('electron/core/task-steering.cjs').includes('const verifySeen = seen.verify ?? {}'),
  )
  const steerSrc = read('electron/core/task-steering.cjs')
  check(
    '★ 判据只认台账上的事实（写类工具 + run_shell），不猜「跑的是不是测试」',
    steerSrc.includes("new Set(['write_file', 'edit_file'])") && steerSrc.includes("=== 'run_shell'"),
  )

  group('开关接线 / verifyAfterEdit 的判定')
  const task = taskCore.create({ goal: '接线守卫用', sessionId: 'selftest-switch' })
  check(
    '还没动过文件 → 不拦',
    taskSteering.shouldVerify({ taskId: task.id, seen: {} }).continue === false,
  )

  taskCore.addStep(task.id, { tool: 'edit_file', ok: true, summary: '改了 a.ts' })
  const blocked = taskSteering.shouldVerify({ taskId: task.id, seen: {} })
  check(
    '★ 改了文件、还没跑过命令 → 顶回去',
    blocked.continue === true && blocked.message.includes('没跑过任何命令'),
  )

  taskCore.addStep(task.id, { tool: 'run_shell', ok: true, summary: 'npm test' })
  check(
    '★ 跑过命令之后 → 不再拦（只认「跑没跑」，不猜跑得对不对）',
    taskSteering.shouldVerify({ taskId: task.id, seen: {} }).continue === false,
  )

  taskCore.addStep(task.id, { tool: 'edit_file', ok: true, summary: '又改了' })
  const again = taskSteering.shouldVerify({ taskId: task.id, seen: {} })
  check('★ 又改了文件 → 又要验证', again.continue === true)
  check(
    '★ 同一个进度只顶一次（顶过没反应就放行，别把人卡死）',
    taskSteering.shouldVerify({ taskId: task.id, seen: again.seen }).continue === false,
  )
  check(
    '★ 开关关掉 → 一句话都不说',
    taskSteering.shouldVerify({ taskId: task.id, verifyAfterEdit: false, seen: {} }).continue ===
      false,
  )

  taskCore.finish(task.id, { status: 'completed', result: '做完了' })
  check(
    '已完成的任务不再拦（不是 running 就不管）',
    taskSteering.shouldVerify({ taskId: task.id, seen: {} }).continue === false,
  )

  /* ★ 2026-09-30 CI 上真红过这一项：判据原来拿 `at`（墙钟）比大小，而「写 / 跑 / 再写」
     三笔账在快机器上能挤进**同一毫秒**，于是 `run_shell.at >= lastEdit.at` 为真，
     门禁以为「改完验证过了」。本地三笔账差 2ms，从没撞上 —— 所以这里把时钟冻住复现。 */
  const sameMs = taskCore.create({ goal: '三笔账挤在同一毫秒', sessionId: 'selftest-switch' })
  const realNow = Date.now
  const frozen = realNow()
  Date.now = () => frozen
  taskCore.addStep(sameMs.id, { tool: 'edit_file', ok: true, summary: '改了 a.ts' })
  taskCore.addStep(sameMs.id, { tool: 'run_shell', ok: true, summary: 'npm test' })
  taskCore.addStep(sameMs.id, { tool: 'edit_file', ok: true, summary: '又改了' })
  Date.now = realNow
  check(
    '★ 三笔账落在同一毫秒里也认得出先后（判据只认台账顺序，不认墙钟）',
    taskSteering.shouldVerify({ taskId: sameMs.id, seen: {} }).continue === true,
  )

  /* 建过的测试任务删干净：以前这一组不留人，`data/tasks/` 里堆了几百条 selftest* */
  disposeTasks([task.id, sameMs.id])

  /* ── streamOutput：落点在渲染层 ── */
  group('开关接线 / streamOutput')
  check(
    '★ 渲染层真的读了配置',
    read('src/components/chat/MessageItem.tsx').includes(
      's.config?.assistant.streamOutput !== false',
    ),
  )
  check(
    '★ 时间线真的会用它（不是读了就扔）',
    read('src/components/chat/message/MessageRounds.tsx').includes('hideStreamingContent'),
  )
  check(
    '★ 设置界面有入口（能关也能再打开）',
    read('src/components/settings/providers/AssistantSwitches.tsx').includes('streamOutput') &&
      read('src/components/settings/ProviderPanel.tsx').includes('<AssistantSwitches />'),
  )
}
