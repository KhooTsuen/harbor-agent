/**
 * 任务：计划块
 *
 * 从 task.cjs 拆出来的（那边过 300 行了）。
 *
 * 模型回复里出现一个 ```plan 围栏块，里面是编号或短横线列表，
 * 就把它解析成计划条目存进任务 —— 它是**给人看的**。
 *
 * 为什么不用 function calling 让模型「填计划」：计划本身要给人看，
 * 而工具调用是给机器看的，混在一起两边都不好用。
 */

const crypto = require('node:crypto')

/** 计划块第一行的任务名写法：`# 名字` / `任务名：名字` / `name: 名字` */
const TITLE_LINE = /^(?:#{1,3}\s*(.+)|(?:任务名|任务|名称|name|title)\s*[:：]\s*(.+))$/i

/**
 * 解析模型给的 ```plan 块。
 *
 * 约定：回复里出现一个 ```plan 围栏块。**第一行可以是任务名**
 * （`# 优化 Agent 启动`，或 `任务名：优化 Agent 启动`），下面每行一条步骤
 * （编号或短横线都行）。
 *
 * 为什么把任务名放进计划块：AG-027 要求「Chat 与 Task 分离」——
 * 聊天是「继续优化 Agent」，任务叫「优化 Agent 启动」，两者不是一回事。
 * 名字由模型在**出计划时**顺手给（它最清楚这活叫什么），不比另开一次
 * 调用让模型「起个名」贵。
 *
 * 不用 function calling 让模型「填计划」，是因为计划本身要给人看，
 * 而工具调用是给机器看的 —— 混在一起两边都不好用。
 *
 * @returns {{ title: string, steps: string[] }}
 */
function parsePlanBlock(text) {
  const match = /```(?:plan|计划|task|任务)\s*\n([\s\S]*?)```/i.exec(String(text ?? ''))
  if (!match) return { title: '', steps: [] }

  let title = ''
  const steps = []
  let first = true
  for (const raw of match[1].split('\n')) {
    const line = raw.trim()
    if (!line) continue

    /* 只有**第一行**才可能是任务名 —— 否则「步骤里带个 #」也会被当成名字 */
    if (first) {
      first = false
      const named = TITLE_LINE.exec(line)
      if (named) {
        title = normalizeTitle(named[1] ?? named[2] ?? '')
        continue
      }
    }

    const step = line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim()
    if (step.length > 0 && step.length < 200) steps.push(step)
  }

  return { title, steps: steps.slice(0, 20) }
}

/** 只取计划条目（老接口，行为不变） */
function parsePlan(text) {
  return parsePlanBlock(text).steps
}

/**
 * 任务名归一化：压空白、去 markdown 标记与包裹引号、去尾部标点、超长截断。
 * 名字要显示在两三个字宽的地方（横幅、侧栏），所以默认就掐在 60 字以内。
 */
function normalizeTitle(raw) {
  const one = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .replace(/^["'`「『]+|[\"'`」』]+$/g, '')
    .replace(/[：:。，,；;]+$/, '')
    .trim()
  return one.length > 60 ? `${one.slice(0, 59)}…` : one
}

/** 口语前缀：「继续优化 Agent」是聊天，任务该叫「优化 Agent」 */
const FILLER =
  /^(?:继续|接着|然后|再|帮我|帮忙|麻烦你|麻烦|请你|请|你现在|你来|你|我想|我要|需要|能不能|能否|可以帮我|可以)\s*[，,：:]?\s*/

/**
 * 从用户那句话里兜底提炼一个任务名：剥口语前缀 → 取第一句 → 掐 40 字。
 *
 * 模型给了 `# 名字` 就用它的；没给（简单的一问一答、或者老任务）才走这里。
 * 兜底绝不能直接把整句话当名字 —— 那正是 AG-027 要修的「任务名 == 聊天」。
 */
function deriveTitle(text) {
  let out = String(text ?? '').trim()
  if (!out) return ''
  for (let i = 0; i < 3 && FILLER.test(out); i += 1) out = out.replace(FILLER, '')
  const first = out.split(/[。！？!?；;\n]/)[0] ?? out
  const title = normalizeTitle(first || out)
  return title.length > 40 ? `${title.slice(0, 39)}…` : title
}

/**
 * 没有名字时的兜底名。
 *
 * 为什么单独一个函数：`create()` 用它、`adoptTitle()` 拿它做比较 ——
 * 两边必须**逐字一致**，否则一对不上就永远采纳不了。
 * 真实踩到的例子：goal = 「继续」→ `deriveTitle` 剥完口语前缀剩空串 →
 * `create` 兜底成「未命名任务」，而比较时算出的是 `''` → 不相等 →
 * 模型给的名字永远被当成「它已经有名字了」拒掉。
 */
function fallbackTitle(goal) {
  return deriveTitle(goal) || '未命名任务'
}

/**
 * 采纳模型给的任务名 —— **只在任务还没有自己的名字时**。
 *
 * 为什么要这道闸：模型每轮都会把计划块重发一遍，措辞稍微一变就会改名，
 * 任务在界面上会来回跳。名字定下来就不动了（用户要改可以自己改标题）。
 * 「还没有自己的名字」的判据 = 空，或者还是从 goal 兜底推出来的那个。
 */
function adoptTitle(task, raw) {
  const title = normalizeTitle(raw)
  if (!title || !task) return false
  if (task.title && task.title !== fallbackTitle(task.goal)) return false
  if (task.title === title) return false
  task.title = title
  return true
}

/**
 * 计划整体指纹。
 *
 * 放在这里而不是 task.cjs，是为了避开循环依赖（task.cjs 要算指纹、
 * task-context.cjs 要读任务）—— 这里只依赖 node:crypto，两边都能安全引用。
 */
function fingerprint(plan) {
  const text = (Array.isArray(plan) ? plan : []).join('\n')
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * 记一版计划，留下历史（AG-004）。
 *
 * 计划不是一次成型的：用户改要求、或者模型自己发现路走不通，都要重新规划。
 * 老做法是直接覆盖 `task.plan`，旧计划就没了 —— 事后看不出「为什么变成现在这样」。
 *
 * 这里只改内存对象，**不落盘**（落盘是 task.cjs 的事）。返回值告诉调用方
 * 「这次到底变没变」—— 模型每一轮都会把计划原样复述一遍，不变就不能记新版本，
 * 否则一次对话能刷出几十版一模一样的计划。
 *
 * @param {object} task 任务记录（原地改）
 * @param {string[]} plan 新计划
 * @param {{ reason?: string, at?: number, title?: string }} [options] title = 模型给的任务名
 * @returns {{ changed: boolean, version: number, reason: string, title: string }|null} 计划为空时 null
 */
function recordVersion(task, plan, { reason = '', at = Date.now(), title = '' } = {}) {
  if (!task || !Array.isArray(plan) || plan.length === 0) return null

  const versions = Array.isArray(task.planVersions) ? task.planVersions : []
  const current = versions.length > 0 ? versions[versions.length - 1].plan : task.plan
  if (Array.isArray(current) && current.length > 0 && fingerprint(current) === fingerprint(plan)) {
    return { changed: false, version: versions.length, reason: '', title: task.title || '' }
  }

  const label = reason || (versions.length === 0 ? '初始计划' : '重新规划')
  versions.push({ plan: plan.slice(), at, reason: label })
  task.planVersions = versions
  task.plan = plan.slice()
  task.planHash = fingerprint(plan)
  /* AG-027：模型顺手给的任务名（只在任务还没有自己的名字时才采纳） */
  adoptTitle(task, title)
  return { changed: true, version: versions.length, reason: label, title: task.title || '' }
}

/**
 * 老任务迁移：只有 `plan`、没有 `planVersions` 的，读的时候补一条 v1。
 * 只补在内存里（真正落盘等下一次写）—— 老数据一个字节都不动。
 */
function migrate(task) {
  if (!task || Array.isArray(task.planVersions)) return task
  const plan = Array.isArray(task.plan) ? task.plan : []
  task.planVersions = []
  /* 先把 task.plan 清掉 —— 否则 recordVersion 会拿它当「当前版」，
     一看和要补的那份一样就判定「没变」，版本就补不出来。
     （这是测试抓出来的：第一版补不上，planVersions 还是空的。） */
  task.plan = []
  if (plan.length > 0)
    recordVersion(task, plan, { at: task.updatedAt || task.createdAt || Date.now() })
  return task
}

/**
 * AG-012：计划里**第一条没打勾的** —— 就是「下一步要做的」。
 *
 * 存进任务记录（`task.nextAction`），重启之后不必把整份计划重新喂给模型，
 * 就能直接告诉用户「它停在哪一步」。
 */
function nextActionOf(plan) {
  const list = Array.isArray(plan) ? plan : []
  const line = list.find((item) => !/^\s*\[[xX]\]/.test(String(item)))
  if (line === undefined) return ''
  return String(line)
    .replace(/^\s*\[[ xX]\]\s*/, '')
    .slice(0, 200)
}
module.exports = {
  parsePlan,
  parsePlanBlock,
  normalizeTitle,
  deriveTitle,
  fallbackTitle,
  adoptTitle,
  fingerprint,
  recordVersion,
  migrate,
  nextActionOf,
}
