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

  /* ── clarifyFirst：AG-053 的开关（批④ 才补上界面）── */
  group('开关接线 / clarifyFirst（开工前先问清楚）')
  check(
    '★ 开着：规则真的进了提示词',
    promptStack.workRules({ clarifyFirst: true }).includes('开工前先对齐'),
  )
  /* ★ 判据用整段规则的特征句（不是裸的 `ask_user`）—— 2026-10-07 新加的 PLAN_GATE_RULE
     也提到 ask_user，但它**不跟开关**（用户当场下的指令），用裸词判会误报。 */
  check(
    '★ 关掉：澄清那一条不再注入（其余照旧）',
    !promptStack.workRules({ clarifyFirst: false }).includes('开工前先对齐'),
  )
  check(
    '★ loop-prompt 按**配置**传进来（不是写死的）',
    read('electron/core/loop-prompt.cjs').includes('clarifyFirst: config.assistant?.clarifyFirst'),
  )
  check(
    '★ 设置界面有入口（以前有配置、没界面 —— 这一组就是为这种病建的）',
    read('src/components/settings/providers/AssistantSwitches.tsx').includes('clarifyFirst') &&
      read('src/components/settings/providers/AssistantSwitches.tsx').includes('开工前先问清楚'),
  )
  check(
    '★ 四个值的形状只有一处定义（渲染层只声明类型，不来第二套默认值）',
    read('src/types/models.ts').includes('clarifyTimeoutMs') &&
      read('electron/core/clarify-config.cjs').includes('clarifyTimeoutMs: 600000'),
  )

  /*
   * ── AG-053 批④：内核 .cjs 的「未定义标识符」闸门在位 ──
   *
   * 「搬走一个表、调用方还引用着旧名字」这种错，`tsc` 管不到（内核不参与）、
   * `node --check` 只管语法 —— 只能专门扫一遍。这个月踩了两次
   * （`chat.cjs` 的 `pendingConfirms`、`shell.cjs` 的 `inspectCommand`）。
   * 这里钉的是「闸门还在」：脚本在、verify 链里真的跑了它。
   */
  group('开关接线 / 约束机制：内核未定义标识符的闸门')
  check('★ 闸门脚本在', read('scripts/lint-kernel.mjs').includes('no-undef'))
  let pkg = {}
  try {
    pkg = JSON.parse(read('package.json'))
  } catch {
    pkg = {}
  }
  check(
    '★ verify 链里真的跑了它（写在脚本里但没人跑 = 没有闸门）',
    String(pkg.scripts?.verify ?? '').includes('lint:kernel'),
    String(pkg.scripts?.verify ?? '').slice(0, 80),
  )
  /*
   * 清单本身是「待修」不是「豁免」：**空着**，或者每条都写清「为什么先留着」。
   * 2026-10-02 修掉 `inspectCommand` 后清单转空，这条断言也从「必须有 why」
   * 改成「空的或每条都有 why」—— 钉的是不变式，不是那一刻的条数（钉条数就会
   * 每次修完都红一次，然后有人直接删断言）。
   */
  const lintSrc = read('scripts/lint-kernel.mjs')
  check(
    '★ 允许清单是「待修」不是「豁免」：空着，或者每条都写清 why',
    (lintSrc.includes('export const KNOWN = []') || lintSrc.includes('why:')) && lintSrc.includes('允许清单过期'),
  )

  /*
   * ── 上下文基准 vs 输出上限：这两件事拆开了（2026-10-04）──
   *
   * `loop-prompt` 传给 `contextBuilder.assemble()` 的那个 `maxTokens` 是**上下文**
   * 预算基准（字符 = ×3）。以前传的是设置页的 `assistant.maxTokens`（输出上限）——
   * 于是一个管「能写多长」的数字顺带决定了系统提示 / 项目文件 / 记忆能占多少。
   * 现在各归各，这一组只钉「谁读谁」。
   */
  group('开关接线 / 上下文基准与输出上限拆开')
  const loopPromptSrc = read('electron/core/loop-prompt.cjs')
  check(
    '★ 提示层读 context.baseTokens（不再读 assistant.maxTokens）',
    /^\s*maxTokens:\s*config\.context\?\.baseTokens,?\s*$/m.test(loopPromptSrc) &&
      !loopPromptSrc.includes('config.assistant.maxTokens'),
  )
  check(
    '★ 输出那条路没被跟着改（还是 assistant.maxTokens）',
    read('electron/core/loop-model.cjs').includes('config.assistant.maxTokens'),
  )
}
