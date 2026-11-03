/**
 * 自检 / 侧边栏「显示整条会话」（2026-11-03）
 *
 * ── 这一组钉什么 ───────────────────────────────────────────────
 *
 * 用户的原话是「侧边栏对话流内的已有功能应于 Harbor agent 保持一致，尽量减少分裂感」。
 * 以前侧边栏只显示**当前这一轮**（靠 `chat:event` 推流），打开面板看不到之前说过
 * 什么 —— 主窗口是整条会话。这次加了 `session:messages` 与侧边栏的消息列表。
 *
 * 四条都必须真跑 / 真扫，因为它们各自会**静默错**：
 *
 *   ① **切片与预算**（`ext-session-messages.cjs`，纯函数）：单帧上限 1 MiB 是硬约束，
 *      开发版有一条 141 MB 的会话 —— 切错了不是「慢」，是**根本传不过去**。
 *   ② **合并规则**（`mergeMessages.ts`，纯函数）：历史里已经落了盘的那一轮如果又
 *      从「正在流」那条接一遍，用户会看到**同一问一答出现两遍**，而且不报错。
 *   ③ **协议接线**：kind 表 / 分派表 / host 转发 / SW 路由 / 面板消息名五处
 *      必须同时有，漏一处就是「侧边栏问不到历史」而没有任何报错。
 *      这是本项目栽过四次的那类事故，所以这里逐处扫源码钉。
 *   ④ **验收锚点只留一处**：`回复正文` 以前只有正在流的那条带；现在历史也会画
 *      assistant 正文，若历史也带这个 label，`accept-phase3b` 的
 *      `document.querySelector` 会读到**最早那条旧回复** —— 脚本照跑、判据看着还绿。
 */

import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => readFileSync(join(ROOT, p), 'utf8')
const SRC = 'harbor-edge/src/sidepanel'

/** Node 24 能直接 import .ts（纯函数文件，没有 JSX）—— 与 176 组同一写法 */
async function importTs(name) {
  return import(`file:///${join(ROOT, SRC, name).replace(/\\/g, '/')}`)
}

export async function run() {
  const M = require(join(ROOT, 'electron/core/ext-session-messages.cjs'))
  const Mg = await importTs('mergeMessages.ts')

  /* ══════════════════════════════════════════════════════════════
     ① 切片与预算（内核侧唯一的判据）
     ══════════════════════════════════════════════════════════════ */
  group('侧边栏整条会话 · 切片与字节预算')

  const mk = (n, text = 'x') =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${text}${i}`,
      ts: 1000 + i,
    }))

  const small = M.messagesOf({ messages: mk(4) })
  check('★★ 正常规模原样带出（4 条 → 4 条，不丢）', small.messages.length === 4 && small.dropped === 0)
  check('★ 顺序保持不变（尾部才是最新的）', small.messages[3].text === 'x3')
  check('★ 没被截断就不说截断', small.truncated === false)
  check('★★ 每条都带 timestamp（界面要显示先后）', small.messages.every((m) => typeof m.timestamp === 'number'))

  const many = M.messagesOf({ messages: mk(200) })
  check('★★★ 条数上限生效（只带尾部，不整篇塞）', many.messages.length <= M.MAX_MESSAGES)
  check('★★★ 丢掉多少如实报（界面说「还有 N 条没显示」）', many.dropped === 200 - many.messages.length && many.dropped > 0)
  check('★★ 带出来的是**最新**那几条（尾部），不是开头', many.messages[many.messages.length - 1].text === 'x199')

  /* 单条超长：截断并标记（不静默丢内容） */
  const longOne = M.messagesOf({ messages: [{ role: 'assistant', content: 'a'.repeat(M.MAX_TEXT + 500), ts: 1 }] })
  check('★★★ 单条超长被截断（不是整条丢掉）', longOne.messages.length === 1)
  check('★★ 截断如实标记', longOne.messages[0].truncated === true && longOne.messages[0].text.length === M.MAX_TEXT)

  /* 字节预算：条数没超但总量超 → 也要砍，且从**头部**砍 */
  const fat = M.messagesOf(
    { messages: Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: '汉'.repeat(6000), ts: i })) },
    { budgetBytes: 60 * 1024 },
  )
  const bytes = fat.messages.reduce((n, m) => n + m.text.length * 3, 0)
  check('★★★ 总字节超预算时继续丢（单帧 1 MiB 是硬上限）', bytes <= 60 * 1024)
  check('★★ 预算砍掉的也算进 dropped（界面据实说）', fat.dropped > 0)

  /* 工具记录瘦身：只留名字/成败/耗时，失败的带一句原因 */
  const withTools = M.messagesOf({
    messages: [
      {
        role: 'assistant',
        content: '',
        ts: 2,
        toolRuns: [
          { name: 'read_file', ok: true, ms: 30, output: 'Z'.repeat(9000) },
          { name: 'run_shell', ok: false, ms: 12, output: 'E'.repeat(9000) },
        ],
      },
    ],
  })
  check('★★ 成功的工具不带输出（侧边栏不显示，省字节）', withTools.messages[0].toolRuns[0].output === '')
  check('★★ 失败的工具带一句原因（界面要能看出为什么红了）', withTools.messages[0].toolRuns[1].output.length > 0)
  check('★ 工具输出不会原样带 9000 字过去', withTools.messages[0].toolRuns[1].output.length < 400)

  /* system / tool 角色：tool 不单独出一条（信息已在那条 assistant 的 toolRuns 里） */
  /* 工具摘要：磁盘上本来就有 summary（主窗口靠它说「读取 README.md」）—— 侧边栏以前漏带 */
  const withSummary = M.messagesOf({
    messages: [
      {
        role: 'assistant',
        content: '',
        ts: 3,
        toolRuns: [
          { name: 'read_file', ok: true, ms: 8, summary: 'E:/CodexWorkbench/README.md' },
          { name: 'run_shell', ok: true, ms: 4, summary: 'x'.repeat(M.MAX_TOOL_SUMMARY + 50) },
        ],
      },
    ],
  })
  check(
    '★★★ 工具摘要带出去了（主窗口说「读取 README.md」，侧边栏不能只说「读取文件」）',
    withSummary.messages[0].toolRuns[0].summary === 'E:/CodexWorkbench/README.md',
  )
  check(
    '★★ 摘要有上限（不把整条命令参数原样搬过去）',
    withSummary.messages[0].toolRuns[1].summary.length === M.MAX_TOOL_SUMMARY,
  )

  /*
   * 工具记录也要进字节预算。一条消息最多带 30 条工具，每条现在还有摘要 ——
   * 以前 sizes 只算正文 + 思考 + 400，这种「正文很短、工具很多」的消息会把预算估小。
   * 预算 2000 时：算了工具字节 → 前面那条短消息被丢掉（只剩带工具这条）；
   * 没算的话两条都留得住（403 + 400 < 2000）—— 所以这条判据能分出改没改。
   */
  const heavyTools = M.messagesOf(
    {
      messages: [
        { role: 'user', content: '短', ts: 4 },
        {
          role: 'assistant',
          content: '',
          ts: 5,
          toolRuns: Array.from({ length: 30 }, () => ({
            name: 'read_file',
            ok: true,
            ms: 1,
            summary: 'y'.repeat(M.MAX_TOOL_SUMMARY),
          })),
        },
      ],
    },
    { budgetBytes: 2000 },
  )
  check(
    '★★ 工具记录计入预算（以前只算正文，工具多的帧可能顶到 1 MiB）',
    heavyTools.messages.length === 1 && heavyTools.dropped === 1,
  )

  const roles = M.messagesOf({
    messages: [
      { role: 'tool', content: '工具回执' },
      { role: 'system', content: '已压缩前 3 条对话' },
      { role: 'assistant', content: '回答' },
    ],
  })
  check('★★ tool 角色不单独显示（避免同一件事显示两遍）', roles.messages.every((m) => m.role !== 'tool'))
  check('★ system（压缩点）保留', roles.messages.some((m) => m.role === 'system'))

  /* ══════════════════════════════════════════════════════════════
     ② 合并规则（侧边栏侧唯一的判据）
     ══════════════════════════════════════════════════════════════ */
  group('侧边栏整条会话 · 历史与正在流的那一轮合并')

  const hist = [
    { id: 'h1', role: 'user', text: '第一问' },
    { id: 'h2', role: 'assistant', text: '第一答' },
  ]

  const idle = Mg.mergeMessages(hist, null)
  check('★★ 没有正在流的一轮 → 就是历史本身', idle.length === 2 && idle[0].text === '第一问')

  const live = { ask: '第二问', text: '正在写…', seq: 3, done: false }
  const merged = Mg.mergeMessages(hist, live)
  check('★★★ 正在流的那一轮接在末尾（提问 + 回答两条）', merged.length === 4)
  check('★★ 提问在前、回答在后', merged[2].role === 'user' && merged[3].role === 'assistant')
  check('★★ 正在流的那条标着 streaming（界面画光标）', merged[3].streaming === true)
  check('★ 历史各条的 id 原样保留（React key 不重复）', merged[0].id === 'h1')

  /* ★★★ 最容易静默错的：跑完并落盘后，历史里已有这一问一答 → 不能再接一遍 */
  const landed = [...hist, { id: 'h3', role: 'user', text: '第二问' }, { id: 'h4', role: 'assistant', text: '第二答' }]
  const afterDone = Mg.mergeMessages(landed, { ask: '第二问', text: '第二答', seq: 9, done: true })
  check('★★★ 已落盘的一轮不再重复显示（同一问答不许出现两遍）', afterDone.length === 4)
  check('★★ 重复判定按**正文**比（不是只按条数）', afterDone.filter((m) => m.text === '第二问').length === 1)

  /*
   * ★★★ 2026-11-03 真机：**流式期间**提问就重复了。
   *   用户那条消息在按下发送时就落了盘，历史里已有；以前只在 `live.done` 时才去重，
   *   于是流式那几秒里提问显示两遍（截图里的现象）。
   */
  const during = Mg.mergeMessages([...hist, { id: 'h3', role: 'user', text: '第三问' }], {
    ask: '第三问',
    text: '正在写',
    seq: 4,
    done: false,
  })
  check('★★★ 流式期间提问已落盘 → 不再重复一遍', during.filter((m) => m.text === '第三问').length === 1)
  check('★★ 流式期间回答要接上（不能因为历史有提问就丢掉正在写的内容）', during.some((m) => m.text === '正在写'))

  /* 边界：历史末尾是用户消息、还没有回答 → 提问**不再插一遍**，且不许冒出一个空气泡 */
  const pending = [...hist, { id: 'h3', role: 'user', text: '第二问' }]
  const afterPending = Mg.mergeMessages(pending, { ask: '第二问', text: '', seq: 2, done: true })
  check('★★★ 历史里只有提问、还没回答 → 不再插一遍提问', afterPending.length === 3)
  check('★★ 没有内容时不冒空回答气泡', afterPending.filter((m) => m.role === 'assistant').length === 1)

  /*
   * ★★★ 2026-11-03 真机：侧边栏的回复「半路被截断」。
   *   磁盘上一轮是分段追加的，收尾那条异步写；`done` 那刻重读常常只拿到半截快照，
   *   还被标成 interrupted。内存里的 live.text 才是全文 —— 谁长用谁。
   */
  const half = [...hist, { id: 'h3', role: 'user', text: '第二问' }]
  const fixed = Mg.mergeMessages(half, { ask: '第二问', text: '第二答的完整正文', seq: 9, done: true })
  const reply = fixed.find((m) => m.role === 'assistant' && m.text.startsWith('第二答'))
  check('★★★ 历史里只有半截时用 live 的全文补上', reply !== undefined && reply.text === '第二答的完整正文')
  const withInterrupted = Mg.mergeMessages(
    [...half, { id: 'h4', role: 'assistant', text: '半截', interrupted: true, truncated: true }],
    { ask: '第二问', text: '完整正文比半截长得多', seq: 9, done: true },
  )
  const replaced = withInterrupted.find((m) => m.text === '完整正文比半截长得多')
  check('★★★ 覆盖成全量后「没写完 / 被截断」的提示必须撤掉', replaced?.interrupted === false && replaced?.truncated === false)
  check('★★ 覆盖后只剩那一条（不是把回答拆成两条并排）', withInterrupted.filter((m) => m.text === '半截' || m.text === '完整正文比半截长得多').length === 1)

  /* 反向：live 只剩空壳（done 后流缓存清空）→ 不许把历史里的好内容冲掉 */
  const keepGood = Mg.mergeMessages(
    [...half, { id: 'h4', role: 'assistant', text: '磁盘上的完整回答' }],
    { ask: '第二问', text: '', seq: 9, done: true },
  )
  check('★★★ live 是空壳时不冲掉历史里的正文', keepGood.some((m) => m.text === '磁盘上的完整回答'))

  /* 出错那条：错误文字要带出来 */
  const errored = Mg.mergeMessages([], { ask: '问', text: '', seq: 1, done: true, error: '上游 500' })
  check('★★ 出错如实显示（不是空白）', errored.some((m) => m.error === '上游 500'))

  /* 截断提示：数字来自内核回的 dropped，不写死 */
  check('★★ 有丢弃时提示里带上真实条数', Mg.truncatedHint(12).includes('12'))
  check('★★ 没丢弃就什么都不说', Mg.truncatedHint(0) === '')

  /* ══════════════════════════════════════════════════════════════
     ③ 协议接线（五处都要在 —— 漏一处就是静默失效）
     ══════════════════════════════════════════════════════════════ */
  group('侧边栏整条会话 · 协议接线五处齐全')

  const kindsSrc = R('electron/core/ext-kinds.cjs')
  const opsSrc = R('electron/core/ext-ops.cjs')
  const loopSrc = R('electron/core/ext-host-loop.cjs')
  const swSrc = R('harbor-edge/extension/service-worker.js')
  const msgSrc = R('harbor-edge/extension/lib/messages.js')
  const smSrc = R('harbor-edge/extension/lib/session-messages.js')

  check('★★ kind 表里有 SESSION_MESSAGES', /SESSION_MESSAGES:\s*'session:messages'/.test(kindsSrc))
  check('★★ 主进程分派表接了它', /\[P\.KIND\.SESSION_MESSAGES\]/.test(opsSrc))
  check('★★ host 认 session-messages 这个 type', /type === 'session-messages'/.test(loopSrc))
  check('★★ SW 装配了处理器', /createSessionMessages\(requestHost\)/.test(swSrc))
  check('★★ 面板路由表里有它', /'session-messages':/.test(msgSrc) && /'session-messages',/.test(msgSrc))
  check('★★ 转发实现只在一处（lib/session-messages.js）', /requestHost\('session-messages'/.test(smSrc))

  /* 形状对齐：SW 回的字段名与内核给的一致（硬约束 #9：不能两边各写一套） */
  check("★★★ SW 回的是 `messages`（与内核 payload 同名字段）", /messages: Array\.isArray\(reply\.messages\)/.test(smSrc))
  check('★★★ 条数与丢弃数同名透传（total / dropped / truncated）', /total: Number\(reply\.total/.test(smSrc) && /dropped: Number\(reply\.dropped/.test(smSrc))

  /* ══════════════════════════════════════════════════════════════
     ④ 验收锚点只留一处
     ══════════════════════════════════════════════════════════════ */
  group('侧边栏整条会话 · 锚点不被历史抢走')

  const bubbleSrc = R(`${SRC}/TurnBubble.tsx`)
  const streamSrc = R(`${SRC}/MessageStream.tsx`)
  check('★★★ 只有正在流的那条带 `回复正文`（历史不抢锚点）', /anchor=\{message\.live === true\}/.test(streamSrc))
  check('★★ `anchor` 关掉时真的不带这个 label', /anchor \? \{ 'aria-label': '回复正文' \} : \{\}/.test(bubbleSrc))
  check('★★ 历史那条给了自己的 label（读不到正文时也认得出）', /历史回复错误/.test(streamSrc))
  check('★★ 侧边栏确实把整条会话交给 MessageStream', /<MessageStream/.test(R(`${SRC}/ChatPanel.tsx`)))
  check('★★ ChatPanel 里不再有第二处 `回复正文`', (R(`${SRC}/ChatPanel.tsx`).match(/aria-label="回复正文"/g) ?? []).length === 0)
}
