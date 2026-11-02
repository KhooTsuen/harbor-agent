/**
 * 经验闭环：**观察 → 候选 → 独立验证 → 升级 → 反例暂停 → 按需注入**
 *
 * 这一层只做编排，所有判据都在别处：
 *   · 状态机 / 阈值 / 目标提取 → `experience-schema.cjs`（文本与特征 → `experience-text.cjs`）
 *   · 落盘 → `experience-store.cjs`（三道闸 → `experience-guard.cjs`）
 *   · 「算不算修法已验证」→ `experience-certify.cjs` + `experience-verify.cjs`
 *   · 注入那一段 / 那一句 → `experience-inject.cjs`
 *
 * ── 三条入口，别混 ──
 *
 * 1. `observeRun()`：**每次工具调用结束后**调一次（真跑过的那一次）。
 *    失败 → 建候选 / 复现 +1 / 或（同类已验证过）记反例停用；
 *    成功 → 交给 `experience-certify`：**证明用了同一修法 + 验证器独立核实**才计数。
 * 2. `observeUserCorrection()`：用户那句「不对」→ 建候选。**永不自动升级**（见 schema 白名单）。
 * 3. `sectionFor()` / `afterRun()`：生产路径的两个唯一入口
 *    （`loop-prompt` 每轮调前者，`tool-runner` 每次调用后调后者）。
 *
 * ── 为什么「验证」要卡同工具同目标（`targetOf`）──
 * 不卡的话，「`npm test` 挂了」之后随便跑个 `dir` 成功就会被算成一次验证 ——
 * 三次巧合就能把一条假经验顶成规则。这是把巧合当证据，比不学更糟。
 * 光卡目标还不够（见 `experience-certify` 文件头）：还得卡**做法**与**独立观察**。
 *
 * ── 为什么候选**一个都不进提示** ──
 * 这就是用户要的「失败不会直接变成规则」：candidate 只落盘、只积累证据，
 * 注入入口（`experience-inject`）读的都是 `INJECTABLE`（只有 verified）。
 */

const schema = require('./experience-schema.cjs')
const store = require('./experience-store.cjs')
const certify = require('./experience-certify.cjs')
const inject = require('./experience-inject.cjs')
const log = require('./log.cjs')

/** 同一个目标，库里的那条和这次调用是不是同一件事 */
function sameTarget(item, feature) {
  const left = String(item?.target ?? '')
  const right = String(feature?.target ?? '')
  if (left || right) return left === right
  /* 都没有目标（ask_user 这类）就退回「同工具」 */
  return String(item?.tool ?? '') === String(feature?.tool ?? '')
}

/** 库里的候选 / 已验证条目里，和这次调用是「同一件事」的那些 */
function sameSubject(feature) {
  return store.list({ includeClosed: true }).filter((item) => item.tool === feature.tool && sameTarget(item, feature))
}

/**
 * 用户纠正的**去重维度**：哪条对话 · 哪一句。
 *
 * ── 反例 4 治的是什么（用户 2026-11-02 原话）──
 * 「用户纠正的去重应按对话及具体消息识别，不能用进程级的『上一句文本』压掉
 *   另一条对话中的相同纠正。」
 *
 * 旧实现是 `let lastObservedText = ''` —— 一个**模块级变量**。A 对话里用户说
 * 「不对，用 ts」，B 对话里用户说了同样一句（完全合理：两个项目都这么纠正），
 * 因为进程里「上一句」还是那句话，B 的那次就被**静默扔掉**了，记都不记。
 *
 * 现在：去重键 = `sessionId|messageId`，只回答「这句用户消息我刚刚是不是已经
 * 处理过」这一个问题 —— 它只用于**挡住同一条消息在一次回合内的重复装配**
 * （提示装配会被多次调用）。没有任何跨对话的「上一句」记忆。
 */
function seenKey({ sessionId = '', messageId = '' }) {
  return `${String(sessionId ?? '')}|${String(messageId ?? '')}`
}

/** 只在本进程内、且只缓存很少几条 —— 它挡的是「同一回合的重复装配」，不是长期记忆 */
const SEEN_LIMIT = 50
const seen = new Set()

function markSeen(key) {
  if (!key) return false
  if (seen.has(key)) return false
  seen.add(key)
  /* 先进先出：Set 保序 —— 超了就丢最早那条，别让它无限涨 */
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value)
  return true
}

/**
 * 一次工具调用的结果 → 经验库的更新。
 *
 * @param {{ toolName?: string, args?: object|null, ok?: boolean, failure?: object|null,
 *           text?: string, opportunityId?: string, workdir?: string, facts?: object|null,
 *           projectId?: string, sessionId?: string }} input
 * @returns {{ action: string, item?: object, promoted?: boolean, suspended?: boolean,
 *             reason?: string }}
 *   `action` 只是给日志 / 自检看的：`candidate` / `reproduced` / `verified` /
 *   `promoted` / `suspended` / `dropped` / `adopted` / `none`
 *   `reason` 说明「这次成功为什么没算验证」（`no_verifier` 等，见 experience-certify）
 */
function observeRun(input = {}) {
  const toolName = String(input.toolName ?? '')
  if (!toolName) return { action: 'none' }
  /*
   * 成功路径上库里空着就直接返回 —— 绝大多数工具调用走这条，
   * 不该为它读一次盘（`exists()` 只看文件大小）。
   */
  if (input.ok === true && !store.exists()) return { action: 'none' }
  const feature = schema.featureOf({
    tool: toolName,
    failure: input.failure ?? null,
    text: input.text ?? input.failure?.hint ?? '',
    args: input.args ?? null,
  })
  const subject = sameSubject(feature)

  if (input.ok !== true) {
    /*
     * ① 已经验证过的经验，同类操作**又失败了** → 有力反例 → 立刻暂停注入。
     *    这一步排在「建候选」之前：一条经验被反例打掉，比再攒一个候选重要得多。
     *    作用域必须对得上（由 store.recordContradiction 判）：乙项目的失败不能打停甲项目的经验。
     */
    const verified = subject.find((item) => item.status === schema.STATUS.VERIFIED)
    if (verified) {
      const hit = store.recordContradiction(verified.id, {
        opportunityId: String(input.opportunityId ?? ''),
        evidence: feature.text,
        projectId: String(input.projectId ?? ''),
        sessionId: String(input.sessionId ?? ''),
      })
      if (hit.ok) return { action: 'suspended', item: store.get(verified.id), suspended: true }
      /* 作用域不匹配：这次失败不属于那条经验 —— 继续走「建候选」 */
    }
    const added = store.addCandidate({
      feature,
      /* 原因假设来自系统侧分类器，不是模型自述 */
      causeHypothesis: String(input.failure?.hint ?? ''),
      risk: schema.riskOf(feature.category, feature.reasonCode),
      scope: input.projectId ? 'project' : 'global',
      projectId: input.projectId ?? '',
      sessionId: input.sessionId ?? '',
    })
    /* ★ 脱敏失败 = 这条故意没记（只留不含原文的诊断，见 store.addCandidate） */
    if (added.ok === false) return { action: 'dropped', reason: added.dropped }
    return { action: added.reproduced ? 'reproduced' : 'candidate', item: added.item }
  }

  /*
   * ② 成功：只在**有同工具同目标的候选**时才算验证。
   *    没有候选就一个字节都不写（绝大多数调用走这条路，别让每次成功都读写一遍库）。
   */
  const candidate = subject.find((item) => item.status === schema.STATUS.CANDIDATE)
  if (!candidate) return { action: 'none' }
  if (Date.now() - Number(candidate.createdAt ?? 0) > schema.VERIFY_WINDOW_MS) {
    /* 太久了：不拿几天后的一次成功去认领一个旧坑 */
    return { action: 'none', reason: 'too_late' }
  }
  const result = certify.certifySuccess({
    item: candidate,
    toolName,
    args: input.args ?? null,
    workdir: String(input.workdir ?? ''),
    ok: input.ok === true,
    facts: input.facts ?? {},
    opportunityId: String(input.opportunityId ?? ''),
    text: feature.text,
    projectId: String(input.projectId ?? ''),
    sessionId: String(input.sessionId ?? ''),
  })
  if (!result.accepted) return { action: 'none', reason: result.reason, item: candidate }
  return {
    /* `adopted` = 第一次认下修法的成功（它同时已经计入一次验证，见 store.recordVerification） */
    action: result.promoted ? 'promoted' : result.reason === 'adopted' ? 'adopted' : 'verified',
    item: store.get(candidate.id),
    promoted: result.promoted,
    reason: result.reason,
  }
}

/**
 * 用户那句「不对」。**只建候选，不进提示**，且永不自动升级（见 schema 白名单）。
 *
 * @param {{ text?: string, projectId?: string, sessionId?: string, messageId?: string }} input
 */
function observeUserCorrection({ text = '', projectId = '', sessionId = '', messageId = '' } = {}) {
  const raw = String(text ?? '')
  if (!schema.looksLikeCorrection(raw)) return { action: 'none' }
  const feature = schema.featureOf({ tool: '', text: raw, category: 'user_correction' })
  /*
   * 目标 = 「哪条对话里的哪一句话」（见 `seenKey` 的注释）。去重键里带它，
   * 两条不同对话里的同一句「不对」就是两条独立的事实；同一条消息重复装配只记一次。
   * 留空时退回「同作用域 + 同文本」的旧口径，不炸（老调用方不必一次改完）。
   */
  if (messageId) feature.target = `${String(sessionId ?? '')}|${String(messageId)}`
  const added = store.addCandidate({
    feature,
    /* 用户的否定是事实本身；他到底要什么，**这一条不猜**（等他说清楚再记） */
    causeHypothesis: '用户明确否定了上一轮的说法或做法',
    risk: 'high', /* 高风险 → 不管白名单怎么写都升不了级，双保险 */
    scope: projectId ? 'project' : 'global',
    projectId,
    sessionId,
  })
  if (added.ok === false) return { action: 'dropped', reason: added.dropped }
  return { action: added.reproduced ? 'reproduced' : 'candidate', item: added.item }
}

/**
 * 一次工具调用结束后的**唯一入口**（`tool-runner` 只调这一个）。
 *   · 更新经验库（`observeRun`）
 *   · 失败时按需取一句「以前遇到过同类情况」（只取相近的 verified）
 *
 * ⚠️ **绝不抛异常**：它挂在每次工具调用后面，自己抛就把工具结果盖掉了
 *    （和 `error-observer` 同一条底线）。
 *
 * @param {{ id?: string, name?: string, args?: object, ok?: boolean, output?: string,
 *           error?: object|null, facts?: object|null }} run  `tool-runner` 的那条记录
 * @param {{ projectId?: string, sessionId?: string, workdir?: string }} [ctx]
 * @returns {{ action: string, note: string, promoted?: boolean, suspended?: boolean, reason?: string }}
 */
function afterRun(run, ctx = {}) {
  const empty = { action: 'none', note: '' }
  const ctxOf = { projectId: String(ctx?.projectId ?? ''), sessionId: String(ctx?.sessionId ?? '') }
  try {
    const result = observeRun({
      toolName: String(run?.name ?? ''),
      args: run?.args ?? null,
      ok: run?.ok === true,
      failure: run?.error ?? null,
      text: String(run?.output ?? ''),
      /* 同一次调用（含它的自动重试）只算一个「执行机会」—— 重试成功不算独立验证 */
      opportunityId: String(run?.id ?? ''),
      /* 独立观察要自己去现场看（文件在不在 / 退出码），工作目录与结构化事实必须传全 */
      workdir: String(ctx?.workdir ?? ''),
      facts: run?.facts ?? null,
      ...ctxOf,
    })
    if (result.action === 'none' || result.action === 'dropped' || result.action === 'adopted') {
      /* 这几种都不给模型加话（`dropped` 连条目都没有；`adopted` 只是记下修法） */
      return { ...empty, action: result.action, reason: result.reason }
    }
    const note =
      run?.ok === true
        ? ''
        : inject.noteForFailure({
            toolName: String(run?.name ?? ''),
            args: run?.args ?? null,
            failure: run?.error ?? null,
            text: String(run?.output ?? ''),
            ...ctxOf,
          })
    return { ...result, note }
  } catch (error) {
    /* 绝不抛（底线），也不能一声不吭 —— 静默会让「真机上根本没接上」看不出来（2026-11-02 就是这样） */
    try {
      log.warn(`经验观察失败（不影响工具结果）：${error instanceof Error ? error.message : error}`)
    } catch {
      /* 日志自己也挂了就算了 */
    }
    return empty
  }
}

/**
 * 每轮提示里的入口（`loop-prompt` 只调这一个）。
 *
 * 顺序有讲究：**先观察用户这句是不是纠正，再取要注入的经验** ——
 * 用户刚说「不对」，这一轮就该看到相关的旧经验；而刚建出来的候选
 * 一个都进不来（注入只认 verified），所以「失败 / 被纠正」不会当场变成规则。
 *
 * @param {{ userText?: string, projectId?: string, sessionId?: string, messageId?: string }} input
 * @returns {string} 没有命中就是空串（不注入空标题）
 */
function sectionFor({ userText = '', projectId = '', sessionId = '', messageId = '' } = {}) {
  const text = String(userText ?? '')
  try {
    if (text) {
      /*
       * 去重只针对**同一条用户消息**（对话 + 消息 id）。没有 messageId 时
       * （老调用方 / 自检）就不去重 —— 宁可多观察一次，也不能把另一条对话里
       * 的相同纠正静默丢掉（反例 4）。
       */
      const key = messageId ? seenKey({ sessionId, messageId }) : ''
      if (!key || markSeen(key)) observeUserCorrection({ text, projectId, sessionId, messageId })
    }
  } catch {
    /* 观察失败不能影响这一轮对话 */
  }
  try {
    return inject.buildSection({ userText: text, projectId, sessionId })
  } catch {
    return ''
  }
}

module.exports = {
  afterRun,
  sectionFor,
  observeRun,
  observeUserCorrection,
  buildSection: inject.buildSection,
  noteForFailure: inject.noteForFailure,
  sameTarget,
  describeRun: certify.describeRun,
  seenKey,
  resetSeen: () => seen.clear(),
}
