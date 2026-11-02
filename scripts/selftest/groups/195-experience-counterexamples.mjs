/**
 * 自检 / 自我纠错的四个反例 · 前半（①②）
 *
 * 这一组存在的意义不是「再验一遍能跑」，而是**每条都能重现旧错误**：
 * 每条都先把旧实现的行为复刻出来（同一份输入、同一组参数），钉住它以前错在哪；
 * 再用现在的入口跑同一份输入，钉住现在对了。只有两边都钉住，才知道修的是那四个洞，
 * 而不是恰好绕开了它们。
 *
 *   ① 同工具同目标的成功 ≠ 修法已验证（且「没有验证器」的情形必须留在 candidate）
 *   ② 去重与验证关联必须含**适用范围 + 目标**（不同项目 / 不同对象的次数不许串）
 *
 * ③④ 在 `196-experience-counterexamples-b.mjs`；端到端三场景在 `194`，判据全集在 `193`。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, mkdirSync, readFileSync, require, rmSync, writeFileSync } from '../env.mjs'

export async function run() {
  const schema = require(join(ROOT, 'electron/core/experience-schema.cjs'))
  const text = require(join(ROOT, 'electron/core/experience-text.cjs'))
  const store = require(join(ROOT, 'electron/core/experience-store.cjs'))
  const loop = require(join(ROOT, 'electron/core/experience-loop.cjs'))
  const redact = require(join(ROOT, 'electron/core/redact.cjs'))
  const failure = require(join(ROOT, 'electron/core/tool-failure.cjs'))
  const nodePath = require('node:path')

  store.clear()
  mkdirSync(SANDBOX, { recursive: true })

  /* ══════════════════════════════════════════════════════════
     反例 ①：成功不能直接算「修法已验证」
     ══════════════════════════════════════════════════════════ */
  group('反例① 成功 != 修法已验证')

  /* 旧实现：只要 ok===true 就 recordVerification 一次 —— 复刻成「不看做法、不看验证器」 */
  const oldWayWouldPass = () => {
    const fake = { verifications: [] }
    fake.verifications.push({ opportunityId: 'x' })
    return fake.verifications.length >= 1
  }
  check('★ 旧口径：一次 ok 就算一次验证（复刻出来是 true —— 这就是要修的洞）', oldWayWouldPass() === true)

  const fail = failure.of({ toolName: 'read_file', ok: false, output: '错误：文件不存在：195/none.txt' })
  const born = loop.observeRun({
    toolName: 'read_file',
    args: { path: '195/none.txt' },
    ok: false,
    failure: fail,
    text: '错误：文件不存在：195/none.txt',
    opportunityId: 'call_195_a1',
  })
  check('候选建出来了（还没生效）', born.action === 'candidate' && born.item?.status === 'candidate')

  /* ② 无验证器：browse 成功三次，一次都不许计数 */
  const web = loop.observeRun({
    toolName: 'browse',
    args: { url: 'https://example.com' },
    ok: false,
    failure: failure.of({ toolName: 'browse', ok: false, output: '错误：没有可用的浏览器面板' }),
    text: '错误：没有可用的浏览器面板',
    opportunityId: 'call_195_w1',
  })
  const webOk = (id) =>
    loop.observeRun({
      toolName: 'browse',
      args: { url: 'https://example.com' },
      ok: true,
      text: '页面已打开',
      opportunityId: id,
    })
  for (const n of [1, 2, 3]) webOk(`call_195_wok${n}`)
  check(
    '★★ 没有验证器的工具（browse）：三次成功仍停在 candidate',
    store.get(web.item.id)?.status === 'candidate',
    String(store.get(web.item.id)?.status),
  )
  check('★★ 一次验证都没记（没人核过的成功不算证据）', (store.get(web.item.id)?.verifications ?? []).length === 0)
  check(
    '★★ 因此也从未被注入（candidate 永不进提示）',
    store.get(web.item.id)?.injectedCount === 0,
    String(store.get(web.item.id)?.injectedCount),
  )
  check('★ 原因写清楚了：no_verifier（不是悄悄不算）', webOk('call_195_wok4').reason === 'no_verifier')

  /* ③ 有验证器，但验证器去现场看不到 → 拒绝，就算工具自称成功。
     先给它一个**同目标**的候选（真失败过），否则连「算谁的验证」都谈不上。 */
  const lieTarget = '195-gone.txt'
  const lieBorn = loop.observeRun({
    toolName: 'read_file',
    args: { path: lieTarget },
    ok: false,
    failure: failure.of({ toolName: 'read_file', ok: false, output: `错误：文件不存在：${lieTarget}` }),
    text: `错误：文件不存在：${lieTarget}`,
    workdir: SANDBOX,
    opportunityId: 'call_195_lie0',
  })
  check('先造一条同目标的候选', lieBorn.action === 'candidate')
  const lie = loop.observeRun({
    toolName: 'read_file',
    args: { path: lieTarget },
    ok: true, /* ← 工具自称成功 */
    text: '文件内容如下：…',
    workdir: SANDBOX,
    opportunityId: 'call_195_lie1',
  })
  check(
    '★★ 工具自称成功、验证器现场看不到文件 ⇒ 拒绝（observer_rejected）',
    lie.action === 'none' && lie.reason === 'observer_rejected',
    JSON.stringify({ action: lie.action, reason: lie.reason }),
  )
  check('★★ 它一次都没被计数（不许拿自述当证据）', (store.get(lieBorn.item.id)?.verifications ?? []).length === 0)

  /* ④ 有验证器 + 目标真在 → 才计数；换工具 / 换做法都不算 */
  const realTarget = nodePath.join(SANDBOX, '195-real.txt')
  writeFileSync(realTarget, 'content\n', 'utf8')

  const targetCand = loop.observeRun({
    toolName: 'read_file',
    args: { path: '195-real.txt' },
    ok: false,
    failure: failure.of({ toolName: 'read_file', ok: false, output: '错误：文件不存在：195-real.txt' }),
    text: '错误：文件不存在：195-real.txt',
    workdir: SANDBOX,
    projectId: 'p195',
    opportunityId: 'call_195_t0',
  })
  check('同目标的候选建出来了', targetCand.action === 'candidate')
  const okRun = (id) =>
    loop.observeRun({
      toolName: 'read_file',
      args: { path: '195-real.txt' },
      ok: true,
      text: '配置文件内容：content',
      workdir: SANDBOX,
      projectId: 'p195',
      opportunityId: id,
    })
  const v1 = okRun('call_195_t1')
  check(
    '★ 同一目标 + 验证器真看到文件 ⇒ 认下修法（adopted）',
    v1.action === 'adopted' && String(store.get(targetCand.item.id)?.recipe?.key ?? '') === 'read_file',
    JSON.stringify({ action: v1.action, recipe: store.get(targetCand.item.id)?.recipe?.key }),
  )
  check(
    '★ 那次验证记着验证器 id（file_present@…）',
    (store.get(targetCand.item.id)?.verifications ?? []).some((entry) =>
      String(entry.verifier).startsWith('file_present@'),
    ),
    JSON.stringify((store.get(targetCand.item.id)?.verifications ?? []).map((entry) => entry.verifier)),
  )
  check('★ 同一修法再次成功 → 计数（verified）', okRun('call_195_t2').action === 'verified')
  const otherTool = loop.observeRun({
    toolName: 'run_shell',
    args: { command: 'npm test' },
    ok: true,
    text: '',
    workdir: SANDBOX,
    opportunityId: 'call_195_t3',
  })
  check('★ 换工具/换做法的成功不碰这条（action=none）', otherTool.action === 'none')

  /* ══════════════════════════════════════════════════════════
     反例 ②：去重与验证关联必须含范围 + 目标
     ══════════════════════════════════════════════════════════ */
  group('反例② 去重与验证不许跨项目 / 跨对象串在一起')
  store.clear()

  /* 旧 key：tool|category|reasonCode|text —— 复刻一遍，证明它会把两件事并成一条 */
  const oldKey = (f) => [f.tool, f.category, f.reasonCode, f.text].join('|')
  const featA = schema.featureOf({
    tool: 'run_shell',
    failure: { reasonCode: 'EXIT_CODE', category: 'tool_failure' },
    text: 'npm test 挂了',
    args: { command: 'npm test' },
  })
  check('★ 旧 key 里没有项目、也没有目标（两件不同项目的事会并成一条）', !oldKey(featA).includes('project'))
  const keyA = store.candidateKey(featA, { scope: 'project', projectId: '甲' })
  const keyB = store.candidateKey(featA, { scope: 'project', projectId: '乙' })
  check('★★ 新 key 含项目作用域：甲 != 乙', keyA !== keyB, `${keyA} | ${keyB}`)

  const inA = store.addCandidate({ feature: featA, scope: 'project', projectId: '甲', risk: 'low' })
  const inB = store.addCandidate({ feature: featA, scope: 'project', projectId: '乙', risk: 'low' })
  check('★ 两个项目各建一条（不再合并成一条）', inA.item.id !== inB.item.id && store.load().items.length === 2)

  /* 甲项目里的验证，不许算到乙项目那条头上 */
  const crossVerify = store.recordVerification(inB.item.id, {
    opportunityId: 'call_195_y1',
    evidence: 'ok',
    recipeKey: 'run_shell|npm test',
    projectId: '甲',
  })
  check('★★ 甲项目的成功**不算**乙项目经验的验证（作用域不匹配）', crossVerify.ok === false, String(crossVerify.error))

  const verifyIn = (id, round, projectId) =>
    store.recordVerification(id, {
      opportunityId: `call_195_${projectId}_${round}`,
      evidence: 'ok',
      recipeKey: 'run_shell|npm test',
      projectId,
    })
  verifyIn(inA.item.id, 'r1', '甲')
  verifyIn(inA.item.id, 'r2', '甲')
  check('甲项目自己数到 2 次（阈值 3，还不升）', store.get(inA.item.id)?.status === 'candidate')
  /* 乙项目的两次成功插进来 —— 不许把甲的计数顶上去 */
  verifyIn(inB.item.id, 'r3', '乙')
  verifyIn(inB.item.id, 'r4', '乙')
  check(
    '★★ 乙项目的成功没有把甲项目那条顶成 verified（次数不跨项目累加）',
    store.get(inA.item.id)?.status === 'candidate',
    String(store.get(inA.item.id)?.status),
  )
  const third = verifyIn(inA.item.id, 'r5', '甲')
  check('★ 甲项目第 3 次才升 verified', third.promoted === true)

  /* 目标也要进 key：同名文件的两个路径不是一件事 */
  const f1 = schema.featureOf({ tool: 'read_file', text: '读不到', args: { path: 'a/x.txt' } })
  const f2 = schema.featureOf({ tool: 'read_file', text: '读不到', args: { path: 'b/x.txt' } })
  check('★★ 目标进 key：a/x.txt 与 b/x.txt 是两条', store.candidateKey(f1, {}) !== store.candidateKey(f2, {}))
  check('★ 特征里也真的带着 target', f1.target === 'a/x.txt' && f2.target === 'b/x.txt')

  /* 反例也得守作用域：乙项目的失败不能打停甲项目的经验 */
  const contra = store.recordContradiction(inA.item.id, { opportunityId: 'c', evidence: 'fail', projectId: '乙' })
  check('★★ 乙项目的失败**不算**甲项目经验的反例', contra.ok === false, String(contra.error))
  check('甲项目那条仍在注入状态', store.get(inA.item.id)?.status === 'verified')

  /* 清理：本组造的数据不留给后面的组（脱敏 / 纠正那两组在 196 里从空库开始） */
  store.clear()
  rmSync(realTarget, { force: true })
  check('清理后库是空的', store.load().items.length === 0)
  /* 这两个 import 在这一半里不用也得引着：拆文件时漏掉会让另一半的用例悄悄少跑 */
  void text
  void redact
  void readFileSync
}
