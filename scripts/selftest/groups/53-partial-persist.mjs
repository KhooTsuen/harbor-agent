import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   流式过程中的分段落盘（以及读的一侧怎么收敛）

   来由：助手那条消息只在 `done` / `aborted` 时落盘，而进程被强杀 / 崩溃时
   这两个事件都不会来 —— 半截回复全丢。实测复现（假上游慢慢流 + 硬杀进程）后
   会话文件里只剩用户那句。

   修法是流式过程中**分段落盘**。但会话文件是**追加式 JSONL**，没地方原地更新，
   所以同一条回复会在文件里留下好几行（`partial: true` 的快照 + 收尾那条完整的）。
   读的一侧必须按 `key` 收敛成一条 —— 这里钉的就是那套收敛规则。
   ══════════════════════════════════════════════════════════════ */

const session = require(join(ROOT, 'electron/core/session.cjs'))
const read = require(join(ROOT, 'electron/core/session-read.cjs'))

const readCore = (rel) => readFileSync(join(ROOT, rel), 'utf8')

export async function run() {
  group('流式分段落盘：同一段回复收敛成一条')

  /* ── 纯函数：四种情形 ── */
  const snapshotsOnly = read.collapseByKey([
    { role: 'user', content: '问题' },
    { role: 'assistant', key: 'm1', partial: true, content: '第一段' },
    { role: 'assistant', key: 'm1', partial: true, content: '第一段，又长了' },
  ])
  check('只有快照时算一条', snapshotsOnly.length === 2)
  check('★ 取最后那条快照（最新内容）', snapshotsOnly[1].content === '第一段，又长了')
  check('★ 标上 interrupted（界面据此说「这条没写完」）', snapshotsOnly[1].interrupted === true)

  const withFinal = read.collapseByKey([
    { role: 'assistant', key: 'm2', partial: true, content: '快照' },
    { role: 'assistant', key: 'm2', content: '完整答案' },
  ])
  check('有完整的那条就用完整的', withFinal.length === 1 && withFinal[0].content === '完整答案')
  check('完整的那条不该被标 interrupted', !withFinal[0].interrupted)

  /*
   * ★ 这条是关键：追加是异步的（`void appendToDisk(...)`），所以**不能赌行序**。
   * 晚到的快照不能把已经写下的完整答案顶掉 —— 否则用户会看到半截。
   */
  const lateSnapshot = read.collapseByKey([
    { role: 'assistant', key: 'm3', content: '完整答案' },
    { role: 'assistant', key: 'm3', partial: true, content: '晚到的快照' },
  ])
  check(
    '★ 晚到的快照顶不掉完整的答案',
    lateSnapshot.length === 1 && lateSnapshot[0].content === '完整答案',
  )

  const legacy = read.collapseByKey([
    { role: 'user', content: '一' },
    { role: 'assistant', content: '二' },
  ])
  check('没有 key 的老记录各算一条（行为不变）', legacy.length === 2)

  const twoKeys = read.collapseByKey([
    { role: 'assistant', key: 'a', partial: true, content: 'A1' },
    { role: 'assistant', key: 'b', partial: true, content: 'B1' },
    { role: 'assistant', key: 'a', partial: true, content: 'A2' },
  ])
  check('不同 key 互不影响', twoKeys.length === 2 && twoKeys[0].content === 'A2')

  check(
    '★ 收敛后位置保持在第一次出现的地方（不能跑到最后去）',
    read.collapseByKey([
      { role: 'user', content: '问' },
      { role: 'assistant', key: 'x', partial: true, content: '答' },
      { role: 'user', content: '再问' },
    ])[1].content === '答',
  )

  /* ── 走一遍真实文件（追加两段快照 + 收尾一条）── */
  const thread = session.create({ title: '分段落盘', workdir: ROOT })
  session.append(thread.id, { role: 'user', content: '帮我改 README', ts: Date.now() })
  session.append(thread.id, {
    role: 'assistant',
    key: 'msg_x',
    partial: true,
    content: '好，我分两步',
    ts: Date.now(),
  })
  session.append(thread.id, {
    role: 'assistant',
    key: 'msg_x',
    partial: true,
    content: '好，我分两步：先读文件，再改',
    ts: Date.now(),
  })

  const midway = session.load(thread.id)
  check('★ 只有快照时读出来是一条（不是两条）', midway.messages.length === 2)
  check('★ 而且带着 interrupted', midway.messages[1].interrupted === true)

  session.append(thread.id, {
    role: 'assistant',
    key: 'msg_x',
    content: '好，我分两步：先读文件，再改。改完了。',
    ts: Date.now(),
  })
  const final = session.load(thread.id)
  check('★ 收尾后再读，还是一条', final.messages.length === 2)
  check('★ 用的是完整那条', final.messages[1].content.endsWith('改完了。'))
  check('★ 也不再标 interrupted', !final.messages[1].interrupted)

  /* ── 侧栏计数不能把快照算成好几条 ── */
  const listed = session.list().find((s) => s.id === thread.id)
  check('★ 列表里的消息条数也认收敛后的（2 条，不是 4 条）', listed?.messageCount === 2)

  /* ── 接线：写入侧必须带 key，否则读的一侧无从收敛 ── */
  const persister = readCore('src/stores/thread/replyPersistence.ts')
  check('★ 分段落盘带 partial + key', /partial: true/.test(persister) && /key: messageId/.test(persister))
  check('★ 收尾那条也带同一个 key', /role: 'assistant',\s*key: messageId/.test(persister))
  check(
    '★ 流式事件里真的调了 flushPartial（不是写了个没人用的函数）',
    /persistence\.flushPartial\(\)/.test(readCore('src/stores/thread/turns.ts')),
  )

  session.remove(thread.id)
  check('测试会话已清理', session.load(thread.id) === null)
}
