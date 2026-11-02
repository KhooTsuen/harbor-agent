/**
 * 经验库的**三个写口**：建候选 · 记验证 · 记反例
 *
 * 从 `experience-store.cjs` 拆出来的（那边贴 300 行红线）。拆的边界：
 * 「读一次盘 / 写一次盘」的机制在 `experience-store-file.cjs`，这里只管
 * **一次执行该怎么落成记录**。对外仍是 `experience-store.cjs` 一个门面。
 *
 * ── 2026-11-02 修的两处（用户点出的反例 2 / 3）──
 * · 去重键与写入口径都带**作用域 + 目标**（`candidateKey` / `guard.scopeAllows`）：
 *   甲项目的 `a.txt` 读不到，和乙项目的同名文件不是一件事；次数也不再跨项目累加。
 * · 脱敏失败**整条不记**（`guard.textDropReason`），只留一句不含原文的诊断。
 */
const log = require('./log.cjs')
const schema = require('./experience-schema.cjs')
const guard = require('./experience-guard.cjs')
const file = require('./experience-store-file.cjs')

/**
 * 去重键：**同一作用域 + 同一工具 + 同一类别 + 同一原因码 + 同一目标 + 同一句归一化文本**
 * 才算同一件事。
 *
 * 加 `scopeKey` 与 `target` 是反例 2 的修法：
 *   · 少了作用域，甲项目 `npm test` 挂了会被乙项目的复现「接力」成同一条；
 *   · 少了目标，同一个文件名的两个不同路径也会被当成一回事。
 */
function candidateKey(feature, input = {}) {
  const scope = ['global', 'project', 'session'].includes(input.scope) ? input.scope : 'global'
  const scopeKey =
    scope === 'project'
      ? `project:${input.projectId ?? ''}`
      : scope === 'session'
        ? `session:${input.sessionId ?? ''}`
        : 'global'
  return [
    scopeKey,
    String(feature?.tool ?? ''),
    String(feature?.category ?? ''),
    String(feature?.reasonCode ?? ''),
    String(feature?.target ?? ''),
    String(feature?.text ?? ''),
  ].join('|')
}

/**
 * 加一条候选（**不注入**）。
 *
 * 同一个触发特征再来一次 = **复现 +1**，不是新条目 —— 复现只证明问题反复出现，
 * 不证明某个修法正确（蓝图 §5.1 的原话），所以它只涨计数、不涨状态。
 *
 * @param {{ feature: object, scope?: string, projectId?: string, sessionId?: string,
 *           causeHypothesis?: string, risk?: string }} input
 * @returns {{ ok: boolean, item?: object, reproduced?: boolean, dropped?: string }}
 *   `dropped` 非空 = 这条**故意没记**（现在是脱敏失败这一种），原因不含原文
 */
function addCandidate(input) {
  const feature = input?.feature ?? {}
  const dropReason = guard.textDropReason(feature)
  if (dropReason) {
    log.warn(
      `经验放弃：${dropReason}（工具=${String(feature.tool ?? '') || '无'}，原文 ${String(feature.text ?? '').length} 字）`,
    )
    return { ok: false, dropped: dropReason }
  }

  const data = file.load()
  const key = candidateKey(feature, input ?? {})
  const known = data.items.find(
    (item) =>
      item.key === key &&
      (item.status === schema.STATUS.CANDIDATE || item.status === schema.STATUS.VERIFIED),
  )
  if (known) {
    known.reproductions = (known.reproductions ?? 1) + 1
    known.lastSeenAt = Date.now()
    file.persist(data)
    return { ok: true, item: known, reproduced: true }
  }

  const now = Date.now()
  const item = {
    id: schema.newId(),
    key,
    /* 作用域显式落进条目（去重键里也有一份同口径的字符串） */
    scope: ['global', 'project', 'session'].includes(input?.scope) ? input.scope : 'global',
    projectId: String(input?.projectId ?? ''),
    sessionId: String(input?.sessionId ?? ''),
    status: schema.STATUS.CANDIDATE,
    /* 触发特征：匹配与验证都读它 */
    tool: String(feature.tool ?? ''),
    domain: String(feature.domain ?? 'other'),
    category: String(feature.category ?? 'tool_failure'),
    reasonCode: String(feature.reasonCode ?? ''),
    /* 验证 / 反例都要求同一个目标 —— 没有它，「随便一个成功」会被当成验证 */
    target: String(feature.target ?? ''),
    triggerText: String(feature.text ?? ''),
    tokens: Array.isArray(feature.tokens) ? feature.tokens : [],
    /* 原因假设来自分类器（系统侧），**不是模型自述** —— 出处记在 causeSource */
    causeHypothesis: String(input?.causeHypothesis ?? ''),
    causeSource: input?.causeHypothesis ? 'classifier' : '',
    recommendedAction: '',
    /* 修法签名：第一次被独立核实成功时才写进来（见 recordVerification） */
    recipe: { key: '', evidence: '', adoptedAt: 0 },
    risk: input?.risk === 'high' ? 'high' : 'low',
    validatorId: schema.VALIDATOR.id,
    validatorVersion: schema.VALIDATOR.version,
    reproductions: 1,
    verifications: [],
    contradictions: [],
    injectedCount: 0,
    lastInjectedAt: 0,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    history: [{ at: now, from: '', to: schema.STATUS.CANDIDATE, why: '真实执行里观察到失败' }],
  }

  data.items.push(item)
  file.trim(data)
  file.persist(data)
  return { ok: true, item }
}

/**
 * 记一次**独立**成功验证。
 *
 * 三条前置（任一不过就整次不算）：
 *   ① 作用域对得上 —— 乙项目的成功不算甲项目经验的验证
 *   ② 同一个 `opportunityId` 只算一次 —— 自动重试成功不计数
 *   ③ 做法对得上：条目还没认修法 → 这次只**探明修法**（`adopted`），不计数；
 *      做法不同 → 直接拒（`different_recipe`）
 *
 * 升级阈值只数**同一个项目作用域内**的验证（`schema.verificationsIn`）。
 *
 * @param {string} id
 * @param {{ opportunityId?: string, evidence?: string, at?: number, projectId?: string,
 *           sessionId?: string, recipeKey?: string, verifier?: string }} input
 * @returns {{ ok: boolean, item?: object, promoted?: boolean, adopted?: boolean,
 *             counted?: number, error?: string }}
 */
function recordVerification(id, input = {}) {
  const { opportunityId, evidence = '', at = Date.now(), projectId = '', sessionId = '', recipeKey = '' } = input
  const data = file.load()
  const item = data.items.find((entry) => entry.id === id)
  if (!item) return { ok: false, error: '经验不存在' }
  if (!guard.scopeAllows(item, { projectId, sessionId })) {
    return { ok: false, error: '作用域不匹配：这次成功不算这条经验的验证' }
  }
  if (!schema.isIndependent(item.verifications, opportunityId)) {
    return { ok: false, error: '同一次执行机会不重复计数' }
  }

  /* ③ 修法：没认过就**认下这一次**（它同样是独立观察核过的成功，所以计入）；
     认过但不一致 → 不是同一套做法，不算。 */
  const state = guard.recipeState(item, recipeKey)
  if (state === 'different') return { ok: false, error: '做法不同：这次成功不是这条修法的验证' }
  const adopted = state === 'unset'
  if (adopted) {
    if (!recipeKey) return { ok: false, error: '这次成功没有可辨识的做法，不能当作修法' }
    item.recipe = { key: String(recipeKey), evidence: String(evidence).slice(0, 200), adoptedAt: at }
    item.history = Array.isArray(item.history) ? item.history : []
    item.history.push({ at, from: item.status, to: item.status, why: '首次独立核实：记下这条修法（这次成功也计入验证）' })
  }

  item.verifications.push({
    opportunityId: String(opportunityId),
    at,
    evidence: String(evidence).slice(0, 200),
    /* ★ 这次验证属于哪个项目 / 会话：阈值按作用域数，不跨项目累加 */
    projectId: String(projectId ?? ''),
    sessionId: String(sessionId ?? ''),
    verifier: String(input.verifier ?? '').slice(0, 40),
    /* 这一次是「首次认下修法」那一次 —— 留痕，便于解释「凭什么算同名做法」 */
    ...(adopted ? { adopted: true } : {}),
  })
  item.updatedAt = at
  const counted = schema.verificationsIn(item, projectId).length

  /*
   * 升级的五个条件缺一不可：
   *   ① 状态是 candidate（已经 verified / suspended 的不再因成功而变）
   *   ② 同一项目作用域内独立验证达到门槛
   *   ③ 不是高风险 —— 高风险要人批（下一切片才有审批档位，这一轮就停在 candidate）
   *   ④ 类别在白名单里（`user_correction` / `external_blocked` 永不自动升，见 schema）
   *   ⑤ 状态机能走这一步
   */
  let promoted = false
  if (
    item.status === schema.STATUS.CANDIDATE &&
    counted >= schema.VERIFY_THRESHOLD &&
    item.risk !== 'high' &&
    schema.AUTO_PROMOTE_CATEGORIES.has(item.category) &&
    schema.canMove(item.status, schema.STATUS.VERIFIED)
  ) {
    file.recordMove(item, item.status, schema.STATUS.VERIFIED, `同一做法独立验证 ${counted} 次`)
    /*
     * 修法只认**真跑成了的那一次**：`evidence` 是那次成功的操作摘要（系统侧记的），
     * 不是模型事后写的解释。为空就留空 —— 注入时会如实说「只知道这样做成功过」。
     */
    if (!item.recommendedAction && evidence) item.recommendedAction = String(evidence).slice(0, 120)
    promoted = true
  }
  file.persist(data)
  return { ok: true, item, promoted, counted, adopted }
}

/**
 * 记一次**反例**（同类操作在已验证之后又失败了）→ 立刻暂停注入。
 *
 * 作用域必须对得上：乙项目里同样的失败，不能把甲项目那条经验打停。
 *
 * @param {{ opportunityId?: string, evidence?: string, validatorStale?: boolean,
 *           projectId?: string, sessionId?: string }} input
 */
function recordContradiction(id, input = {}) {
  const { opportunityId = '', evidence = '', validatorStale = false, projectId = '', sessionId = '' } = input
  const data = file.load()
  const item = data.items.find((entry) => entry.id === id)
  if (!item) return { ok: false, error: '经验不存在' }
  if (!guard.scopeAllows(item, { projectId, sessionId })) {
    return { ok: false, error: '作用域不匹配：这次失败不算这条经验的反例' }
  }
  item.contradictions.push({
    opportunityId: String(opportunityId),
    at: Date.now(),
    evidence: String(evidence).slice(0, 200),
    projectId: String(projectId ?? ''),
    sessionId: String(sessionId ?? ''),
  })
  item.updatedAt = Date.now()

  let suspended = false
  if (item.status === schema.STATUS.VERIFIED && schema.canMove(item.status, schema.STATUS.SUSPENDED)) {
    file.recordMove(
      item,
      item.status,
      schema.STATUS.SUSPENDED,
      validatorStale ? '验证器版本失效' : '出现有力反例：同类操作再次失败',
    )
    suspended = true
  }
  file.persist(data)
  return { ok: true, item, suspended }
}

module.exports = { candidateKey, addCandidate, recordVerification, recordContradiction }
