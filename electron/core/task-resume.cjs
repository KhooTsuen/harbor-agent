/*
 * AG-011：恢复一个暂停的任务
 *
 * 从 `task.cjs` 单独开一个文件，是因为那边 299 行已经贴到上限了 ——
 * 而且「恢复」本来就是一个独立的关注点：它要回答三个问题
 *
 *   ① 这条任务现在能不能恢复（`canResume`）
 *   ② 恢复时**复用哪条任务**（`reopen` —— 复用它自己，不新建）
 *   ③ 环境还和当初一样吗（`checkEnvironment`）
 *
 * ── 为什么必须复用同一条任务 ──
 *
 * 文档要求「不重复已完成步骤」。这条不是靠什么记忆机制做到的，
 * 而是因为**任务的 steps / plan 都还在那条记录里** ——
 * `task-context.cjs` 会把「计划里第一条没打 [x] 的」注入提示，
 * 模型看到「这些已经做完了」自然不会重做。
 * 新建一条任务等于把这些全丢掉，那才是真的会从头再来。
 */

const fs = require('node:fs')
const taskCore = require('./task.cjs')
/* P0-3：归属判定只有一处（哪条接回 / 新建）—— 这里只借它，不再自己判一遍 */
const attribution = require('./task-attribution.cjs')

/** 这两种状态都算「停下来了，可以接着做」 */
const RESUMABLE = new Set(['paused', 'waiting_user'])

/**
 * mtime 的比较容差。
 *
 * Windows 上刚写完的文件，它的 last-write-time 可能还在「路上」（系统时钟
 * 粒度问题，实测能晚一秒上下）。不留余量的话，自己刚改完的文件会被判成
 * 「又被别人改了」—— 真机上自测时就撞到过这个。
 * 代价：暂停后两秒内被人改的文件检测不到 —— 暂停到恢复一般隔得比这久。
 */
const MTIME_SLACK_MS = 2000

/** 能不能恢复（前端拿它决定「继续」按钮亮不亮） */
function canResume(taskId) {
  const task = taskCore.get(String(taskId ?? ''))
  return Boolean(task && RESUMABLE.has(task.status))
}

/**
 * 把任务改回 running 并返回它自己（**不新建**）。
 * 状态不对（已完成 / 不存在）时返回 null，交给调用方新建一条。
 *
 * AG-012：顺手记 `resumeCount` —— 恢复过几次，重启清单里给用户看。
 */
function reopen(taskId) {
  const task = taskCore.get(String(taskId ?? ''))
  if (!task || !RESUMABLE.has(task.status)) return null
  return taskCore.update(task.id, {
    status: 'running',
    resumeCount: (task.resumeCount ?? 0) + 1,
    /* AG-040：接着做就别再挂着「已达上限」那三按钮了 */
    pauseReason: '',
    pauseDetail: '',
    budgetHit: null,
    loopHit: null,
  })
}

/**
 * 恢复前检查环境：任务停住之后，它改过的文件有没有被别再动过。
 *
 * 判据是 mtime **晚于任务的 `updatedAt`** —— 任务一旦暂停就不再更新，
 * 所以「比它还新」就等于「Agent 撒手之后有人动过」。
 * 直接接着做可能基于过时的假设（比如那段代码已经被改掉了）。
 *
 * 文件不存在 / 读不到也算「变了」—— 那更得让模型先看一眼。
 */
function checkEnvironment(taskId) {
  const task = taskCore.get(String(taskId ?? ''))
  if (!task) return { ok: false, changed: [], shells: 0 }
  const changed = []
  for (const item of task.changedFiles ?? []) {
    const file = String(item?.path ?? '')
    if (!file) continue
    try {
      if (fs.statSync(file).mtimeMs > (task.updatedAt ?? 0) + MTIME_SLACK_MS) changed.push(file)
    } catch {
      changed.push(file)
    }
  }
  /*
   * P1-C：**跑过几条命令**（只数，不推断）。
   *
   * 为什么不推断「它改了哪些文件」：`run_shell` 的输出里没有可信的文件清单，从命令
   * 字符串反推（`git checkout`？`npm install`？`mv`？）只会猜错 —— 而猜错的代价是模型
   * 以为工作区还是老样子。所以这里只给一个事实：「跑过 N 条命令」，剩下让它自己核对现状。
   * （`changedFiles` 只由 write_file / edit_file 写入，见 tool-runner 与 loop-tools。）
   */
  const shells = (Array.isArray(task.steps) ? task.steps : []).filter(
    (step) => step?.tool === 'run_shell' && step?.ok !== false,
  ).length
  return { ok: true, changed, shells }
}

/**
 * 恢复 / 接着做时，台账该多说两句什么（P1-C）。
 *
 * 两条都只在**有内容时**返回，且都是「给事实、让它自己核对」的口径：
 *  · 跑过命令 → 提醒核对现状。**不编文件清单**：`run_shell` 改了哪些文件无法可靠推断
 *    （`git checkout` / `mv` / 脚本），猜错会让模型以为工作区还是老样子。
 *  · 有历史步骤 → 提一句可以用 `recall` 回看，而不是把工具重跑一遍。
 *
 * 为什么不放 `task-context.cjs`：那个文件贴着行数红线，而这两条与 `checkEnvironment`
 * 是同一件事（「接着做之前该知道什么」），放一起不容易漂。
 *
 * @param {{ task: object, env: { changed: string[], shells: number }, isCurrent: boolean }} input
 * @returns {string[]}
 */
function resumeNotesOf({ task, env, isCurrent }) {
  const notes = []
  if (env.shells > 0 && env.changed.length === 0) {
    notes.push(
      `  ⚠ 这一轮跑过 ${env.shells} 条命令，它们可能已改动工作区（命令改了哪些文件无法从台账可靠推断）：` +
        '接着改之前先**用 read_file / run_shell 核对当前状态**，不要凭上一轮的印象直接写。',
    )
  }
  if (isCurrent && (task.steps ?? []).length > 0) {
    notes.push('  想看清上一轮某次工具到底读到了什么：`recall` 按指纹或序号取回（只读本会话，比重跑一遍安全）。')
  }
  return notes
}

/**
 * 这条对话里有没有「还等着你」的任务。
 *
 * ★ P0-3（2026-10-23）：判断**只有一处** —— 这里只是 `task-attribution.decide()`
 *   的兼容壳（老调用方和自检还在用这个名字）。真正的规则、顺序与理由在那边；
 *   别在这里再写一遍 `status === 'waiting_user' || ...`。
 *
 * 以前这个函数本身是一套规则、`loop-run` 又照它写了一遍 `attached`、
 * 而 `chat-run` 生成提示时用的是第三个判断（payload.taskId）—— 三处不一致。
 */
function activeForSession(sessionId, { continueIntent = false } = {}) {
  if (!sessionId) return null
  const decision = attribution.decide({
    sessionId,
    /* 只在「明确说继续」时才把这句话当继续 —— decide 内部用同一个正则判 */
    continueIntent,
  })
  return decision.kind === 'resume' ? taskCore.get(decision.taskId) : null
}

/**
 * 起一次运行：能恢复就**复用原任务**，否则新建一条。
 * 把这段放在这里（而不是 loop.cjs）是因为它长了点 —— 那边已经贴 300 行上限。
 *
 * ★ P0-3：复用哪条 / 新建，**由 `attribution` 决定**（调用方已经判过一次的话就传进来，
 *   没传就当场判一次）。这里**不再自己判断**「是不是继续」「哪条在等回话」——
 *   以前那样做，等于同一个问题决定两次（`chat-run` 生成提示时一次、这里一次）。
 */
function openForRun({
  resumeTaskId = '',
  goal = '',
  sessionId = '',
  /** 已经判好的归属（`task-attribution.decide()` 的返回值）；不传就当场判一次 */
  attribution: decided = null,
  /** 兼容老调用方：只说「这是继续」而不带 goal 时用它 */
  continueIntent = false,
  /** 重新生成：新任务挂上它（被替代的台账 id，`` = 不是重新生成） */
  regenerateFrom = '',
  /** 重新生成：从旧任务继承的用量基线（见 budget.carryOf） */
  budgetCarry = null,
  ...options
}) {
  const decision =
    decided ??
    attribution.decide({
      resumeTaskId,
      sessionId,
      goal,
      /* 显式标志（老调用方）优先于从措辞里认 */
      continueIntent: continueIntent === true ? true : null,
    })

  /*
   * ★ 重新生成**必须新建**（regenerateFrom 非空时跳过接回）：它要独立成一条台账
   *   （`regeneratedFrom` 指向被重做的那条）——接回旧任务就把「两条记录」抹成一条了。
   */
  if (decision.kind === 'resume' && !regenerateFrom) {
    const reopened = reopen(decision.taskId)
    if (reopened) return reopened
  }

  /* AG-027：不传 title —— 让 create 从 goal 提炼（聊天句 ≠ 任务名） */
  /*
   * ★ 这里原来会按任务类型预填一份预算（查资料 60/120…）。已下线：
   *   用户看到「撞了轮数上限」而自己没设过任何一个数字，是本项目最不该出现的事。
   *   现在 `budget` 一律空 = 不限（见 `budget.cjs` 的 DEFAULTS）。
   */
  return taskCore.create({
    goal,
    sessionId,
    projectId: options.projectId,
    workdir: options.workdir,
    mode: options.mode,
    regeneratedFrom: regenerateFrom,
    budgetCarry,
  })
}

module.exports = { canResume, reopen, checkEnvironment, resumeNotesOf, openForRun, activeForSession, RESUMABLE }
