import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
import { readFileSync } from 'node:fs'

/* ══════════════════════════════════════════════════════════════
   AG-011：流式事件批处理

   真机测出来的：主进程事件循环每被卡 5~14 秒，CPU 吃满、rss 198M
   而 JS heap 只有 10~20M。烧的不是 JS —— 是每个 token 一条
   `webContents.send` 的跨进程投递。

   这里钉的是批处理器的语义。顺序相关的两条最容易写错：
     · 换类型（正文→思考）必须先把上一段发掉，否则界面会串行
     · 收尾必须再冲一次，否则最后一段文字永远留在缓冲里
   ══════════════════════════════════════════════════════════════ */

const { createBatcher } = require(join(ROOT, 'electron/core/stream-batch.cjs'))

export async function run() {
  group('AG-011 · 流式事件批处理')

  /* ── 合并 ─────────────────────────────────────────────── */
  const seen = []
  const b = createBatcher({ send: (type, text) => seen.push([type, text]) })
  b.put('content', 'a')
  b.put('content', 'b')
  b.put('content', 'c')
  check('没到时间不会发出去', seen.length === 0)
  check('攒着的内容都在', b.pending === 'abc')
  b.flush()
  check('冲一次只发一条（三条合成一条）', seen.length === 1)
  check('合出来的文本对', seen[0][0] === 'content' && seen[0][1] === 'abc')
  b.flush()
  check('再冲不会重复发', seen.length === 1)

  /* ── 换类型：先冲上一段 ───────────────────────────────── */
  const seen2 = []
  const b2 = createBatcher({ send: (type, text) => seen2.push([type, text]) })
  b2.put('content', '正文')
  b2.put('reasoning', '思考')
  check('换类型会先把上一段冲掉（顺序不能乱）', seen2.length === 1 && seen2[0][1] === '正文')
  b2.flush()
  check('第二段随后发出', seen2.length === 2 && seen2[1][0] === 'reasoning')

  /* ── 空文本 ───────────────────────────────────────────── */
  const seen3 = []
  const b3 = createBatcher({ send: (type, text) => seen3.push([type, text]) })
  b3.put('content', '')
  check('空文本不入队', b3.pending === '')
  b3.flush()
  check('空的时候冲也不发', seen3.length === 0)

  /* ── 到时间自己冲 ─────────────────────────────────────── */
  const seen4 = []
  const b4 = createBatcher({ send: (type, text) => seen4.push([type, text]), flushMs: 20 })
  b4.put('content', 'x')
  await new Promise((r) => setTimeout(r, 80))
  check('到时间会自动冲出去（不用调用方管）', seen4.length === 1 && seen4[0][1] === 'x')

  /* ── 接线守卫 ─────────────────────────────────────────── */
  const chatSrc = readFileSync(join(ROOT, 'electron/handlers/chat.cjs'), 'utf8')
  check('chat.cjs 用了批处理器', chatSrc.includes('createBatcher({'))
  check(
    '只有 content / reasoning 走批处理',
    chatSrc.includes("type === 'content' || type === 'reasoning'"),
  )
  check('结构性事件发之前先冲缓存', chatSrc.includes('batcher.flush()'))
  check('收尾时再冲一次（否则最后一段会丢）', /finally \{[\s\S]*?batcher\.flush\(\)/.test(chatSrc))
}
