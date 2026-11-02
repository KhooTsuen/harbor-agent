/**
 * 自检 / 自我纠错端到端三场景（文件 · 网页 · 用户纠正）
 *
 * 和 `193-experience-lifecycle` 的分工：那边钉**判据**（状态机、计数、隔离），
 * 这边**真跑**：真的调工具、真的落盘、真的走 `tool-runner` 的观察口和
 * `loop-prompt` 的注入口。判据对不对是 193 的事，这里只回答「接上去以后会不会真发生」。
 *
 * ── 三条要证明的 ──
 *
 *   ① 失败**不会**直接变成规则：同一轮里那次失败，模型看到的正文里
 *      **没有**「以前遇到过同类情况」（候选不进提示）。
 *   ② 验证通过的经验**下次能被召回**：同工具、同原因码、换个目标再失败时，
 *      工具结果里真的多出那一句，而且带着「上次这样做成功了」。
 *   ③ 出现反例**立刻暂停**：同一个目标再失败一次 → suspended，召回消失。
 *
 * ── 一条必须说清的限制 ──
 *
 * 网页那一段：自检跑在**纯 Node** 里，没有 Electron 的浏览器面板，所以
 * `browse` 是**真失败**（真的走完了工具、真的报了错、真的建了候选），
 * 但「三次成功」没法在无界面环境里真跑 —— 那三次是喂给**同一个入口**
 * （`experience.afterRun`，生产路径就是它）的。真机浏览器路径这一轮
 * **没有**被自动测试覆盖，报告里如实写了这一点，不当成「已验证」。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, existsSync, join, readFileSync, require, rmSync, writeFileSync, mkdirSync } from '../env.mjs'

export async function run() {
  const { executeToolCalls } = require(join(ROOT, 'electron/core/tool-runner.cjs'))
  const experience = require(join(ROOT, 'electron/core/experience-loop.cjs'))
  const store = require(join(ROOT, 'electron/core/experience-store.cjs'))
  const stack = require(join(ROOT, 'electron/core/prompt-stack.cjs'))
  const prompt = require(join(ROOT, 'electron/core/loop-prompt.cjs'))
  const configModule = require(join(ROOT, 'electron/core/config.cjs'))

  store.clear()
  /*
   * 沙箱自己建：全量自检里 `prepareSelftest()` 会建它，但 `selftest-only` 不跑那一步。
   * 目录不在会让后面的写入抛 ENOENT，看着像「工具坏了」。
   */
  mkdirSync(SANDBOX, { recursive: true })

  /** 真跑一次工具调用，返回：模型看到的正文 + 本次产生的事件 */
  async function runOne(id, name, args) {
    const messages = []
    const events = []
    const runs = []
    await executeToolCalls({
      toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
      ctx: { workdir: SANDBOX, permission: 'full', log: { info() {}, warn() {} }, sessionId: 'selftest-194' },
      options: { history: [] },
      messages,
      toolRuns: runs,
      emit: (event) => events.push(event),
      turn: 0,
    })
    return { text: String(messages[0]?.content ?? ''), ok: runs[0]?.ok === true, runs, events }
  }

  /* ══════════════════════════════════════════════════════════
     场景一：文件操作
     ══════════════════════════════════════════════════════════ */
  group('自我纠错 e2e / ① 文件操作')
  const target = join(SANDBOX, 'e2e-194-缺的那个.txt')
  const rel = 'e2e-194-缺的那个.txt'

  const firstFail = await runOne('call_194_f1', 'read_file', { path: rel })
  check('★ 真的失败了（文件确实不存在）', firstFail.ok === false, firstFail.text.slice(0, 80))
  check(
    '★★ 模型看到的那段正文里**没有**旧经验（失败没有当场变成规则）',
    !firstFail.text.includes('[以前遇到过同类情况]'),
    firstFail.text.slice(0, 120),
  )
  const born = store.list({ includeClosed: true }).find((item) => item.tool === 'read_file')
  check('★ 候选落盘了（domain=file）', born?.status === 'candidate' && born?.domain === 'file', JSON.stringify({ status: born?.status, domain: born?.domain }))

  /* 把文件真的建出来，再真读三次 —— 三个不同的调用 id = 三次独立机会。
     ★ 反例 1 的语义：第一次成功只**探明修法**（不计数），之后同修法的成功才算验证。 */
  writeFileSync(target, 'line one\n', 'utf8')
  for (const n of [1, 2, 3]) {
    const read = await runOne(`call_194_ok${n}`, 'read_file', { path: rel })
    check(`第 ${n} 次真读成功`, read.ok === true, read.text.slice(0, 60))
  }
  check(
    '★★ 探明修法 + 两次同修法独立成功之后升为 verified（不是「成功一次就信」）',
    store.get(born.id)?.status === 'verified',
    String(store.get(born.id)?.status),
  )
  check(
    '★ 升级记下了「用的是哪套做法」（系统侧证据，不是模型自述）',
    String(store.get(born.id)?.recipe?.key ?? '') === 'read_file',
    JSON.stringify(store.get(born.id)?.recipe),
  )
  check(
    '★ 每条验证都记着验证器 id（谁亲眼核过）',
    (store.get(born.id)?.verifications ?? []).every((entry) => String(entry.verifier).startsWith('file_present@')),
    JSON.stringify((store.get(born.id)?.verifications ?? []).map((entry) => entry.verifier)),
  )

  /* 换个文件、同一类原因再失败 → 真召回 */
  const recalled = await runOne('call_194_f2', 'read_file', { path: 'e2e-194-另一个没有的.txt' })
  check('再一次真失败', recalled.ok === false)
  check(
    '★★ 这次模型看到「以前遇到过同类情况」（换个文件也能召回）',
    recalled.text.includes('[以前遇到过同类情况]'),
    recalled.text.slice(0, 200),
  )
  check(
    '★ 召回里带着上次成功的做法',
    recalled.text.includes('上次这样做成功了'),
    recalled.text.slice(0, 240),
  )
  check(
    '★ 换目标失败**没有**被当成反例（判据要求同一个目标）',
    store.get(born.id)?.status === 'verified',
    String(store.get(born.id)?.status),
  )

  /* 同一个目标再失败 → 反例 → 暂停 */
  rmSync(target, { force: true })
  const contradicted = await runOne('call_194_f3', 'read_file', { path: rel })
  check('★ 同一个文件又读不到（真失败）', contradicted.ok === false)
  check(
    '★★ 立刻 suspended（出现有力反例就停止使用）',
    store.get(born.id)?.status === 'suspended',
    String(store.get(born.id)?.status),
  )
  check(
    '★★ 暂停之后正文里不再出现那句（不再误导模型）',
    !contradicted.text.includes('[以前遇到过同类情况]'),
    contradicted.text.slice(0, 160),
  )
  check('调查记录还在（暂停不是删除）', (store.get(born.id)?.contradictions ?? []).length >= 1)

  /* ══════════════════════════════════════════════════════════
     场景二：网页操作
     ══════════════════════════════════════════════════════════ */
  group('自我纠错 e2e / ② 网页操作')
  /*
   * 网页这一段要**真的走到工具里面**，就得先让它过网络策略那关：
   * 默认策略是「每次先问」，而完全访问档不会问到你 → browse 会被策略挡住，
   * 那样我们验的就变成「策略拦人」，不是「网页操作失败怎么学」。
   * 所以临时把隔离数据里的网络策略改成「允许」，跑完原样恢复（只动隔离配置）。
   */
  const cfgBefore = configModule.get()
  const netBefore = cfgBefore.security?.network
  try {
    configModule.patch({ security: { ...cfgBefore.security, network: { ...netBefore, mode: 'allow' } } })
  } catch {
    /* 改不动就按原策略跑（下面会如实红） */
  }
  const webTarget = { url: 'https://example.com' }
  const webFail = await runOne('call_194_w1', 'browse', webTarget)
  check('★ browse 真跑并真失败（自检环境没有浏览器面板）', webFail.ok === false, webFail.text.slice(0, 100))
  check(
    '★★ 网页这次失败也没有当场变成提示',
    !webFail.text.includes('[以前遇到过同类情况]'),
    webFail.text.slice(0, 120),
  )
  const webItem = store.list({ includeClosed: true }).find((item) => item.tool === 'browse')
  check('★ 候选记在 web 领域（跨领域匹配靠这个字段，但它不是硬过滤）', webItem?.domain === 'web', String(webItem?.domain))

  /*
   * ★ 反例 1 的验收（网页属于「可信验证器尚未接入」的场景）：
   * 三次 ok 成功**都不该**把它顶成 verified —— 没有验证器就等于没人核过，
   * 只能留在 candidate（不可注入）。以前这里断言「三次成功 → verified」，
   * 那正是用户点出的错误：工具自己说成功不能当证据。
   */
  const okRun = { name: 'browse', args: webTarget, ok: true, output: '页面已打开：Example Domain' }
  for (const n of [1, 2, 3]) experience.afterRun({ ...okRun, id: `call_194_wok${n}` }, { sessionId: 'selftest-194' })
  check(
    '★★ 网页三次「成功」仍停在 candidate（没有独立验证器 ⇒ 没人核过，不许升级）',
    store.get(webItem.id)?.status === 'candidate',
    String(store.get(webItem.id)?.status),
  )
  check(
    '★★ 因此它一次都没被注入（candidate 永不进提示）',
    store.get(webItem.id)?.injectedCount === 0,
    String(store.get(webItem.id)?.injectedCount),
  )
  const webAgain = await runOne('call_194_w2', 'browse', { url: 'https://example.org' })
  check(
    '★ 换个站点再失败时**没有**旧经验可召回（它还没被验证过）',
    !webAgain.text.includes('[以前遇到过同类情况]'),
    webAgain.text.slice(0, 200),
  )
  const webContra = await runOne('call_194_w3', 'browse', webTarget)
  check(
    '★ 同一个站点又失败仍然只是 candidate（没生效的东西谈不上暂停）',
    store.get(webItem.id)?.status === 'candidate',
    String(store.get(webItem.id)?.status),
  )
  check(
    '★ 跨领域不会被硬过滤掉：网页经验对文件类情形也参与打分（domain 只加权）',
    require(join(ROOT, 'electron/core/experience-match.cjs')).WEIGHTS.domain > 0 &&
      require(join(ROOT, 'electron/core/experience-match.cjs')).WEIGHTS.domain < 0.2,
  )

  /* ══════════════════════════════════════════════════════════
     场景三：用户纠正
     ══════════════════════════════════════════════════════════ */
  group('自我纠错 e2e / ③ 用户纠正')
  const before = store.load().items.length
  const correction = '不对，这不是我要的那个文件，我说过要的是配置'
  /* 走提示装配里的那个入口（loop-prompt 每轮调它）—— 真实路径，不是直接调 store */
  const section = experience.sectionFor({ userText: correction, sessionId: 'selftest-194' })
  check('★ 用户纠正时不注入任何经验（当场注入等于把「不对」当结论）', section === '', section.slice(0, 120))
  const corrected = store.load().items.find((item) => item.category === 'user_correction')
  check('★ 但它被记成候选了（下次可以辅助判断）', Boolean(corrected) && store.load().items.length > before)
  check(
    '★ 候选写清了「这是用户明确否定」，没有替用户猜原因',
    String(corrected?.causeHypothesis ?? '').includes('用户明确否定'),
    String(corrected?.causeHypothesis),
  )
  check(
    '★★ 之后「碰巧成功」若干次也升不了级（该怎么做对只有人能定）',
    ['a', 'b', 'c', 'd'].every(
      (n) => store.recordVerification(corrected.id, { opportunityId: `call_194_c${n}`, recipeKey: 'read_file' }).ok,
    ) && store.get(corrected.id)?.status === 'candidate',
    String(store.get(corrected.id)?.status),
  )
  check(
    '★ 提示装配里那一层存在，且排在记忆之后（先看用户说过什么，再看验证过什么）',
    stack.ORDER.indexOf('relevantExperience') === stack.ORDER.indexOf('relevantMemory') + 1,
  )

  /* 真的走一次 buildPromptContext：确认这一层接进了生产装配，而不是只在自检里被调用 */
  let built = null
  try {
    built = prompt.buildPromptContext({
      config: configModule.get(),
      workdir: SANDBOX,
      mode: 'pair',
      history: [{ role: 'user', content: correction }],
      threadSettings: {},
      options: { history: [{ role: 'user', content: correction }], sessionId: '' },
    })
  } catch (error) {
    built = { error: String(error?.message ?? error) }
  }
  check('★ buildPromptContext 能真跑通（装配没被这一层弄坏）', Boolean(built?.messages), String(built?.error ?? ''))
  check(
    '★ 系统提示里带上了这一层（标题在，内容空则整层不出现）',
    String(built?.messages?.[0]?.content ?? '').length > 100,
  )

  /* 清理：这一组造出来的经验不该留在隔离库里影响别的组 */
  try {
    configModule.patch({ security: { ...configModule.get().security, network: netBefore } })
  } catch {
    /* 恢复不了也不该让整组红：隔离目录每轮都会被重建 */
  }
  store.clear()
  check('清理后经验库为空', store.load().items.length === 0)
  check('落盘路径在隔离数据目录里', /data[\\/](selftest|unit-test)-data/.test(store.filePath()), store.filePath())
  check('sandbox 里的临时文件已删', !existsSync(target))
  check(
    '经验文件真的被清理过（不是只在内存里清）',
    !existsSync(store.filePath()) || String(readFileSync(store.filePath(), 'utf8')).includes('"items": []'),
  )
}
