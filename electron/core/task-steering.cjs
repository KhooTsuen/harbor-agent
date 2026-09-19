/**
 * 怎么把话递回给模型（AG-041 之前的 AG-027 / AG-043 都住这里）
 *
 * 从 `task-context.cjs` 搬出来的 —— 那边在 AG-043 加了「用户改方向」之后到了 353 行。
 * 三块内容同属一件事：**在对话层面引导模型**（不是记账、不是状态机）：
 *
 *   · `isContinueIntent`  认出「用户说的是继续」—— 这一句话会被用来决定怎么提示
 *   · `shouldContinue`    完成门禁：计划没勾完就想收工 → 顶回去继续（自带两个刹车）
 *   · `steeringNote`      用户在执行中**改了方向**：别重做已完成步骤、按新的重规划
 *
 * 「任务是什么、走到哪一步」仍然在 task-context.cjs；这里只负责说法。
 */

const taskCore = require('./task.cjs')
const { progressOf, isDone } = require('./task-plan.cjs')

/**
 * 组装注入文本。没有未完成任务就返回空串（调用方据此不注入这一层）。
 *
 * `taskId` 用来标出「当前正在做的那条」，其余只列标题 —— 并行跑多条对话时，
 * 模型需要知道自己手上是哪一条，否则容易把别的任务的计划当成自己的。
 */
/**
 * AG-018：用户这句话是不是「接着刚才的做」？
 *
 * ★ 要小心别把「继续优化 Agent 执行系统」当成继续 —— 那是新任务。
 *   所以两条约束：**句子短**（超过 15 字基本是在描述新要求）、
 *   **模式明确**（「继续」后面只接「改/做/干/写/弄/来」这类光杆动词，不接宾语）。
 *
 * 文档点名的几种：继续 / 然后呢 / 继续改 / 接着做 / 还是刚才那个问题。
 */
const CONTINUE_RE = [
  /^(继续|接着|然后呢|往下|接着来|再来)$/,
  /^(继续|接着)(改|做|干|写|弄|来|吧|下去|往下)?$/,
  /(接着做|接着干|继续做|继续改|继续弄|还是刚才|刚才那个|上一步|上一次那个)/,
  /^(go on|continue|keep going)$/i,
]

/** 门禁最多顶几次（顶够就放行 —— 不能让模型被卡死在这儿） */
const MAX_BLOCKS = 3

function isContinueIntent(text) {
  const t = String(text ?? '')
    .trim()
    .replace(/[。！!？?~～\s]+$/, '')
  /* 15 字：真机调出来的。30 字太松 —— 「接着把刚才那个模块重构一下，另外还要
     加上日志和错误处理」会被当成继续，那明明是**新要求**。宁可漏判（当成新任务
     再问一句）也不要误判（把新活儿当成接着做）。 */
  if (!t || t.length > 15) return false
  return CONTINUE_RE.some((re) => re.test(t))
}
/**
 * 完成门禁：模型想收工时，判断要不要把它顶回去。
 *
 * @returns {{ continue: boolean, message?: string, seen: object }}
 *   `seen` 要原样存下来，下一轮再传进来 —— 次数和进度快照都靠它。
 */
function shouldContinue({ taskId = '', content = '', seen = {} } = {}) {
  const blocks = Number(seen.blocks) || 0

  /* 刹车一：顶够次数就放行 */
  if (blocks >= MAX_BLOCKS) return { continue: false, seen }

  let task = null
  try {
    task = taskId ? taskCore.get(taskId) : null
  } catch {
    task = null
  }
  if (!task || task.status !== 'running') return { continue: false, seen }
  /* 注意：只拦 running。paused 是用户主动停的、waiting_user 是在等用户回话 ——
     这两种情况下「不让模型收工」都是骚扰。 */

  const plan = task.plan ?? []
  const { done, total } = progressOf(plan)
  /* 没有计划、或计划已经全勾完 → 不拦 */
  if (total === 0 || done >= total) return { continue: false, seen }

  /* 刹车二：停滞检测。上一轮也是这个进度、而且已经顶过一次 → 说明顶没用，放行 */
  const snapshot = `${task.id}:${done}/${total}`
  if (seen.snapshot === snapshot && blocks > 0) return { continue: false, seen }

  const next = plan.find((line) => !isDone(line)) ?? ''
  const message = [
    `任务「${task.title || task.id}」的计划还没做完（${done}/${total}），先别收尾。`,
    next ? `下一条是：${String(next).replace(/^\s*\[[xX ]\]\s*/, '')}` : '',
    '做完后用 ```plan 块给出**更新后的完整计划**（第一行 `# 任务名`，完成的步骤标 `[x]`），再收尾。',
    '如果这活其实已经不需要做了，直接说明原因并把计划里对应条目标记完成。',
  ]
    .filter(Boolean)
    .join('\n')

  return { continue: true, message, seen: { blocks: blocks + 1, snapshot } }
}
/**
 * 模型回复里如果给了 ```plan 块，存进任务。
 *
 * 只看第一次：后面再给的多半是对计划的修正，界面上会跳来跳去。
 * 而「更新计划」走的是模型重发完整计划（带 `[x]` 标记），也走这里。
 *
 * @returns {string[]|null} 存下来的计划；没有就返回 null
 */
/**
 * 从回复里抓计划（AG-004）。**变了才返回**，两个原因：
 *
 * ① 模型每一轮都会把计划原样复述一遍（上下文里就有），不判断就得每轮发事件，
 *    一次对话刷出几十条一模一样的计划，界面一直在闪；
 * ② 以前只抓「第一次」，模型后来重新规划（用户改了要求、或发现路走不通）
 *    会被**静默丢弃** —— 现在每轮都给它看，变没变由这里说了算。
 *
 * @returns {{ plan: string[], version: number, reason: string }|null}
 */
/**
 * 「用户在执行中改了方向」该怎么跟模型说（AG-043）。
 *
 * 文档的例子：
 *
 *   用户：不要方案 A，改用方案 B
 *   Agent：收到。原计划 A → B → C；更新：B → C → Verify
 *
 * 要求四条：**不重新执行无关步骤 / 保留原计划历史 / 记录用户修改 / 从有效检查点继续**。
 * 前两条与第四条靠已有的东西（计划+进度注入、planVersions、检查点），这里补的是
 * 「明确告诉模型这是一次改方向，不是新任务、也别从头再来」。
 *
 * @returns {string} 没有改方向就返回空串
 */
function steeringNote({ task, userText = '' } = {}) {
  if (!task) return ''
  /* 只有「没干完的任务」才有改方向一说 */
  if (!['running', 'paused', 'waiting_user'].includes(String(task.status ?? ''))) return ''
  /* 光说「继续」不算改方向（那是接着做，task-hint 另有提示） */
  if (isContinueIntent(userText)) return ''
  const said = String(userText ?? '').trim()
  if (!said) return ''

  const last = (task.steering ?? []).at(-1)
  /* 这一轮没有记过改动 → 不是改方向（可能是普通的追问） */
  if (!last || Date.now() - Number(last.at ?? 0) > 5 * 60 * 1000) return ''

  const plan = (task.plan ?? []).map((line) => String(line).trim()).filter(Boolean)
  const { done, total } = progressOf(task.plan ?? [])
  return [
    '⚑ 用户在执行中**改了方向**（不是新任务，也不是要你从头再来）。',
    `  用户这次说：${said.slice(0, 240)}`,
    plan.length > 0 ? `  原计划（${done}/${total} 完成）：${plan.join(' → ').slice(0, 300)}` : '',
    '\n照这四条办：',
    '  1. **已经做完的步骤不要重做**（上面标 [x] 的就是做完的）',
    '  2. 只重做/新增受这次改动影响的部分',
    '  3. 用 ```plan 块给出**更新后的完整计划**（第一行 `# 任务名`，做完的照旧标 `[x]`）',
    '  4. 原计划历史会保留，不必为此解释',
  ]
    .filter(Boolean)
    .join('\n')
}

module.exports = { isContinueIntent, shouldContinue, steeringNote, MAX_BLOCKS }
