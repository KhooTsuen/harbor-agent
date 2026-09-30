/**
 * 稳定性指标 —— 从**台账**里算出来的那几行数字
 *
 * 为什么要它：项目自己的账上挂着一条 ⚠️「成功率 ≥90% 没有量化基线」
 * （`docs/improvement-checklist.md` 阶段一 1.1）。而台账里其实**什么都有** ——
 * 每个任务的状态、恢复过几次、每一步的成败、错误原文、轮数、用量。
 * 缺的从来不是数据，是「加起来」这一步。所以这里**不新增任何埋点**，
 * 只读 `data/tasks/*.json`。
 *
 * 口径（数字最容易各说各的，先把规矩写死；这几条都有自检钉着）：
 *   · **成功率的分母是「已经定了的」** = 完成 + 失败 + 放弃。
 *     `paused` **不算分母** —— 它还能接着做（撞预算 / 关掉应用 / 转圈交人都停在这）。
 *     把它算进分母，等于把「还没做完」记成「没做成」，用户会看到一个假的低分。
 *   · **分母为 0 时比率一律是 `null`，不是 0**。0 会被读成「一次都没成」，
 *     而真相是「还没有样本」—— 项目里已经栽过「缺数据填 0」的当（token 缓存口径）。
 *   · **读不动的任务文件单独计数**，不进任何分母（坏一条不该让整份指标变味）。
 *   · 工具调用数取「带 `intent` 的那一批」：一次调用在台账里会留**两条**
 *     （一条意图+结果、一条带参数的流水），两条都数就翻倍了。老台账没有 `intent`
 *     时退回到「带 `args` 的那批」，并在报告里注明是哪种口径。
 *
 * 刻意不 require('electron')：自检直接跑。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const errors = require('./errors.cjs')

/** 已经「定了」的状态 —— 成功率的分母就是它们（`paused` 不在里面，见文件头） */
const SETTLED = ['completed', 'failed', 'cancelled']
const STATUS_LABELS = {
  completed: '完成',
  failed: '失败',
  cancelled: '放弃',
  paused: '暂停',
  running: '在跑',
  waiting_user: '等你确认',
}

/** 分母为 0 → null（**不填 0**，见文件头） */
const rate = (part, whole) => (whole > 0 ? part / whole : null)

const mean = (list) =>
  list.length > 0 ? list.reduce((sum, n) => sum + Number(n || 0), 0) / list.length : null

/** 读一遍台账；坏文件只记名字，不当崩溃 */
function readTasks(root = DIRS.data) {
  const dir = path.join(root, 'tasks')
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('_'))
  } catch {
    return { tasks: [], broken: [], root }
  }
  const tasks = []
  const broken = []
  for (const name of names.sort()) {
    try {
      tasks.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
    } catch {
      broken.push(name)
    }
  }
  return { tasks, broken, root }
}

/**
 * 把一批任务变成指标。
 *
 * @param {Array} tasks 台账里的任务对象
 * @param {{ broken?: number|Array }} [options] 读不动的文件名（传数组或条数都认）
 */
function summarize(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : []
  /* 传数组（readTasks 的返回值）或直接传条数都行 —— 调用方两种都写过，别再咬这一口 */
  const brokenCount = Array.isArray(options.broken)
    ? options.broken.length
    : Number(options.broken ?? 0) || 0

  const byStatus = {}
  for (const task of list) {
    const status = String(task.status ?? 'unknown')
    byStatus[status] = (byStatus[status] ?? 0) + 1
  }
  const settled = SETTLED.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0)
  const successRate = rate(byStatus.completed ?? 0, settled)

  /* 恢复：被恢复过几次、恢复之后到底做成了没有 */
  const resumed = list.filter((task) => Number(task.resumeCount ?? 0) > 0)
  const resumedCompleted = resumed.filter((task) => task.status === 'completed').length

  /* 工具：见文件头那条「一次调用留两条」 */
  let calls = 0
  let failed = 0
  let intentEntries = 0
  const perTool = {}
  for (const task of list) {
    const steps = Array.isArray(task.steps) ? task.steps : []
    const withIntent = steps.filter((step) => step && step.intent)
    intentEntries += withIntent.length
    const chosen = withIntent.length > 0 ? withIntent : steps.filter((step) => step && step.args)
    for (const step of chosen) {
      calls += 1
      const name = String(step.tool ?? '（没记工具名）')
      perTool[name] = perTool[name] ?? { calls: 0, failed: 0 }
      perTool[name].calls += 1
      if (step.ok === false) {
        failed += 1
        perTool[name].failed += 1
      }
    }
  }
  const topFailing = Object.entries(perTool)
    .map(([name, row]) => ({ name, ...row }))
    .filter((row) => row.failed > 0)
    .sort((a, b) => b.failed - a.failed)
    .slice(0, 5)

  /* 错误分类复用 errors.cjs —— 分类口径只留一份 */
  const byKind = {}
  for (const task of list) {
    for (const entry of Array.isArray(task.errors) ? task.errors : []) {
      const info = errors.classify(String(entry?.message ?? ''))
      byKind[info.kind] = (byKind[info.kind] ?? 0) + 1
    }
  }
  const errorTotal = Object.values(byKind).reduce((sum, n) => sum + n, 0)

  const byPauseReason = {}
  for (const task of list) {
    if (task.status !== 'paused') continue
    const reason = String(task.pauseReason ?? '') || '（没写原因）'
    byPauseReason[reason] = (byPauseReason[reason] ?? 0) + 1
  }

  const durations = []
  for (const task of list) {
    const start = Number(task.createdAt ?? 0)
    const end = Number(task.finishedAt ?? 0)
    /* 只收**真的用了时间**的那批：老台账里 createdAt === finishedAt 的不少
       （测试造的、从来没跑起来的），算进去会把平均用时拉成一个假的 0 */
    if (start > 0 && end > start) durations.push(end - start)
  }

  return {
    at: Date.now(),
    tasks: {
      total: list.length,
      broken: brokenCount,
      byStatus,
      settled,
      successRate,
    },
    recovery: {
      resumed: resumed.length,
      resumedCompleted,
      /** 被恢复过的比例（恢复这件事有多常见） */
      share: rate(resumed.length, list.length),
      /** 恢复之后做成的比例（恢复到底管不管用） */
      successRate: rate(resumedCompleted, resumed.length),
    },
    tools: {
      calls,
      failed,
      failureRate: rate(failed, calls),
      /** `intent` = 台账里有意图账（新任务）；`args` = 老台账的退路口径 */
      counting: intentEntries > 0 ? 'intent' : 'args',
      topFailing,
    },
    errors: { total: errorTotal, byKind },
    pause: { byReason: byPauseReason },
    avg: {
      turns: mean(list.map((task) => Number(task.turns ?? 0)).filter((n) => n > 0)),
      durationMs: mean(durations),
      tokens: mean(list.map((task) => Number(task.tokens ?? 0)).filter((n) => n > 0)),
    },
  }
}

/**
 * 真机任务集（`npm run acceptance` 的 `acc-report.json`）。
 * 传进来的必须是那个数组本身；读不动就当没有。
 */
function fromBattery(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return null
  const byTask = {}
  for (const row of list) {
    const name = String(row?.任务 ?? '（没记名字）')
    byTask[name] = byTask[name] ?? { runs: 0, passed: 0 }
    byTask[name].runs += 1
    if (row?.通过) byTask[name].passed += 1
  }
  const passed = list.filter((row) => row?.通过).length
  return { runs: list.length, passed, failed: list.length - passed, byTask }
}

const percent = (value) => (value === null ? '还没有样本' : `${(value * 100).toFixed(0)}%`)
/** 0 或不合理值一律当「没有样」—— 「平均 0 分钟」会被读成「秒回」 */
const positive = (value) => (typeof value === 'number' && value > 0 ? value : null)
const num = (value, unit = '') =>
  positive(value) === null ? '还没有样本' : `${Math.round(value * 10) / 10}${unit}`
/** 不到一分钟就说秒 —— 「0.0 分钟」等于没说 */
const ms = (value) => {
  if (positive(value) === null) return '还没有样本'
  return value < 60000 ? `${(value / 1000).toFixed(1)} 秒` : `${(value / 60000).toFixed(1)} 分钟`
}

/** 报告 → 给人看的几行（命令行与界面共用同一份措辞） */
function format(report) {
  const t = report.tasks ?? {}
  const statusText = Object.entries(t.byStatus ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${STATUS_LABELS[status] ?? status} ${n}`)
    .join(' · ')
  const lines = [
    'Harbor 稳定性指标（读的是任务台账，不是猜的）',
    `  任务 ${t.total ?? 0} 条${t.broken ? `（另有 ${t.broken} 条读不动，没算进任何分母）` : ''}：${statusText || '一条都没有'}`,
    `  成功率 ${percent(t.successRate)} —— ${t.byStatus?.completed ?? 0}/${t.settled ?? 0}` +
      `（分母是「已经定了的」：完成 + 失败 + 放弃；暂停不算，它还能接着做）`,
  ]
  const r = report.recovery ?? {}
  lines.push(
    `  恢复：被恢复过 ${r.resumed ?? 0} 条${r.share === null ? '' : `（占 ${percent(r.share)}）`}` +
      `，其中最后做成 ${r.resumedCompleted ?? 0} 条 —— ${percent(r.successRate ?? null)}`,
  )
  const tool = report.tools ?? {}
  lines.push(
    `  工具：${tool.calls ?? 0} 次调用，失败 ${tool.failed ?? 0} 次 —— ${percent(tool.failureRate ?? null)}` +
      `（口径：${tool.counting === 'intent' ? '带意图账的步骤' : '带参数的步骤'}）`,
  )
  for (const row of tool.topFailing ?? []) {
    lines.push(`        ${row.name}：失败 ${row.failed}/${row.calls}`)
  }
  const errs = report.errors ?? {}
  const kinds = Object.entries(errs.byKind ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([kind, n]) => `${kind} ${n}`)
  lines.push(`  错误：${errs.total ?? 0} 条${kinds.length > 0 ? ` —— ${kinds.join(' · ')}` : ''}`)
  const pauses = Object.entries(report.pause?.byReason ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ${n}`)
  if (pauses.length > 0) lines.push(`  暂停原因：${pauses.join(' · ')}`)
  const avg = report.avg ?? {}
  lines.push(
    `  平均：${num(avg.turns, ' 轮')} · ${ms(avg.durationMs ?? null)} · ${num(positive(avg.tokens) === null ? null : avg.tokens / 1000, 'k token')}`,
  )
  if (report.battery) {
    const b = report.battery
    lines.push(
      `  真机任务集：跑过 ${b.runs} 次，通过 ${b.passed} 次 —— ${percent(rate(b.passed, b.runs))}`,
    )
    for (const [name, row] of Object.entries(b.byTask ?? {})) {
      lines.push(`        ${name}：${row.passed}/${row.runs}`)
    }
  }
  return lines.join('\n')
}

module.exports = { readTasks, summarize, fromBattery, format, SETTLED, STATUS_LABELS }
