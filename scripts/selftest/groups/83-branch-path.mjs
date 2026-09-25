import { join, require, ROOT, SANDBOX } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   分支路径：**激活路径写盘后读得回来**（面包屑/分支树靠它恢复）

   界面的面包屑和分支树是从读出来的消息现场算的（lib/branchPath.ts）。
   所以「重开应用后路径正确恢复」= 内核把三样东西读对：
     ① 提问停在第几版（versionIndex，最后一版记录说了算）
     ② 每一版各自选了第几条回答（answerIndexByVersion）
     ③ 后续几轮按 parentVersion 跟不跟（切版本 = 整条链跟着切换）

   这里用真文件走一遍：写两层分叉（提问改版 + 回答多条）→ load →
   对答案；再切回旧版 → 后续链整条退出。
   ══════════════════════════════════════════════════════════════ */

const sessionCore = require(join(ROOT, 'electron/core/session.cjs'))

export async function run() {
  group('分支路径 / 两层分叉写盘后读得回来（激活路径恢复）')
  const created = sessionCore.create({ title: '分支路径自检', workdir: SANDBOX })
  try {
    /* 第一层：Q1 改过两版；B 版下重新生成过两条回答 */
    sessionCore.append(created.id, { role: 'user', key: 'q1', content: 'A 内容' })
    sessionCore.append(created.id, {
      role: 'assistant',
      key: 'a1',
      content: '答A-1',
      answersKey: 'q1',
      answersVersion: 0,
    })
    sessionCore.append(created.id, {
      role: 'user',
      key: 'q1',
      content: 'B 内容',
      versions: ['A 内容', 'B 内容'],
      versionIndex: 1,
    })
    sessionCore.append(created.id, {
      role: 'assistant',
      key: 'b1',
      content: '答B-1',
      answersKey: 'q1',
      answersVersion: 1,
    })
    sessionCore.append(created.id, {
      role: 'assistant',
      key: 'b2',
      content: '答B-2',
      answersKey: 'q1',
      answersVersion: 1,
    })
    /* 第二层（后续链）：那一轮是在 B 版之后发的 */
    sessionCore.append(created.id, {
      role: 'user',
      key: 'q2',
      content: '后续问题',
      parentKey: 'q1',
      parentVersion: 1,
    })
    sessionCore.append(created.id, {
      role: 'assistant',
      key: 'c1',
      content: '后续回答',
      answersKey: 'q2',
      answersVersion: 0,
    })
    /* 用户选了「B 版的第 1 条回答」（选择写回提问记录，同一 key 追加） */
    sessionCore.append(created.id, {
      role: 'user',
      key: 'q1',
      content: 'B 内容',
      versions: ['A 内容', 'B 内容'],
      versionIndex: 1,
      answerIndexByVersion: { 0: 0, 1: 0 },
    })

    const back = sessionCore.load(created.id)
    check(
      '★ 第 1 层分叉恢复：提问停在用户选的版本（B）',
      back.messages[0]?.versionIndex === 1,
      String(back.messages[0]?.versionIndex),
    )
    check(
      '★ 版本表原样回来（面包屑/分支树的选项数据）',
      JSON.stringify(back.messages[0]?.versions) === JSON.stringify(['A 内容', 'B 内容']),
    )
    check(
      '★ 第 2 层分叉恢复：露的是用户选的第 1 条回答',
      back.messages[1]?.content === '答B-1',
      String(back.messages[1]?.content),
    )
    check(
      '★ 这一版的两条回答都在（切着看不重跑）',
      (back.messages[1]?.answerRecords ?? []).filter((r) => r.answersVersion === 1).length === 2,
    )
    check(
      '★ 每版的选择分开记（v0 / v1 都在）',
      JSON.stringify(back.messages[0]?.answerIndexByVersion) === JSON.stringify({ 0: 0, 1: 0 }),
      JSON.stringify(back.messages[0]?.answerIndexByVersion),
    )
    check(
      '★ 后续链按「当时那一版」留着（parentVersion=1 对得上）',
      back.messages.length === 4,
      String(back.messages.length),
    )
    check('后续那轮内容在', back.messages[3]?.content === '后续回答')

    /* 切回 A 版：后续链整条跟着退出（这就是「切换分支，整条后续链跟着走」） */
    sessionCore.append(created.id, {
      role: 'user',
      key: 'q1',
      content: 'A 内容',
      versions: ['A 内容', 'B 内容'],
      versionIndex: 0,
    })
    const backA = sessionCore.load(created.id)
    check(
      '★ 切回 A 版：后续那轮整条退出',
      backA.messages.length === 2,
      String(backA.messages.length),
    )
    check(
      'A 版露的是 v0 自己的回答（不是 B 的）',
      backA.messages[1]?.content === '答A-1',
      String(backA.messages[1]?.content),
    )
    check(
      '★ 各版标签没串（0 + 1,1 各归各）',
      (backA.messages[1]?.answerRecords ?? []).map((r) => r.answersVersion).join(',') === '0,1,1',
      (backA.messages[1]?.answerRecords ?? []).map((r) => r.answersVersion).join(','),
    )
  } finally {
    sessionCore.remove(created.id)
  }
}
