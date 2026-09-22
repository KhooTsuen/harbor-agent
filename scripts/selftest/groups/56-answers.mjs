import { join, require, ROOT, SANDBOX } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   回答的「多版本」认领（session-answers.cjs）

   用户报的 bug：在一条对话里编辑过消息之后，切走再切回来，会话里并排堆着
   好几个回答（他真实会话里是 3 个），而且那现象**只有重新打开会话才看得见**
   —— 于是被描述成「切换会话之后才出现」。

   根因：提问有多版本，回答却没有任何「我答的是哪一版」的标记 →
   切版本只能重新生成，生成品追加在文件末尾，读的一侧又认不出它们是同一次提问。

   这里钉住四件事：
     ① 同一次提问的回答收成一条，只有最新那条露在外面（其余进 answerRecords）
     ② 老记录（没有 answersKey）用「它前面最近的那条提问」认领
     ③ 老记录里那种空回答（content 空、没有工具记录）不要露出来
     ④ 提问换版本时，取的是**那一版**的回答（不是最新的那条）
   ══════════════════════════════════════════════════════════════ */

const { groupAnswers } = require(join(ROOT, 'electron/core/session-answers.cjs'))
const sessionCore = require(join(ROOT, 'electron/core/session.cjs'))

const user = (id, extra = {}) => ({ role: 'user', key: id, content: `问 ${id}`, ...extra })
const answer = (id, text, extra = {}) => ({ role: 'assistant', key: id, content: text, ...extra })

export async function run() {
  /* ── ① 同一次提问的多个回答 ─────────────────────────────── */
  group('回答多版本 / 收成一条（不是并排堆着）')
  const q = user('q1')
  const grouped = groupAnswers([
    q,
    answer('a1', '第一次的回答', { answersKey: 'q1', answersVersion: 0 }),
    answer('a2', '第二次的回答', { answersKey: 'q1', answersVersion: 0 }),
    answer('a3', '第三次的回答', { answersKey: 'q1', answersVersion: 0 }),
  ])
  check('提问后面只有**一条**回答（不是三条并排）', grouped.length === 2, String(grouped.length))
  const shown = grouped[1]
  check('露出来的是最新那条', shown?.content === '第三次的回答', String(shown?.content))
  check('另外两条没丢，收进 answerRecords', (shown?.answerRecords ?? []).length === 3)
  check('answerIndex 指向当前那条', shown?.answerIndex === 2, String(shown?.answerIndex))
  check(
    '每条都带上了「答的是谁、第几版」',
    shown?.answersKey === 'q1' && shown?.answersVersion === 0,
  )

  /* ── ② 老记录（没有 answersKey）也要认领 ────────────────── */
  group('回答多版本 / 老记录按「前面最近的那条提问」认领')
  const legacy = groupAnswers([
    user('old1'),
    answer('l1', '老回答一'),
    answer('l2', '老回答二'),
    user('old2'),
    answer('l3', '另一轮的回答'),
  ])
  check('老记录也收成一条', legacy.length === 4, String(legacy.length))
  check(
    '老记录的两条回答归到第一轮',
    legacy[1]?.answerRecords?.length === 2 && legacy[1]?.content === '老回答二',
    String(legacy[1]?.answerRecords?.length),
  )
  check('第二轮的回答不会被上一轮吸走', legacy[3]?.answerRecords?.length === 1)

  /* 没有 key 的老提问：用「第几条提问」当身份，不能认领错 */
  const noKeys = groupAnswers([
    { role: 'user', content: '老提问一' },
    { role: 'assistant', content: '答一' },
    { role: 'user', content: '老提问二' },
    { role: 'assistant', content: '答二' },
  ])
  check('没有 key 的老会话：两轮各归各的', noKeys.length === 4 && noKeys[1]?.content === '答一')

  /* ── ③ 空回答不露出来 ─────────────────────────────────── */
  group('回答多版本 / 空回答不收进来')
  const withNoise = groupAnswers([
    q,
    answer('a1', '有内容的回答', { answersKey: 'q1', answersVersion: 0 }),
    answer('a2', '', { answersKey: 'q1', answersVersion: 0 }),
  ])
  check('content 空、没有工具记录的回答不显示', withNoise.length === 2, String(withNoise.length))
  check('露出来的是有内容那条', withNoise[1]?.content === '有内容的回答')
  const withTools = groupAnswers([
    q,
    answer('a1', '只调了工具', {
      answersKey: 'q1',
      answersVersion: 0,
      toolRuns: [{ id: 't', name: 'x' }],
    }),
  ])
  check('只调了工具、没写字的回答**要**留着（那是真干过活）', withTools.length === 2)

  /* ── ④ 提问换版本 → 取那一版的回答 ─────────────────────── */
  group('回答多版本 / 按提问的版本取回答')
  const perVersion = groupAnswers([
    user('q1', { versions: ['第一版问题', '第二版问题'], versionIndex: 1 }),
    answer('a1', '答第一版', { answersKey: 'q1', answersVersion: 0 }),
    answer('a2', '答第二版', { answersKey: 'q1', answersVersion: 1 }),
  ])
  check('当前是第 2 版 → 露出来的是第 2 版的回答', perVersion[1]?.content === '答第二版')
  check('两版回答都在这条上（切版本不用重跑）', perVersion[1]?.answerRecords?.length === 2)
  const backToFirst = groupAnswers([
    user('q1', { versions: ['第一版问题', '第二版问题'], versionIndex: 0 }),
    answer('a1', '答第一版', { answersKey: 'q1', answersVersion: 0 }),
    answer('a2', '答第二版', { answersKey: 'q1', answersVersion: 1 }),
  ])
  check('切回第 1 版 → 取第 1 版的回答（不重跑也不串）', backToFirst[1]?.content === '答第一版')

  /* ── ⑤ 真跑一遍：写盘 → 读回来 ─────────────────────────── */
  /*
   * ★ 上面测的是纯函数。这一步走真文件，钉住「load() 用的就是它」——
   *   以前出现过「逻辑写好了但没接上」的情况（层与层之间的接线，单测照不到）。
   */
  group('回答多版本 / 真写一个会话再读回来')
  const created = sessionCore.create({ title: '回答多版本自检', workdir: SANDBOX })
  try {
    sessionCore.append(created.id, { role: 'user', key: 'q9', content: '一个问题' })
    sessionCore.append(created.id, {
      role: 'assistant',
      key: 'a9',
      content: '第一遍',
      answersKey: 'q9',
      answersVersion: 0,
    })
    sessionCore.append(created.id, {
      role: 'assistant',
      key: 'a10',
      content: '第二遍（重新生成）',
      answersKey: 'q9',
      answersVersion: 0,
    })
    const loaded = sessionCore.load(created.id)
    check(
      '★ load() 读回来就是收好的（接线对得上）',
      loaded.messages.length === 2,
      String(loaded.messages.length),
    )
    check('★ 露出来的是最后写的那条', loaded.messages[1]?.content === '第二遍（重新生成）')
    check('★ 第一遍还在（能切回去，没被覆盖）', loaded.messages[1]?.answerRecords?.length === 2)
    check(
      '★ 落盘也留住了 answersKey（不是只在内存里）',
      loaded.messages[1]?.answersKey === 'q9' && loaded.messages[1]?.answersVersion === 0,
    )
  } finally {
    sessionCore.remove(created.id)
  }

  /* ── ⑥ 两条更新过的老判据（别改回去）───────────────────── */
  group('回答多版本 / 老兼容规则没有被放宽')
  const tightened = groupAnswers([
    { role: 'user', content: '同一句话' },
    { role: 'assistant', content: '老回答' },
    {
      role: 'user',
      content: '同一句话',
      key: 'q2',
      versions: ['同一句话', '改过的'],
      versionIndex: 1,
    },
    { role: 'assistant', content: '新回答', answersKey: 'q2', answersVersion: 0 },
  ])
  check(
    '内容相同的**独立轮次**不会被误当成旧版本吞掉（老会话里踩过）',
    tightened.filter((m) => m.role === 'user').length === 2,
    String(tightened.filter((m) => m.role === 'user').length),
  )
}
