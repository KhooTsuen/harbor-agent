/**
 * 自检 / 经验生命周期（自我纠错 · 阶段 C 的第一刀）
 *
 * ── 这一组钉的是一条底线 ──
 *
 * **一次失败不能变成规则。** 以前 Harbor 没有任何「从失败里学东西」的机制，
 * 所以这条底线是新的，也是这套机制里唯一会改变模型行为的动作 —— 必须钉死：
 *
 *   ① 失败只建 `candidate`，而 `candidate` **一个都进不了提示**
 *   ② 升级要**独立**成功验证（同一次调用的自动重试不算）
 *   ③ 高风险类别 / 用户纠正 / 外部阻塞**永不自动升级**
 *   ④ 出现反例立刻 `suspended` 并停止注入
 *   ⑤ 验证器版本变了 → 旧批准失效（蓝图 §8）
 *   ⑥ 项目作用域的经验，别的项目看不见（判据复用 `memory-scope`）
 *
 * 端到端那三条（文件 / 网页 / 用户纠正真跑一遍）在 `194-experience-e2e.mjs`，
 * 这里只管「判据本身对不对」。
 */

import { check, group } from '../harness.mjs'
import { join, require, ROOT } from '../env.mjs'

const LONG = 'selftest-193'

export async function run() {
  const schema = require(join(ROOT, 'electron/core/experience-schema.cjs'))
  const store = require(join(ROOT, 'electron/core/experience-store.cjs'))
  const match = require(join(ROOT, 'electron/core/experience-match.cjs'))
  const loop = require(join(ROOT, 'electron/core/experience-loop.cjs'))
  const failure = require(join(ROOT, 'electron/core/tool-failure.cjs'))

  /* 每条自检从空库开始 —— 上一组写进来的东西不该影响这一组 */
  store.clear()

  /* ── ① 状态机：只允许该发生的迁移 ── */
  group('经验生命周期 / ① 状态机')
  check('candidate → verified 允许（独立验证达标）', schema.canMove('candidate', 'verified'))
  check('verified → suspended 允许（出现反例）', schema.canMove('verified', 'suspended'))
  check('★ candidate → suspended **不允许**（没生效的东西谈不上暂停）', !schema.canMove('candidate', 'suspended'))
  check('★ verified → candidate **不允许**（不许悄悄降级掩盖问题）', !schema.canMove('verified', 'candidate'))
  check('rejected / deprecated 是终点（只能靠人改）', !schema.canMove('rejected', 'verified') && !schema.canMove('deprecated', 'candidate'))
  check(
    '★ 只有 verified 可注入（这一处就是「失败不成规则」的闸）',
    schema.INJECTABLE.size === 1 && schema.INJECTABLE.has('verified'),
  )

  /* ── ② 观察：失败 → candidate，而 candidate 不进提示 ── */
  group('经验生命周期 / ② 失败只建候选，候选不进提示')
  const failFact = failure.of({
    toolName: 'read_file',
    ok: false,
    output: '错误：文件不存在：selftest-193/a.txt',
  })
  const born = loop.observeRun({
    toolName: 'read_file',
    args: { path: `${LONG}/a.txt` },
    ok: false,
    failure: failFact,
    text: '错误：文件不存在：selftest-193/a.txt',
    opportunityId: 'call_193_born',
  })
  check('★ 真失败建出 candidate（不是 verified）', born.action === 'candidate' && born.item?.status === 'candidate')
  check('候选带着原因码（FILE_NOT_FOUND，系统侧事实）', born.item?.reasonCode === 'FILE_NOT_FOUND')
  check(
    '★ 候选里有目标（验证 / 反例都要求同一个目标）',
    born.item?.target === `${LONG}/a.txt`.toLowerCase(),
    String(born.item?.target),
  )
  check(
    '★★ 候选**不进**每轮提示（失败没有直接变成规则）',
    loop.buildSection({ userText: 'selftest-193/a.txt' }) === '',
  )
  check(
    '★★ 候选也不进「以前遇到过同类」那句',
    loop.noteForFailure({ toolName: 'read_file', args: { path: `${LONG}/a.txt` }, failure: failFact, text: '错误：文件不存在：selftest-193/a.txt' }) === '',
  )

  /* ── ③ 复现只涨计数、不涨状态 ── */
  group('经验生命周期 / ③ 复现 ≠ 验证')
  const again = loop.observeRun({
    toolName: 'read_file',
    args: { path: `${LONG}/a.txt` },
    ok: false,
    failure: failFact,
    text: '错误：文件不存在：selftest-193/a.txt',
    opportunityId: 'call_193_again',
  })
  check('★ 同一件事再来一次 = 复现 +1（不是新条目）', again.action === 'reproduced' && again.item?.reproductions === 2)
  check('★ 复现之后仍然是 candidate（复现不证明修法正确）', again.item?.status === 'candidate')
  check('库里只有一条（没有因为复现而膨胀）', store.load().items.length === 1)

  /* ── ④ 独立验证：先认修法，之后同修法的独立成功才计数 ── */
  group('经验生命周期 / ④ 独立验证计数（先认修法，同一次重试不算）')
  const id = born.item.id
  /*
   * 2026-11-02 语义收紧（反例 1）：第一次成功**同时认下「用的是哪套做法」并计入验证**
   * —— 它被验证器独立核实过；但之后只有**同一套做法**的成功才算，换做法一律不算。
   * 以前是「任何 ok=true 都算」，那才是把巧合当证据。
   */
  const adopt = store.recordVerification(id, {
    opportunityId: 'call_x',
    evidence: 'read_file 成功读出 a.txt',
    recipeKey: 'read_file',
  })
  check('★ 第一次成功认下修法（adopted）', adopt.ok === true && adopt.adopted === true)
  check('它就记了 1 次验证（这一次被独立观察核实过）', store.get(id)?.verifications.length === 1)
  const other = store.recordVerification(id, { opportunityId: 'call_w', evidence: '换个命令', recipeKey: 'run_shell|dir' })
  check('★ 换了做法的成功**不算**这条修法的验证', other.ok === false, String(other.error))
  const dup = store.recordVerification(id, { opportunityId: 'call_x', evidence: 'read_file ok', recipeKey: 'read_file' })
  check('★ 同一个 opportunityId 第二次**不计数**（自动重试成功不算独立验证）', dup.ok === false)
  store.recordVerification(id, { opportunityId: 'call_y', evidence: 'read_file ok', recipeKey: 'read_file' })
  check('两次同修法成功还不够（阈值 3）', store.get(id)?.status === 'candidate' && schema.VERIFY_THRESHOLD === 3)
  const third = store.recordVerification(id, {
    opportunityId: 'call_z',
    evidence: 'read_file 成功读出 a.txt',
    recipeKey: 'read_file',
  })
  check('★ 第三次同修法成功升级为 verified', third.promoted === true && store.get(id)?.status === 'verified')
  check(
    '升级历史留了痕（「为什么开始注入」查得到）',
    (store.get(id)?.history ?? []).some((h) => h.to === 'verified'),
  )
  const recalledSection = loop.buildSection({ userText: '又是那个 selftest-193/a.txt：错误：文件不存在' })
  check(
    '★ 升级后它**进得了**提示（用户复述同一情形时按需召回）',
    recalledSection.includes('已验证的经验') && recalledSection.includes('文件不存在'),
    recalledSection.slice(0, 160),
  )

  /* ── ⑤ 反例：同类又失败 → 立刻暂停注入 ── */
  group('经验生命周期 / ⑤ 出现反例立刻暂停')
  const bad = loop.observeRun({
    toolName: 'read_file',
    args: { path: `${LONG}/a.txt` },
    ok: false,
    failure: failFact,
    text: '错误：文件不存在：selftest-193/a.txt',
    opportunityId: 'call_193_contra',
  })
  check('★ 反例被识别（不是又建一个候选）', bad.action === 'suspended' && bad.suspended === true)
  check('状态变成 suspended', store.get(id)?.status === 'suspended')
  check('反例被记账（谁、哪次、证据）', (store.get(id)?.contradictions ?? []).length === 1)
  check(
    '★★ 暂停之后**不再注入**（提示里那条消失了）',
    loop.buildSection({ userText: '又是那个 selftest-193/a.txt：错误：文件不存在' }) === '',
  )
  check(
    '★ 也不再出现在失败提示里',
    loop.noteForFailure({ toolName: 'read_file', args: { path: `${LONG}/a.txt` }, failure: failFact, text: 'x' }) === '',
  )
  check(
    '调查记录还在（暂停 ≠ 删除，用户能查）',
    store.list({ includeClosed: true }).some((item) => item.id === id),
  )

  /* ── ⑥ 高风险 / 用户纠正永不自动升级 ── */
  group('经验生命周期 / ⑥ 高风险与用户纠正不自动升级')
  store.clear()
  const denied = loop.observeRun({
    toolName: 'run_shell',
    args: { command: 'format c:' },
    ok: false,
    failure: failure.of({ toolName: 'run_shell', ok: false, output: '用户拒绝了这个操作', denied: true }),
    text: '用户拒绝了这个操作',
    opportunityId: 'call_193_denied',
  })
  check('被拒的操作也建候选（不再重复问同一个问题）', denied.action === 'candidate')
  check('★ 被拒的这类被标成高风险（人已经喊过停）', denied.item?.risk === 'high', String(denied.item?.risk))
  for (const round of ['a', 'b', 'c', 'd']) {
    store.recordVerification(denied.item.id, {
      opportunityId: `call_deny_${round}`,
      evidence: 'ok',
      recipeKey: 'run_shell|format c:',
    })
  }
  check(
    '★★ 高风险类别多次成功也**不升级**（要人批 —— 审批档位是下一切片）',
    store.get(denied.item.id)?.status === 'candidate',
    String(store.get(denied.item.id)?.status),
  )

  const corrected = loop.observeUserCorrection({ text: '不对，这不是我要的那个文件', messageId: 'm193-a' })
  check('用户纠正被识别成候选', corrected.action === 'candidate' && corrected.item?.category === 'user_correction')
  for (const round of ['a', 'b', 'c', 'd']) {
    store.recordVerification(corrected.item.id, { opportunityId: `call_fix_${round}`, evidence: 'ok', recipeKey: 'read_file' })
  }
  check(
    '★★ 用户纠正**永不自动升级**（该怎么做对只有人能定）',
    store.get(corrected.item.id)?.status === 'candidate',
    String(store.get(corrected.item.id)?.status),
  )
  check(
    '★ 同一条消息重复观察 = 复现 +1（不是新条目）',
    loop.observeUserCorrection({ text: '不对，这不是我要的那个文件', messageId: 'm193-a' }).action === 'reproduced',
  )

  /* ── ⑦ 验证器版本失效 → 旧批准作废 ── */
  group('经验生命周期 / ⑦ 验证器版本一变，旧批准失效')
  store.clear()
  const { item: stale } = store.addCandidate({
    feature: schema.featureOf({ tool: 'browse', text: '目标按钮没找到', category: 'tool_failure' }),
    risk: 'low',
  })
  /* 先探明修法，再两次同修法成功 —— 三次记录、两次计数（见反例 1 的语义） */
  for (const round of ['a', 'b', 'c']) {
    store.recordVerification(stale.id, { opportunityId: `call_browse_${round}`, evidence: 'ok', recipeKey: 'browse|a.com|/x' })
  }
  check('低风险 + 探明修法后两次成功 → verified', store.get(stale.id)?.status === 'verified')
  check('★ 正常时它会被匹配到', match.pick({ facts: { tool: 'browse', text: '目标按钮没找到' } }).length === 1)
  const raw = store.load()
  raw.items.find((entry) => entry.id === stale.id).validatorVersion = schema.VALIDATOR.version + 1
  require('node:fs').writeFileSync(store.filePath(), JSON.stringify(raw, null, 2))
  check(
    '★★ 验证器版本不匹配 → 不再注入（蓝图 §8：版本变动后失去批准状态）',
    match.pick({ facts: { tool: 'browse', text: '目标按钮没找到' } }).length === 0,
  )

  /* ── ⑧ 项目作用域：别的项目看不见 ── */
  group('经验生命周期 / ⑧ 项目隔离（判据复用 memory-scope）')
  store.clear()
  const { item: scoped } = store.addCandidate({
    feature: schema.featureOf({ tool: 'edit_file', text: '改这一行失败', category: 'tool_failure' }),
    scope: 'project',
    projectId: 'selftest-193-甲',
  })
  for (const round of ['a', 'b', 'c']) {
    store.recordVerification(scoped.id, {
      opportunityId: `call_edit_${round}`,
      evidence: 'ok',
      recipeKey: 'edit_file',
      projectId: 'selftest-193-甲',
    })
  }
  check(
    '甲项目看得到自己的经验',
    store.list({ projectId: 'selftest-193-甲' }).some((item) => item.id === scoped.id),
  )
  check(
    '★ 乙项目看不到甲项目的经验',
    !store.list({ projectId: 'selftest-193-乙' }).some((item) => item.id === scoped.id),
  )
  check(
    '★ 没有项目上下文时也看不到（fail-closed）',
    !store.list({ projectId: '' }).some((item) => item.id === scoped.id),
  )
  check(
    '管理视图（不传 projectId）看得到全部',
    store.list({}).some((item) => item.id === scoped.id),
  )

  /* ── ⑨ 落盘卫生 ── */
  group('经验生命周期 / ⑨ 落盘与脱敏')
  store.clear()
  const secretish = store.addCandidate({
    feature: schema.featureOf({
      tool: 'run_shell',
      text: '命令失败，输出里有 token ghp_selftestnotarealtoken1234567890',
      category: 'tool_failure',
    }),
  })
  check(
    '★ 观察原文过脱敏（密钥不进经验库 —— 经验也会被注入提示）',
    !String(secretish.item?.triggerText ?? '').includes('ghp_selftestnotarealtoken'),
    String(secretish.item?.triggerText).slice(0, 60),
  )
  check(
    '★ 落盘文件在隔离数据目录里（没写到 C 盘或系统目录）',
    /data[\\/](selftest|unit-test)-data/.test(store.filePath()) && store.filePath().endsWith('experiences.json'),
    store.filePath(),
  )
  store.clear()
  check('清理后库是空的', store.load().items.length === 0)
}
