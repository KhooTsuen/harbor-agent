/**
 * 建一条任务
 *
 * 从 `task.cjs` 拆出来的（那边 312 行贴了上限）。这是一处**天然的缝**：
 * 「一条刚出生的任务长什么样」—— 全部字段的初值 —— 就是这里的全部内容，
 * 不碰状态迁移、不碰查询、不碰删除。
 *
 * ⚠️ 加字段时记住两件事：
 *   ① `task.cjs` 的 `update()` 里有**白名单**，字段不在名单里会被**静默丢掉**；
 *   ② 旧任务没有新字段，读出来是 `undefined` —— 用到的地方都要容错。
 */

const io = require('./task-io.cjs')
const { fallbackTitle } = require('./task-plan.cjs')

/**
 * @param {{ goal: string, sessionId?: string, projectId?: string, workdir?: string,
 *           mode?: string, budget?: object, preset?: string }} options
 */
function create({
  goal,
  sessionId = '',
  projectId = '',
  workdir = '',
  mode = 'pair',
  budget = {},
  preset = '',
} = {}) {
  const task = {
    id: io.newId(),
    /* AG-027：任务名**不取聊天原句**，从里面提炼动作名；模型在计划块里给了 `# 名字` 会覆盖它 */
    title: fallbackTitle(goal),
    goal: String(goal ?? ''),
    status: 'running',
    mode,
    sessionId,
    projectId,
    workdir,
    /** 模型给出的计划（从回复里解析）；planVersions 是 AG-004 的版本历史（含当前版） */
    plan: [],
    planVersions: [],
    /** 实际发生的事 —— 一次工具调用一条 */
    steps: [],
    checkpoints: [],
    changedFiles: [],
    commands: [],
    changeSetId: '',
    errors: [],
    result: '',
    /* AG-040：这个任务自己的执行预算覆盖（不填就用设置里的默认） */
    budget: { ...budget },
    /* ②-2：预算是不是「按任务类型预设」给的（存类型 key，如 `code`）。空 = 按用户设置走 */
    preset: String(preset ?? ''),
    /** 停下来的原因（'' | 'budget'）与细节（撞了哪一项）—— 界面据此说话 */
    pauseReason: '',
    pauseDetail: '',
    /** 撞预算时的数字：{ reason, label, used, limit } */
    budgetHit: null,
    /** AG-041：转圈停下来时的证据：{ kind, period, count, samples } */
    loopHit: null,
    /** AG-042：控制台要显示的两个数字（这一轮烧了多少 token、自动重试了几次） */
    tokens: 0,
    retries: 0,
    /** AG-043：用户在任务执行中改方向的记录 [{ at, text }]（原计划历史另有 planVersions） */
    steering: [],
    /* AG-012：重启恢复要用的四样 —— 下一步、停的时刻、恢复过几次、批过什么 */
    nextAction: '',
    permissions: [],
    /*
     * AG-035：是哪只手在干这个活。
     * `models` 记**这个任务用过的**（按先后去重）—— 中途换过模型是
     * 「怎么前后不一样了」的常见原因，诊断时要看得见。
     */
    model: '',
    models: [],
    /* ②-1：这次用的是哪版提示词（形如 `prompt-stack/1`）。提示词也是代码，改它就会改行为 */
    promptVersion: '',
    promptVersions: [],
    pausedAt: 0,
    resumeCount: 0,
    createdAt: Date.now(),
    updatedAt: io.monotonicNow(),
    finishedAt: 0,
  }
  io.write(task)
  return task
}

module.exports = { create }
