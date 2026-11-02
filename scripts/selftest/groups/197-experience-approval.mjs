/**
 * 自检 / 审批档位（蓝图 §7）—— **人**决定一条候选能不能变成规则
 *
 * 这一组钉的是「那道门本身」，不是「界面好不好看」：
 *
 *   ① 没有审批档位时，用户纠正 / 权限类 / 外部阻塞**永远升不上去**（先复刻这个洞）
 *   ② 人批准之后它真的进提示，且**同一条 pipeline**（`match.pick`）认它
 *   ③ 批准必须有可注入的做法 —— 空壳批准被拒（`needs_action`），不是悄悄放行
 *   ④ 批准不绕过分类白名单：批的是**这一条**，不是「以后这类都自动升」
 *   ⑤ 被反例打停的可以**人工恢复**，恢复不清零反例、再出同类反例立刻再停
 *   ⑥ 驳回是终点：不能再批回来（留痕不能是笑话）
 *   ⑦ 每条动作都留痕（history + 审计），且审计里**不含经验原文**
 *   ⑧ 判据只有一处：`schema.injectable`（人批的不看验证器版本）
 *
 * 全程用隔离数据（准备阶段已把 DIRS.data 指到 unit-test-data）。
 */

import { check, group } from '../harness.mjs'
import { ROOT, join, require } from '../env.mjs'

export async function run() {
  const schema = require(join(ROOT, 'electron/core/experience-schema.cjs'))
  const store = require(join(ROOT, 'electron/core/experience-store.cjs'))
  const match = require(join(ROOT, 'electron/core/experience-match.cjs'))
  const audit = require(join(ROOT, 'electron/core/audit.cjs'))
  const loop = require(join(ROOT, 'electron/core/experience-loop.cjs'))

  const PROJECT = 'proj-approve-197'
  const CMD = 'npm test'
  const FAIL = { tool: 'run_shell', reasonCode: 'EXIT_CODE', category: 'tool_failure' }

  const clean = () => store.clear()
  /** 建一条候选（真的走生产入口的建条目那一半） */
  const seed = ({ tool = 'run_shell', category = 'tool_failure', text = `命令失败：${CMD}`, reason = 'EXIT_CODE' } = {}) =>
    store.addCandidate({
      feature: schema.featureOf({ tool, category, failure: { reasonCode: reason }, text, args: { command: CMD } }),
      scope: 'project',
      projectId: PROJECT,
      causeHypothesis: '退出码非 0',
    }).item

  /* ══════════════════════════════════════════════════════════
     ① 先复刻旧行为：没有审批档位时，这些条目永远升不上去
     ══════════════════════════════════════════════════════════ */
  group('审批 / ① 没有审批档位时，这些经验永远停在 candidate')
  clean()

  /*
   * 复刻：`AUTO_PROMOTE_CATEGORIES` 只有 tool_failure / assertion_failed，
   * 且 user_correction 与高风险类别即使被独立验证 3 次也不升。
   */
  check(
    '★ 复刻旧洞：用户纠正不在自动升级白名单里',
    !schema.AUTO_PROMOTE_CATEGORIES.has('user_correction'),
  )
  check('★ 复刻旧洞：外部阻塞也不在', !schema.AUTO_PROMOTE_CATEGORIES.has('external_blocked'))

  /* 用生产入口（`loop.observeUserCorrection`）造，不手搓 —— 夹具必须用生产方的形状，
     自己拼一个「差不多」的对象，就会漏掉它顺手做的那些事（比如标 high 风险） */
  const correctedResult = loop.observeUserCorrection({
    text: '不对，这个不对',
    projectId: PROJECT,
    sessionId: 'sess-197',
    messageId: 'msg-197-1',
  })
  const corrected = store.get(correctedResult.item?.id ?? '')
  check('用户纠正建出了候选', Boolean(corrected))
  check('★ 它被标成高风险（人喊过停的事）', corrected?.risk === 'high', String(corrected?.risk))

  /* 就算硬塞三次「验证」（模拟之后碰巧成功），也不该升 */
  let promoted = false
  for (let i = 0; i < 4; i += 1) {
    const result = store.recordVerification(corrected.id, {
      opportunityId: `opp-${i}`,
      evidence: '同一条命令成功了',
      projectId: PROJECT,
      recipeKey: 'run_shell|npm test',
    })
    if (result.promoted) promoted = true
  }
  check('★★ 复刻旧洞：四次独立成功之后**仍然是 candidate**（永远升不上去）', !promoted)
  check('★★ 因此它也永远不进提示（这是要修的问题：人知道的答案进不来）', match.pick({
    facts: match.factsOfText('这个不对'),
    projectId: PROJECT,
  }).length === 0)

  /* ══════════════════════════════════════════════════════════
     ② 人的批准是唯一能抬它的路
     ══════════════════════════════════════════════════════════ */
  group('审批 / ② 人批准之后它真的进提示（走同一条 pipeline）')

  const approve = store.review(corrected.id, {
    action: 'approve',
    actionText: '先问清楚他指的是哪一处，再动手',
    note: '2026-11-02 试跑',
  })
  check('★ 批准成功', approve.ok === true, JSON.stringify(approve.error ?? ''))
  check('状态变成 verified', approve.item?.status === schema.STATUS.VERIFIED, String(approve.item?.status))
  check('★ 做法写进了条目（注入时就是这句）', approve.item?.recommendedAction === '先问清楚他指的是哪一处，再动手')
  check('★ 批准记着是谁批的', approve.item?.approval?.by === 'user', JSON.stringify(approve.item?.approval ?? null))

  const picked = match.pick({ facts: match.factsOfText('这个不对'), projectId: PROJECT })
  check('★★ 它现在真的会被召回（同一条 match.pick）', picked.length >= 1, `命中 ${picked.length} 条`)
  check('★★ 召回里带的就是人写的做法', String(picked[0]?.item?.recommendedAction ?? '').includes('先问清楚'))

  const section = loop.sectionFor({ userText: '这个不对吧', projectId: PROJECT, sessionId: '' })
  check('★★ 提示那一段里真的出现了（端到端装配）', typeof section === 'string' && section.includes('先问清楚'))

  /* ══════════════════════════════════════════════════════════
     ③ 空壳批准被拒：没有做法就没有可注入的东西
     ══════════════════════════════════════════════════════════ */
  group('审批 / ③ 没有可注入的做法 ⇒ 拒绝批准（needs_action）')

  const empty = seed({ text: '另一条：命令失败了' })
  const bare = store.review(empty.id, { action: 'approve' })
  check('★★ 拒绝批准（ok:false）', bare.ok === false, String(bare.error ?? ''))
  check('★ 原因是 needs_action（机器可读）', bare.reason === 'needs_action', String(bare.reason))
  check('★ 状态没被改动（还是 candidate）', store.get(empty.id)?.status === schema.STATUS.CANDIDATE)

  const filled = store.review(empty.id, { action: 'approve', actionText: '先 list_dir 看目录再读' })
  check('★ 补上那句之后就能批了', filled.ok === true && filled.item?.status === schema.STATUS.VERIFIED)

  /* ══════════════════════════════════════════════════════════
     ④ 批的是「这一条」，不是「以后这类都自动升」
     ══════════════════════════════════════════════════════════ */
  group('审批 / ④ 批准不绕过分类白名单（不是「以后这类都放行」）')

  const another = seed({ tool: '', category: 'user_correction', text: '又一句纠正：不是这样', reason: '' })
  check('同类的新条目仍然是 candidate', another?.status === schema.STATUS.CANDIDATE)
  check(
    '★ 上一条的批准没有把它也带上去',
    !match.pick({ facts: match.factsOfText('不是这样'), projectId: PROJECT }).some(
      (entry) => entry.item.id === another?.id,
    ),
  )
  check(
    '★ 分类白名单原样没动（批准不改 schema）',
    schema.AUTO_PROMOTE_CATEGORIES.size === 2 &&
      !schema.AUTO_PROMOTE_CATEGORIES.has('user_correction'),
  )

  /* ══════════════════════════════════════════════════════════
     ⑤ 反例打停 → 人工恢复 → 再出同类反例立刻再停
     ══════════════════════════════════════════════════════════ */
  group('审批 / ⑤ 被反例打停的可以人工恢复，但反例记录不清零')

  const suspended = store.review(corrected.id, { action: 'reject' })
  /* reject 是终点，先把这一条从后续步骤里挪开：用一条新的做「反例 → 恢复」 */
  check('（准备）驳回是终点，先确认它被拒得不能再动', store.review(corrected.id, { action: 'approve' }).ok === false)
  check('（准备）驳回后不再注入', !match.pick({ facts: match.factsOfText('这个不对'), projectId: PROJECT }).some((e) => e.item.id === corrected.id))
  void suspended

  /* 新造一条：批准 → 打停 → 恢复 */
  const victim = seed({ text: '第三条：跑测试失败了' })
  store.review(victim.id, { action: 'approve', actionText: '先看 logout 那一行' })
  const contradiction = store.recordContradiction(victim.id, {
    opportunityId: 'opp-contra-1',
    evidence: '同一条命令又失败了',
    projectId: PROJECT,
  })
  check('★ 反例把它打停（suspended）', contradiction.suspended === true)
  check('★★ 打停之后不注入', !match.pick({ facts: match.factsOfText('跑测试失败了'), projectId: PROJECT }).some((e) => e.item.id === victim.id))

  const restored = store.review(victim.id, { action: 'restore', note: '那次失败是网络问题' })
  check('★ 人工恢复成功（suspended → verified）', restored.ok === true, String(restored.error ?? ''))
  check('状态回到 verified', restored.item?.status === schema.STATUS.VERIFIED)
  check(
    '★★ 反例记录**没有被清掉**（恢复的是状态，不是历史）',
    (restored.item?.contradictions?.length ?? 0) === 1,
    String(restored.item?.contradictions?.length),
  )
  check('★ 恢复也留了痕（哪次、谁、为什么）', restored.item?.approval?.action === 'restore')

  const again = store.recordContradiction(victim.id, {
    opportunityId: 'opp-contra-2',
    evidence: '同一条命令第三次失败',
    projectId: PROJECT,
  })
  check('★★ 恢复之后再出同类反例，立刻再停（不会因为人批过一次就免疫）', again.suspended === true)

  /* ══════════════════════════════════════════════════════════
     ⑥ 状态机不许乱走
     ══════════════════════════════════════════════════════════ */
  group('审批 / ⑥ 状态机：驳回是终点，candidate 不能直接「恢复」')

  const dead = store.review(victim.id, { action: 'reject' })
  check('驳回成功', dead.ok === true)
  check('★ 驳回之后不能再批准（终点状态）', store.review(victim.id, { action: 'approve', actionText: 'x' }).ok === false)
  check('★ 驳回之后也不能再恢复', store.review(victim.id, { action: 'restore' }).ok === false)
  check(
    '★ candidate 谈不上「恢复」（只有被打停的才需要）',
    store.review(another.id, { action: 'restore' }).ok === false,
  )
  check('★ 不认识的动作被拒（不是静默成功）', store.review(another.id, { action: '随便' }).ok === false)

  /* ══════════════════════════════════════════════════════════
     ⑦ 留痕：history + 审计，审计不含原文
     ══════════════════════════════════════════════════════════ */
  group('审批 / ⑦ 每次审批都留痕，审计里没有经验原文')

  const traced = seed({ text: '第四条：一条会失败的命令' })
  store.review(traced.id, { action: 'approve', actionText: '换成绝对路径再跑', note: '备注里有个密钥 sk-197aaaa' })
  const after = store.get(traced.id)
  check(
    '★ history 记了这次迁移（from/to/why 都在）',
    (after?.history ?? []).some((entry) => String(entry.why).includes('人工批准')),
    JSON.stringify((after?.history ?? []).map((entry) => entry.why)).slice(0, 160),
  )

  const day = new Date().toISOString().slice(0, 10)
  const rows = audit.read({ day, limit: 500 })
  const ours = rows.filter((row) => String(row.tool ?? '').startsWith('experience:'))
  check('★ 审计里有这次审批（tool=experience:approve）', ours.some((row) => row.tool === 'experience:approve'))
  check('★ 审计记着批的是哪一条', ours.some((row) => row.extras?.experienceId === traced.id))
  const dump = JSON.stringify(ours)
  check('★★ 审计里**没有**那条经验的原文', !dump.includes('一条会失败的命令'))
  check('★★ 审计里也没有备注里的那段密钥', !dump.includes('sk-197aaaa'))

  /* ══════════════════════════════════════════════════════════
     ⑧ 判据只有一处：人批的不看验证器版本
     ══════════════════════════════════════════════════════════ */
  group('审批 / ⑧ 「能不能注入」只有一处判据（人批的不看验证器版本）')

  const human = store.get(traced.id)
  check('★ 人批的条目 injectable 为真', schema.injectable(human) === true)
  const stale = { ...human, validatorVersion: schema.VALIDATOR.version + 99 }
  check(
    '★★ 验证器版本变了，**人批的仍然生效**（批的是建议本身，不是观察方式）',
    schema.injectable(stale) === true,
  )
  const sysUp = { ...human, approval: null, validatorVersion: schema.VALIDATOR.version + 99 }
  check(
    '★★ 系统自动升的，验证器版本一变就失效（两条口径确实不同）',
    schema.injectable(sysUp) === false,
  )
  check(
    '★ candidate 无论怎样都不注入',
    schema.injectable({ ...human, status: schema.STATUS.CANDIDATE }) === false,
  )
  check(
    '★ 界面拿到的 injectable 就是这一处的结论（store 不再算第二遍）',
    store.listForReview({ includeClosed: true }).every((item) => item.injectable === schema.injectable(item)),
  )

  clean()
}
