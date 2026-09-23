/**
 * 任务的诊断（AG-035）
 *
 * 「这条任务为什么停了、我现在该干什么」—— 答案全在台账里
 * （计划 / 状态 / 步骤 / 改动 / 工具结果 / 授权 / 模型），
 * 但摊开是几百行 JSON。这里把它读成一段**人能读的**报告，三种用途：
 *
 *   · Diagnose —— 卡住时一眼看出卡在哪
 *   · 复制出去 —— 贴给别人（或者另一个会话说「接着这个做」）
 *   · 复盘 —— 完事的任务留一份「当时到底怎么做的」
 *
 * ── 为什么放在内核 ──
 * 和 AG-029/034 同一条理由：判读要用真数据（命令退出码、被拒的授权、
 * 模型换过几次），这些只有台账有。渲染层只负责把它显示出来。
 *
 * ── 一条规矩 ──
 * **只写台账里读得到的事实**，不推测。读不出来就写「没有记录」——
 * 诊断报告一旦开始脑补，就没法用来判断了。
 */

const taskOutcome = require('./task-outcome.cjs')
const consistency = require('./task-consistency.cjs')

/** 只留文件名 —— 报告是给人扫的，整条路径太长 */
function short(file) {
  return String(file ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-2)
    .join('/')
}

const STATUS_TEXT = {
  running: '进行中',
  waiting_user: '等你确认',
  paused: '停住了（可以接着做）',
  completed: '已完成',
  failed: '失败了',
  cancelled: '被放弃',
}

const isDone = (line) => /^\[[xX]\]/.test(String(line).trim())

/** 计划里第一条没打勾的（台账里的 nextAction 缺了就现算一遍） */
function nextStepOf(task) {
  if (task?.nextAction) return String(task.nextAction)
  for (const line of task?.plan ?? []) {
    const text = String(line).trim()
    if (text.startsWith('[') && !isDone(text)) return text.replace(/^\[\s*\]\s*/, '')
  }
  return ''
}

/** 授权记录：批了几次、拒了几次、哪些是「窗口内自动放行」的 */
function permissionLines(task) {
  const list = Array.isArray(task.permissions) ? task.permissions : []
  if (list.length === 0) return ['（没有记录 —— 这次没遇到需要你确认的操作）']

  const denied = list.filter((item) => item.approved === false)
  const auto = list.filter((item) => item.auto === true)
  const manual = list.length - denied.length - auto.length
  const kinds = [...new Set(list.map((item) => String(item.kind ?? '?')))].join('、')
  const out = [
    `类型：${kinds} —— 手动批准 ${manual} 次，自动放行 ${auto.length} 次，被拒 ${denied.length} 次`,
  ]
  for (const item of denied.slice(-3)) {
    out.push(`· 被拒：${item.kind ?? '?'} ${short(item.name)}`)
  }
  return out
}

/**
 * 结论：一句话说清「现在是什么状况」。
 *
 * 顺序是有讲究的（第一版把「测试没过」排在「停住了」前面，真跑测试时
 * 结论就变成「先看那条结果」，把「停在哪一步」这句更该看的话挤掉了）：
 *   ① 出错停下  ② 停下等人/暂停（**先说停在哪**）  ③ 测试没过
 *   ④ 已完成    ⑤ 还在跑
 * 测试结果不会因此丢 —— 下面「测试：…」那一行照写。
 */
function conclusionOf(task, outcome, next) {
  if (task.status === 'failed') {
    const last = (task.errors ?? []).at(-1)
    return `上一轮出错了：${last?.message ?? '没有记录原因'}`
  }
  if (task.status === 'paused' || task.status === 'waiting_user') {
    return next
      ? `停在「${next}」—— 可以接着做`
      : '停住了，却没有记下下一步 —— 接着做时得先告诉它目标'
  }
  if (outcome.tests === 'failed') return '最近一次测试没过 —— 先看那条结果，再动手改'
  if (task.status === 'completed') {
    return outcome.tests === 'passed' ? '做完了，测试也过了' : '做完了（这次没有测试记录）'
  }
  return '还在跑'
}

/**
 * 生成一份报告。
 *
 * @param {object} task 任务台账里那条（`task.cjs` 的 get / list 返回的对象）
 * @returns {{ title: string, status: string, conclusion: string, text: string }}
 */
function diagnose(task) {
  if (!task) return { title: '', status: '', conclusion: '这条任务不在了。', text: '' }

  const outcome = taskOutcome.outcomeOf(task)
  const steps = Array.isArray(task.steps) ? task.steps : []
  const failedSteps = steps.filter((step) => step.ok === false)
  const files = Array.isArray(task.changedFiles) ? task.changedFiles : []
  const commands = Array.isArray(task.commands) ? task.commands : []
  const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints : []
  const models = (Array.isArray(task.models) ? task.models : []).filter(Boolean)
  const plan = Array.isArray(task.plan) ? task.plan : []
  const next = nextStepOf(task)
  const out = []

  out.push(`任务：${task.title || task.goal || '(没有标题)'}`)
  out.push(
    `状态：${STATUS_TEXT[task.status] ?? task.status}${failedSteps.length ? `（${failedSteps.length} 步出错）` : ''}`,
  )
  out.push(`结论：${conclusionOf(task, outcome, next)}`)
  out.push(
    `模型：${task.model || models.at(-1) || '没有记录'}${
      models.length > 1 ? `（换过 ${models.length - 1} 次：${models.join(' → ')}）` : ''
    }`,
  )
  /*
   * ②-1：提示词版本。
   * 只在这一版**记过**的时候显示 —— 旧任务没这个字段，写「没有记录」是噪音。
   * 它的用处：同一个任务前后表现不一样时，先看是不是换了提示词版本。
   */
  if (task.promptVersion) out.push(`提示词：${task.promptVersion}`)
  /*
   * ②-2：这份预算哪来的。
   * 用户看到「轮数上限 60」而自己不记得设过 —— 这里得答得上来。
   */
  if (task.preset) {
    const label = require('./task-presets.cjs').TYPES[task.preset]?.label ?? task.preset
    out.push(`预算来源：按「${label}」这类任务的推荐值（可在任务卡片上改）`)
  }
  if (task.workdir) out.push(`工作目录：${task.workdir}`)

  if (plan.length > 0) {
    const done = plan.filter(isDone).length
    out.push(`计划：${plan.length} 步，完成 ${done}${next ? `，下一步「${next}」` : ''}`)
  } else {
    out.push('计划：没有（这轮没写计划块）')
  }

  out.push(
    `步骤：${steps.length} 次工具调用${failedSteps.length ? `，${failedSteps.length} 次失败` : ''}`,
  )
  for (const step of failedSteps.slice(-3)) {
    out.push(
      `· 失败：${step.tool} ${String(step.summary ?? '')
        .split('\n')[0]
        .slice(0, 80)}`,
    )
  }

  out.push(`改动：${files.length} 个文件${task.changeSetId ? '（可整批撤销）' : ''}`)
  for (const item of files.slice(-5)) out.push(`· ${short(item.path)}`)

  if (commands.length > 0) {
    const last = commands.at(-1)
    const exit =
      last.exitOk === false ? '退出码非 0' : last.exitOk === true ? '退出码 0' : '结果没读出来'
    out.push(
      `命令：跑过 ${commands.length} 条，最近一条 ${String(last.command).slice(0, 80)}（${exit}）`,
    )
    if (outcome.tests !== 'none') {
      const verdict =
        outcome.tests === 'passed'
          ? '通过'
          : outcome.tests === 'failed'
            ? '没过'
            : '跑过，结果没读出来'
      out.push(`测试：${verdict} —— ${outcome.testCommand || '（没记命令）'}`)
    }
  } else {
    out.push('命令：没有跑过')
  }

  out.push('授权：')
  for (const line of permissionLines(task)) out.push(`  ${line}`)

  out.push(
    `检查点：${checkpoints.length} 个${checkpoints.length ? `（最近：${checkpoints.at(-1).label}）` : ''}`,
  )
  out.push(`恢复过：${task.resumeCount ?? 0} 次`)

  /*
   * ②-3：同一件事跑过第二遍吗 —— 有就把两份事实并排摆出来。
   *
   * 只回答「差在哪」，**不判断谁对**：差异大不等于有问题（第二次可能本来就做得更细）。
   * 所以措辞是「对不上」，不是「有问题」。读不出可比对象就一个字都不写。
   */
  const prior = findPriorRun(task)
  if (prior) {
    const cmp = consistency.compare(prior.task, task, prior.score)
    out.push('')
    out.push(`这件事之前跑过一次（${consistency.whenAgo(prior.task.createdAt)}）：`)
    if (cmp.divergent) {
      for (const note of cmp.notes) out.push(`· ${note}`)
    } else {
      out.push('· 两次的结论、测试结果、改动范围都对得上')
    }
  }

  return {
    title: task.title || task.goal || '',
    status: task.status,
    conclusion: conclusionOf(task, outcome, next),
    text: out.join('\n'),
  }
}

/** 找同一会话里跟这条最像的旧任务；找不到返回 null（找不到就别说） */
function findPriorRun(task) {
  const sessionId = String(task?.sessionId ?? '')
  if (!sessionId) return null
  try {
    /* 惰性 require：task.cjs 不引这边，但少一层耦合总是好的 */
    const tasks = require('./task.cjs').list({ sessionId, limit: 50 })
    return consistency.findPrior(tasks, task)
  } catch {
    return null
  }
}

module.exports = { diagnose, nextStepOf }
