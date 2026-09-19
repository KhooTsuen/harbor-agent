import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-027：Chat 与 Task 分离 —— 任务要有**自己的名字**

   文档那张图说得很清楚：

     聊天：    「继续优化 Agent」
     后台任务：  Optimize Agent Execution
                 ✓ Analyze  ✓ Inspect  ● Refactor  ○ Test

   以前 `task.title` **就是用户那句话**（`create({ title: goal.slice(0,60) })`，
   或者 `title || goal`）—— 于是任务台账、未完成任务横幅、任务列表里显示的
   全是「继续优化 Agent」这种聊天句子。任务没有自己的身份，Chat 与 Task 没分开。

   现在的规矩：
     · 名字由模型在 ```plan 块的第一行给（`# 优化 Agent 启动`）——它最清楚这活叫什么
     · 模型没给（一问一答、老任务）→ `deriveTitle` 从聊天句里**提炼**，不照抄
     · 名字**只在任务还没有自己的名字时**才采纳（模型每轮重发计划块，措辞一变
       就会改名，界面上会来回跳）
   ══════════════════════════════════════════════════════════════ */

const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskPlan = require(join(ROOT, 'electron/core/task-plan.cjs'))
const taskContext = require(join(ROOT, 'electron/core/task-context.cjs'))
const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))

export async function run() {
  const created = []

  function newTask(goal = '把配置读一遍') {
    const task = taskCore.create({ goal, sessionId: 'selftest-taskname' })
    created.push(task.id)
    return task
  }

  /* ── ① 计划块里读得出任务名 ───────────────────────────── */
  group('任务名 / 从计划块里读')
  const block = taskPlan.parsePlanBlock(
    '```plan\n# Optimize Agent Execution\n- [x] Analyze\n- [x] Inspect\n- [ ] Refactor\n- [ ] Test\n```',
  )
  check('★ 第一行 `# 名字` 成了任务名', block.title === 'Optimize Agent Execution')
  check(
    '★ 任务名不算一步',
    block.steps.join('|') === '[x] Analyze|[x] Inspect|[ ] Refactor|[ ] Test',
  )
  check('步骤数是 4', block.steps.length === 4)

  const named = taskPlan.parsePlanBlock('```plan\n任务名：清理构建脚本\n1. 读\n2. 改\n```')
  check('`任务名：xxx` 写法也认', named.title === '清理构建脚本')
  check('编号步骤照旧解析', named.steps.join('|') === '读|改')

  const enName = taskPlan.parsePlanBlock('```plan\nname: Tidy up build scripts\n- a\n```')
  check('`name: xxx` 写法也认', enName.title === 'Tidy up build scripts')

  /* ── ② 没有名字 / 兼容老行为 ──────────────────────────── */
  group('任务名 / 没有名字时')
  const plain = taskPlan.parsePlanBlock('```plan\n- 一\n- 二\n```')
  check('没给名字 → title 为空', plain.title === '')
  check('没给名字 → 步骤不受影响', plain.steps.join('|') === '一|二')

  check(
    'parsePlan 老接口行为不变',
    taskCore.parsePlan('```plan\n- 一\n- 二\n```').join('|') === '一|二',
  )
  check(
    '★ parsePlan 不带出标题行（老调用方拿到的是纯步骤）',
    taskCore.parsePlan('```plan\n# 名字\n- 一\n```').join('|') === '一',
  )
  check('没有计划块 → 空', taskPlan.parsePlanBlock('就是一段普通回答').steps.length === 0)
  check(
    '★ 只有第一行才可能是名字（步骤里的 # 不当名字）',
    taskPlan.parsePlanBlock('```plan\n- 第一步\n# 这行不是名字\n```').title === '',
  )

  /* ── ③ 名字归一化 ─────────────────────────────────────── */
  group('任务名 / 归一化')
  check('压掉多余空白', taskPlan.normalizeTitle('  优化   启动  ') === '优化 启动')
  check('去掉引号', taskPlan.normalizeTitle('「优化启动」') === '优化启动')
  check('去掉尾部标点', taskPlan.normalizeTitle('优化启动。') === '优化启动')
  check('超 60 字截断', taskPlan.normalizeTitle('x'.repeat(80)).length === 60)
  const single = taskPlan.normalizeTitle('第一行\n第二行')
  check('折成一行（换行变空格）', single === '第一行 第二行')

  /* ── ④ 从聊天句里提炼（兜底）──────────────────────────── */
  group('任务名 / 从聊天句提炼')
  check('★ 剥掉「继续」', taskPlan.deriveTitle('继续优化 Agent') === '优化 Agent')
  check('剥掉「帮我」', taskPlan.deriveTitle('帮我改一下登录页') === '改一下登录页')
  check('连续剥三层', taskPlan.deriveTitle('请帮我修复这个 bug') === '修复这个 bug')
  check('取第一句', taskPlan.deriveTitle('先读配置。然后改代码') === '先读配置')
  check('空进出空', taskPlan.deriveTitle('') === '')
  check('超 40 字截断', taskPlan.deriveTitle(`优化${'很长的描述'.repeat(20)}`).length === 40)

  /* ── ⑤ 建任务时名字是提炼出来的，不是聊天原句 ─────────── */
  group('任务名 / 建任务')
  const t1 = newTask('继续优化 Agent 的启动速度')
  check('★ 标题不是聊天原句', t1.title !== '继续优化 Agent 的启动速度')
  check('★ 标题 = 提炼后的动作名', t1.title === '优化 Agent 的启动速度')
  check('goal 仍是原话（需求不能丢）', t1.goal === '继续优化 Agent 的启动速度')

  const tEmpty = newTask('')
  check('goal 为空 → 未命名任务', tEmpty.title === '未命名任务')

  /*
   * 全是口语前缀的 goal（「继续」「接着做」）—— 剥完剩空串。
   * 这里踩过一个真坑：create 兜底成「未命名任务」，但采纳判断算出的是 ''，
   * 两边对不上 → 模型给的名字**永远**被当成「它已经有名字了」拒掉。
   */
  group('任务名 / 口语 goal 也要能改名')
  check('fallbackTitle(继续) = 未命名任务', taskPlan.fallbackTitle('继续') === '未命名任务')
  check('deriveTitle(继续) = 空（所以要兜底）', taskPlan.deriveTitle('继续') === '')
  const tFiller = newTask('继续')
  const vFiller = taskCore.setPlan(tFiller.id, ['[ ] A', '[ ] B'], { title: '读配置并核对' })
  check('★ 口语 goal 的任务能采纳模型给的名', taskCore.get(tFiller.id).title === '读配置并核对')
  check('返回的名字也对了', vFiller.title === '读配置并核对')
  check('采纳过就不再改', taskCore.setPlan(tFiller.id, ['[x] A', '[ ] B'], { title: '别的名' }).title === '读配置并核对')

  /* ── ⑥ 模型给了名字就采纳（只采纳一次）────────────────── */
  group('任务名 / 采纳模型给的名字')
  const t2 = newTask('继续优化 Agent')
  const v1 = taskCore.setPlan(t2.id, ['[ ] Analyze', '[ ] Refactor'], {
    title: 'Optimize Agent Execution',
  })
  check('★ 采纳了计划块里的名字', taskCore.get(t2.id).title === 'Optimize Agent Execution')
  check('setPlan 把名字带回来（事件要用）', v1.title === 'Optimize Agent Execution')

  /* 第二版计划名字改了 —— 定下来的名字不该跟着跳 */
  taskCore.setPlan(t2.id, ['[x] Analyze', '[ ] Refactor'], { title: '另一种叫法' })
  check('★ 已有自己的名字 → 不跟着改名', taskCore.get(t2.id).title === 'Optimize Agent Execution')

  /* 没带名字的 setPlan 不该把名字弄丢 */
  taskCore.setPlan(t2.id, ['[x] Analyze', '[x] Refactor', '[ ] Test'])
  check('不带名字的计划 → 名字保持', taskCore.get(t2.id).title === 'Optimize Agent Execution')

  /* ── ⑦ capturePlan 把名字一起交出来 ───────────────────── */
  group('任务名 / capturePlan')
  const t3 = newTask('看看构建脚本')
  const captured = taskContext.capturePlan({
    taskId: t3.id,
    content: '```plan\n# Tidy build scripts\n- [ ] 读\n- [ ] 改\n```',
  })
  check('★ 捕获结果里带 title', captured && captured.title === 'Tidy build scripts')
  check('捕获结果里带 plan', captured.plan.join('|') === '[ ] 读|[ ] 改')
  check('任务台账已改名', taskCore.get(t3.id).title === 'Tidy build scripts')

  const again = taskContext.capturePlan({
    taskId: t3.id,
    content: '```plan\n# Tidy build scripts\n- [ ] 读\n- [ ] 改\n```',
  })
  check('同一份计划再捕获仍是 null（AG-004 行为没变）', again === null)

  /* ── ⑧ 老任务迁移不受影响 ─────────────────────────────── */
  group('任务名 / 老任务')
  const legacy = taskPlan.migrate({ id: 'task_old', title: '老任务', plan: ['a'], goal: '老任务' })
  check('老任务的标题原样保留', legacy.title === '老任务')
  const vOld = taskPlan.recordVersion(
    { id: 'x', title: '继续优化 Agent', goal: '继续优化 Agent' },
    ['[ ] a'],
  )
  check('★ 老任务（名字还是兜底名）也接受改名', vOld.title === '继续优化 Agent')

  /* ── ⑨ 接线守卫 ───────────────────────────────────────── */
  group('任务名 / 接线守卫')
  const hintSrc = readFileSync(join(ROOT, 'electron/core/task-hint.cjs'), 'utf8')
  check(
    '★ 提示词告诉模型第一行写任务名',
    hintSrc.includes('第一行') && hintSrc.includes('任务名'),
  )
  const promptSrc = readFileSync(join(ROOT, 'electron/core/task-context.cjs'), 'utf8')
  check('★ 台账注入用 parsePlanBlock', promptSrc.includes('parsePlanBlock'))
  check('★ capturePlan 把 title 交给 setPlan', promptSrc.includes('title: block.title'))
  check(
    '★ 台账与第一轮共用同一份格式说明（不是各写一遍）',
    promptSrc.includes('taskHint.ledgerFormatLine()') &&
      !promptSrc.includes('块的**第一行**写任务名'),
  )

  /*
   * 新活的第一轮：没有未完成任务时，注入内容必须把「这次这句话」带上。
   * 真机实测（deepseek-flash）：只在系统提示的通用条目里写规矩，模型不写
   * 计划块；带了本轮请求才写。这条就是那个入口。
   *
   * 这里直接测文案函数（不走 buildTaskState）—— 后者看的是**全局**未完成任务，
   * 本组前面已经建了好几条，环境不干净。接线由下面的守卫钉。
   */
  const hint = require(join(ROOT, 'electron/core/task-hint.cjs'))
  const fresh = hint.freshRequest('把两个脚本对比一遍')
  check('★ 第一轮带上用户那句话', fresh.includes('把两个脚本对比一遍'))
  check('★ 第一轮要 plan 块', fresh.includes('```plan'))
  check('★ 第一轮要任务名', fresh.includes('第一行写任务名'))
  check('没头没尾不注入', hint.freshRequest('') === '' && hint.freshRequest(undefined) === '')
  check(
    '★ 没任务时走的是这条路（不是返回空）',
    promptSrc.includes('taskHint.freshRequest(userText)'),
  )

  const resumeSrc = readFileSync(join(ROOT, 'electron/core/task-resume.cjs'), 'utf8')
  check('★ 起运行的那条路不再拿聊天句当标题', !/title:\s*goal/.test(resumeSrc))

  const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
  check(
    'loop 的 plan 事件把捕获结果整体展开（title 会跟着走）',
    /emit\(\{\s*type: 'plan',\s*\.\.\.captured/.test(loopSrc),
  )

  check('task-resume 仍能起任务（导出没坏）', typeof taskResume.openForRun === 'function')

  /* ── 收尾 ─────────────────────────────────────────────── */
  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
