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

   「用户选的是第几条回答」在第 60 组（60-answer-pick.mjs）。
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

  /* ── ⑥ 后续几轮跟着「当时那一版」走 ───────────────────── */
  /*
   * 用户说的"树"那一层：编辑**中间**那条消息时，后面几轮是按旧内容写的。
   * 以前前端直接删掉（重开会话又回来、还接在新回答后面）；
   * 现在按「当前选中那一版」筛 —— 切回旧版本它们自己就回来了。
   */
  group('多版本 / 后续几轮跟着它当时那一版（不用分支 id）')
  const withTail = (versionIndex) => [
    user('q1', { versions: ['第一版', '第二版'], versionIndex }),
    {
      role: 'assistant',
      key: 'a1',
      content: '答当前版',
      answersKey: 'q1',
      answersVersion: versionIndex,
    },
    /* 后面这一轮是在 q1 **还是第 0 版**的时候发的 */
    { role: 'user', key: 'q2', content: '后一轮的问题', parentKey: 'q1', parentVersion: 0 },
    { role: 'assistant', key: 'a2', content: '后一轮的回答', answersKey: 'q2', answersVersion: 0 },
  ]
  const onV0 = groupAnswers(withTail(0))
  check(
    '选中第 0 版 → 后面那一轮在（它就是在这版之后发的）',
    onV0.length === 4,
    String(onV0.length),
  )
  check('后一轮的回答也在', onV0[3]?.content === '后一轮的回答')

  const onV1 = groupAnswers(withTail(1))
  check(
    '★ 切到第 1 版 → 后面那一轮被筛掉（它是按旧版本写的）',
    onV1.length === 2,
    String(onV1.length),
  )
  check('★ 提问 + 它这一版的回答都留着', onV1[0]?.role === 'user' && onV1[1]?.answersVersion === 1)
  check('★ 整轮一起筛：不会只剩提问、把回答孤零零留下', !onV1.some((m) => m.key === 'a2'))
  /* ★ 光看 key 不够：被筛掉那一轮的回答可能被**误认领**成上一轮的（显示成答非所问） */
  check(
    '★ 露出来的是这一版自己的回答（不是被筛掉那轮的）',
    onV1[1]?.content === '答当前版',
    String(onV1[1]?.content),
  )
  check(
    '切回第 0 版，那一轮原样回来（不是重新生成）',
    groupAnswers(withTail(0))[3]?.content === '后一轮的回答',
  )

  /*
   * ★ 老记录（回答**没带** answersKey）才真正需要「整轮一起筛」：
   *   它的归属靠「前面最近那条提问」认领 —— 如果不把被筛掉那一轮的回答一起丢，
   *   它会被误认领成**上一轮的**，界面上就是答非所问。
   */
  const legacyNoTag = groupAnswers([
    user('q1', { versions: ['第一版', '第二版'], versionIndex: 1 }),
    { role: 'assistant', key: 'a1', content: '答当前版', answersKey: 'q1', answersVersion: 1 },
    { role: 'user', key: 'q2', content: '后一轮的问题', parentKey: 'q1', parentVersion: 0 },
    { role: 'assistant', key: 'a2', content: '后一轮的回答' },
  ])
  check(
    '★ 老回答没被误认领成上一轮的（不然显示成答非所问）',
    legacyNoTag.length === 2,
    String(legacyNoTag.length),
  )
  check(
    '★ 露出来的还是这一版自己的回答',
    legacyNoTag[1]?.content === '答当前版',
    String(legacyNoTag[1]?.content),
  )

  /* 老记录（没有 parentKey）一律保留 —— 老会话行为不变 */
  const legacyTail = groupAnswers([
    user('q1', { versions: ['第一版', '第二版'], versionIndex: 1 }),
    { role: 'assistant', key: 'a1', content: '答当前版', answersKey: 'q1', answersVersion: 1 },
    { role: 'user', key: 'q2', content: '老会话的后续' },
    { role: 'assistant', key: 'a2', content: '老会话的回答', answersKey: 'q2', answersVersion: 0 },
  ])
  check('★ 没有标记的老记录照旧全留', legacyTail.length === 4, String(legacyTail.length))

  /* ── ⑦ 两条更新过的老判据（别改回去）───────────────────── */
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
