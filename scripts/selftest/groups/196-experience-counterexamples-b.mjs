/**
 * 自检 / 自我纠错的四个反例 · 后半（③④）
 *
 * 和 `195-experience-counterexamples.mjs` 的分工：那边是「成功 ≠ 已验证」与
 * 「去重 / 验证关联要带作用域与目标」，这里是「脱敏失败不许存原文」与
 * 「用户纠正按对话 + 消息去重」。拆成两个文件是因为 300 行红线。
 *
 * 写法与 195 一致：**先把旧实现的错误复刻出来**（钉住「以前会错」），
 * 再用现在的入口跑同一份输入（钉住「现在对了」）。只钉后者，就分不清
 * 「修好了」和「恰好绕开了」。
 *
 *   ③ 脱敏失败 ⇒ 放弃该次经验记录，只留不含敏感内容的诊断
 *   ④ 用户纠正按 `sessionId|messageId` 去重，进程级「上一句」不许压掉别的对话
 */

import { check, group } from '../harness.mjs'
import { ROOT, join, readFileSync, require, writeFileSync } from '../env.mjs'

export async function run() {
  const schema = require(join(ROOT, 'electron/core/experience-schema.cjs'))
  const text = require(join(ROOT, 'electron/core/experience-text.cjs'))
  const store = require(join(ROOT, 'electron/core/experience-store.cjs'))
  const loop = require(join(ROOT, 'electron/core/experience-loop.cjs'))
  const redact = require(join(ROOT, 'electron/core/redact.cjs'))

  /* ══════════════════════════════════════════════════════════
     反例 ③：脱敏失败禁止保存原文
     ══════════════════════════════════════════════════════════ */
  group('反例③ 脱敏失败 => 放弃该次经验，诊断不含原文')
  store.clear()

  /* 旧实现：catch { safe = raw } —— 复刻出来，证明它会把原文原样交出去 */
  const oldNormalize = (input, boom) => {
    let safe = input
    try {
      if (boom) throw new Error('redact 挂了')
      safe = redact.redact(input)
    } catch {
      safe = input /* ← 就是这一行把密钥写进了库 */
    }
    return safe
  }
  const SECRET = 'ghp_195notarealtoken000000000000'
  check('★ 旧口径：脱敏抛异常时原文被原样留下来（这就是要修的洞）', oldNormalize(SECRET, true).includes('ghp_195'))
  check('★ 旧口径会把它原样写进落盘文件（同一段文本原样返回）', oldNormalize(SECRET, true) === SECRET)

  /* 新口径：脱敏失败 ⇒ ok:false，且 text 一定是空串 */
  const boom = (() => {
    const original = redact.redact
    redact.redact = () => {
      throw new Error('模拟脱敏故障')
    }
    try {
      return text.sanitize(`命令失败，输出里有 ${SECRET}`)
    } finally {
      redact.redact = original
    }
  })()
  check('★★ 脱敏失败被识别（ok:false）', boom.ok === false, JSON.stringify(boom))
  check('★★ 失败时**不返回原文**（text 是空串）', boom.text === '', JSON.stringify(boom.text))
  check('★★ 诊断里不含密钥', !String(boom.error).includes('ghp_195'), String(boom.error))

  const dropped = store.addCandidate({
    feature: { ...schema.featureOf({ tool: 'run_shell', text: 'x' }), textSafe: false, textError: boom.error },
    risk: 'low',
  })
  check('★★ 这条经验被放弃（dropped，没建条目）', dropped.ok === false && Boolean(dropped.dropped), JSON.stringify(dropped))
  check('★ 库里一条都没有（原文没落到任何地方）', store.load().items.length === 0)
  check('★ 放弃原因不含原文', !String(dropped.dropped).includes('ghp_195'))

  /* 正常路径仍然要能过：密钥被打码、条目进库 */
  const masked = store.addCandidate({
    feature: schema.featureOf({ tool: 'run_shell', text: `命令失败，输出里有 ${SECRET}` }),
    risk: 'low',
  })
  check('正常脱敏照样能记（不是把整条路堵死）', masked.ok === true)
  check(
    '★ 落盘文本里没有密钥原文',
    !String(masked.item?.triggerText ?? '').includes('ghp_195'),
    String(masked.item?.triggerText),
  )
  /* 落盘前再兜一层：哪怕有人绕过 schema 塞了脏文本，写盘时也会被拦 */
  const dirty = store.load()
  dirty.items.push({ ...masked.item, id: 'exp_dirty_195', triggerText: `明文 ${SECRET}` })
  writeFileSync(store.filePath(), JSON.stringify(dirty, null, 2))
  store.touchInjected(['exp_dirty_195'])
  const after = readFileSync(store.filePath(), 'utf8')
  check('★★ 落盘前扫出脏文本 ⇒ 整条不写（文件里没有它）', !after.includes('exp_dirty_195'))
  check('★ 干净的那条还在（不是把整份库丢掉）', after.includes(masked.item.id))

  /* ══════════════════════════════════════════════════════════
     反例 ④：纠正按对话 + 消息去重
     ══════════════════════════════════════════════════════════ */
  group('反例④ 另一条对话里的相同纠正不许被压掉')
  store.clear()
  loop.resetSeen()

  const SAME = '不对，这里应该用 pnpm 而不是 npm'
  /* 旧实现：一个模块级 lastObservedText —— 复刻一遍 */
  const oldDedup = (() => {
    let last = ''
    return (value) => {
      if (value === last) return false
      last = value
      return true
    }
  })()
  check('★ 旧口径：会话 A 第一次会观察', oldDedup(SAME) === true)
  check('★ 旧口径：会话 B 的**同一句**被压掉（这就是要修的洞）', oldDedup(SAME) === false)

  /* 新口径：A 会话那条消息只观察一次；B 会话同文本另算一条 */
  const a1 = loop.sectionFor({ userText: SAME, sessionId: 'sess-A', messageId: 'msg-A1' })
  check('会话 A 那句不注入任何经验（当场不把「不对」当结论）', a1 === '')
  check('★ 会话 A 记了一条候选', store.load().items.length === 1)

  /* 同一条消息被重复装配（同一回合会拼多次提示）→ 不再重复计数 */
  loop.sectionFor({ userText: SAME, sessionId: 'sess-A', messageId: 'msg-A1' })
  check(
    '★ 同一条消息重复装配不重复计数',
    store.load().items.every((item) => item.reproductions === 1),
    JSON.stringify(store.load().items.map((item) => item.reproductions)),
  )

  loop.sectionFor({ userText: SAME, sessionId: 'sess-B', messageId: 'msg-B1' })
  check(
    '★★ 会话 B 的同一句话**照样被记下**（不再被进程级「上一句」压掉）',
    store.load().items.length === 2,
    JSON.stringify(store.load().items.map((item) => `${item.sessionId}:${item.target}`)),
  )
  check(
    '★ 两条各自带着自己的「对话 + 消息」标识',
    store.load().items.some((item) => item.target === 'sess-A|msg-A1') &&
      store.load().items.some((item) => item.target === 'sess-B|msg-B1'),
    JSON.stringify(store.load().items.map((item) => item.target)),
  )
  /* 同会话、另一条消息（用户又纠正了一次）→ 也是新的一条 */
  loop.sectionFor({ userText: SAME, sessionId: 'sess-A', messageId: 'msg-A2' })
  check('★ 同一对话的另一条消息也算新事实', store.load().items.length === 3)

  /* 关键回归：来回切换对话也不会互相压掉 */
  loop.sectionFor({ userText: SAME, sessionId: 'sess-B', messageId: 'msg-B2' })
  check('★ 来回切换对话也不会互相压掉', store.load().items.length === 4)

  store.clear()
  loop.resetSeen()
  check('清理后库是空的', store.load().items.length === 0)
}
