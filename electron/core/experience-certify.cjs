/**
 * 成功路径的编排：**一条成功什么时候能算「修法已验证」**
 *
 * ── 反例 1 治的是什么（用户 2026-11-02 原话）──
 *
 * 「后续同工具、同目标的成功，不能直接算作候选经验的『修法已验证』。」
 *
 * 旧实现在 `experience-loop.observeRun` 里：只要库里有同工具同目标的 candidate，
 * 任何一次 `ok === true` 就 `recordVerification` 一次。于是三件事都能把它顶成规则：
 *   · **环境自己好了**（文件后来被建出来了 / 站点恢复了）—— 什么都没「修」；
 *   · **模型自述**（`run.ok` 由工具自己声明，`afterRun` 原样采信）；
 *   · **别的地方的成功**（同工具同目标但完全另一码事）。
 *
 * 现在要求两条，缺一不可：
 *
 *   ① **证明采用了该修法**（`adopt` / `match`）：
 *      条目还没认过修法时，成功只能**探明**它（`schema.recipeOf` 记下「用的是哪套做法」），
 *      这一下**不计数**；之后要**同一套做法**再成功，才算验证。
 *      换了做法（文件类换了工具、shell 换了命令、网页换了站点路径形状）→ 直接不算。
 *   ② **结果由独立观察确认**（`experience-verify.certify`）：
 *      验证器拿着参数去现场看 —— 文件真在不在、进程退出码是不是 0。
 *      它**不读 `run.ok`**，也不读模型说的话。
 *      没有验证器的工具（`browse` / `edge_*` / `search_web` 等）一律 `no_verifier`，
 *      那条经验**留在 candidate**，永不注入。
 *
 * 返回值里的 `reason` 就是「为什么没算」：`no_verifier` / `observer_rejected` /
 * `different_recipe` / `no_recipe` / `duplicate` / `adopted`。自检 `195` 逐条钉着。
 */
const schema = require('./experience-schema.cjs')
const store = require('./experience-store.cjs')
const verifier = require('./experience-verify.cjs')

/** 一次成功操作的人话摘要（升级后就是那条经验的「推荐做法」） */
function describeRun(toolName, args, text) {
  const data = args ?? {}
  const bits = []
  if (typeof data.command === 'string') bits.push(`\`${data.command.slice(0, 80)}\``)
  if (typeof data.path === 'string') bits.push(data.path.slice(0, 80))
  if (typeof data.url === 'string') bits.push(data.url.slice(0, 80))
  if (bits.length === 0) bits.push(String(text ?? '').slice(0, 60))
  return `${toolName} ${bits.join(' ')}`.trim()
}

/**
 * 给一次成功下结论并按结论落账。
 *
 * @param {{ item?: object, toolName?: string, args?: object|null, workdir?: string,
 *           ok?: boolean, facts?: object, opportunityId?: string, text?: string,
 *           projectId?: string, sessionId?: string }} input
 * @returns {{ accepted: boolean, counted: boolean, promoted: boolean, reason: string,
 *             evidence: string, verifier: string }}
 *   `accepted` = 这次成功被验证器独立核实；`reason` 是 `adopted`（首次认下修法）
 *   或 `verified`（同修法又一次被核实）。不通过时 `accepted:false`，原因见文件头。
 */
function certifySuccess(input = {}) {
  const item = input.item ?? {}
  const toolName = String(input.toolName ?? '')
  const nothing = (reason) => ({ accepted: false, counted: false, promoted: false, reason, evidence: '', verifier: '' })

  /* ② 独立观察：没有验证器就没有结论 —— 这条经验留在 candidate */
  const verdict = verifier.certify({
    toolName,
    args: input.args ?? null,
    workdir: String(input.workdir ?? ''),
    ok: input.ok === true,
    facts: input.facts ?? {},
  })
  if (!verdict.accepted) return { ...nothing(verdict.reason), verifier: verdict.verifier }

  /* ① 采用修法：签名必须在场（同工具、同目标但换做法 = 不是这条经验的验证） */
  const recipeKey = schema.recipeOf(toolName, input.args ?? null)
  if (!recipeKey) return { ...nothing('no_recipe'), verifier: verdict.verifier }

  const evidence = describeRun(toolName, input.args, input.text)
  const result = store.recordVerification(item.id, {
    opportunityId: String(input.opportunityId ?? ''),
    evidence,
    projectId: String(input.projectId ?? ''),
    sessionId: String(input.sessionId ?? ''),
    recipeKey,
    verifier: verdict.verifier,
  })
  if (!result.ok) {
    /* 作用域不对 / 重复机会 / 做法不同 / 没认修法 —— 原因原样往上报，别吞 */
    const reason = String(result.error ?? 'rejected')
    const mapped = reason.includes('做法不同')
      ? 'different_recipe'
      : reason.includes('重复计数')
        ? 'duplicate'
        : reason.includes('作用域')
          ? 'scope_mismatch'
          : 'rejected'
    return { ...nothing(mapped), evidence: verdict.evidence, verifier: verdict.verifier }
  }
  return {
    accepted: true,
    counted: true,
    promoted: result.promoted === true,
    reason: result.adopted === true ? 'adopted' : 'verified',
    /* 证据用验证器自己看到的那句话，不是模型的解释 */
    evidence: verdict.evidence,
    verifier: verdict.verifier,
  }
}

module.exports = { certifySuccess, describeRun }
