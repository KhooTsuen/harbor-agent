import { join, require, ROOT, SANDBOX } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   回答多版本：**记住用户选的是哪一条**

   从 56-answers.mjs 拆出来的（那边加了这一节就贴 300 行上限了）。

   用户报的：切回答（‹ n / N ›）选完，重开会话又跳回最新那条。
   根因是「选择」以前只在内存里 —— 读的一侧永远给 `list.length - 1`。

   这里钉住两件事：
     ① 提问记录上的 `answerIndexByVersion` 读的时候认（按提问版本分开认）
     ② 选择真写进文件、load() 读回来还在（不是只在内存里）
   ══════════════════════════════════════════════════════════════ */

const { groupAnswers } = require(join(ROOT, 'electron/core/session-answers.cjs'))
const sessionCore = require(join(ROOT, 'electron/core/session.cjs'))

const user = (id, extra = {}) => ({ role: 'user', key: id, content: `问 ${id}`, ...extra })
const answer = (id, text, extra = {}) => ({ role: 'assistant', key: id, content: text, ...extra })

export async function run() {
  /* ── ① 读的一侧认这个选择 ─────────────────────────────── */
  group('回答选择 / 记住用户选的是哪一条（重开不跳回最新）')
  const threeAnswers = (pick) => [
    user('q1', pick === undefined ? {} : { answerIndexByVersion: pick }),
    answer('a1', '第一遍', { answersKey: 'q1', answersVersion: 0 }),
    answer('a2', '第二遍', { answersKey: 'q1', answersVersion: 0 }),
    answer('a3', '第三遍', { answersKey: 'q1', answersVersion: 0 }),
  ]
  const noPick = groupAnswers(threeAnswers(undefined))
  check(
    '没选过 → 露最新那条（老行为不变）',
    noPick[1]?.content === '第三遍' && noPick[1]?.answerIndex === 2,
    String(noPick[1]?.content),
  )
  const pickedFirst = groupAnswers(threeAnswers({ 0: 0 }))
  check(
    '★ 选过第 1 条 → 露出来的是它（不是最新那条）',
    pickedFirst[1]?.content === '第一遍',
    String(pickedFirst[1]?.content),
  )
  check(
    '★ answerIndex 跟着它（界面 ‹ 1 / 3 › 才对得上）',
    pickedFirst[1]?.answerIndex === 0,
    String(pickedFirst[1]?.answerIndex),
  )
  check('★ 另外两条照样都在（切换不用重跑）', pickedFirst[1]?.answerRecords?.length === 3)
  check(
    '★ 越界的记法（那条被重新生成挤掉了）→ 退回最新那条',
    groupAnswers(threeAnswers({ 0: 9 }))[1]?.content === '第三遍',
  )
  check(
    '记法不是对象时也不炸（脏数据兜底）',
    groupAnswers(threeAnswers('乱写的'))[1]?.content === '第三遍',
  )

  /* 按提问版本分开记：切回哪一版，就还是哪一版的选择 */
  const twoVersions = (picks) => [
    user('q1', {
      versions: ['第一版问题', '第二版问题'],
      versionIndex: 1,
      answerIndexByVersion: picks,
    }),
    answer('a1', '答第一版-1', { answersKey: 'q1', answersVersion: 0 }),
    answer('a2', '答第一版-2', { answersKey: 'q1', answersVersion: 0 }),
    answer('a3', '答第二版-1', { answersKey: 'q1', answersVersion: 1 }),
    answer('a4', '答第二版-2', { answersKey: 'q1', answersVersion: 1 }),
  ]
  check(
    '第 2 版选了第 1 条 → 露「答第二版-1」',
    groupAnswers(twoVersions({ 1: 0 }))[1]?.content === '答第二版-1',
  )
  check(
    '★ 第 1 版的选择不会串到第 2 版',
    groupAnswers(twoVersions({ 0: 1 }))[1]?.content === '答第二版-2',
    String(groupAnswers(twoVersions({ 0: 1 }))[1]?.content),
  )

  /* ── ② 真写盘 → 读回来，选择还在 ──────────────────────── */
  group('回答选择 / 落盘后真读得回来')
  const picked = sessionCore.create({ title: '回答选择自检', workdir: SANDBOX })
  try {
    sessionCore.append(picked.id, { role: 'user', key: 'q20', content: '一个问题' })
    sessionCore.append(picked.id, {
      role: 'assistant',
      key: 'a20',
      content: '第一遍',
      answersKey: 'q20',
      answersVersion: 0,
    })
    sessionCore.append(picked.id, {
      role: 'assistant',
      key: 'a21',
      content: '第二遍',
      answersKey: 'q20',
      answersVersion: 0,
    })
    /* 用户点了「上一个回答」→ 页面把选择写回**提问**记录（同一 key 追加一条） */
    sessionCore.append(picked.id, {
      role: 'user',
      key: 'q20',
      content: '一个问题',
      answerIndexByVersion: { 0: 0 },
    })
    const back = sessionCore.load(picked.id)
    check(
      '★ 读回来露的是用户选的那条（不是最新那条）',
      back.messages[1]?.content === '第一遍',
      String(back.messages[1]?.content),
    )
    check(
      '★ answerIndex 也记住了（界面切换器停在同一处）',
      back.messages[1]?.answerIndex === 0,
      String(back.messages[1]?.answerIndex),
    )
    check('提问记录上的选择没被丢掉', back.messages[0]?.answerIndexByVersion?.[0] === 0)
  } finally {
    sessionCore.remove(picked.id)
  }
}
