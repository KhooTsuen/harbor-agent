/**
 * 自检 / P0-1 历史按完整轮次截取（2026-10-23）
 *
 * 用户 2026-10-23 的 P0 表第 1、2 项原来在同一个文件里。第二轮给 P0-1 补了
 * 「折叠摘要」那一整块判据之后这个文件到 335 行（硬约束 #2 是 300），于是按
 * 「判据属于哪一件事」拆开：**本组只钉历史窗口**，压缩那一半在
 * `182-p0-compact-write.mjs`（两组不共享状态，断言一条没改）。
 *
 * ── 这一组钉什么 ─────────────────────────────────────────────
 *
 * P0-1 的失败形态是「请求发出去才发现不对」：先展开工具记录、再按**条数**截取
 * → 一组工具调用被切成两半，上游 400「tool_call_id 无对应」。用户的观察是
 * 「30 次工具调用之后发一句『那个地方接着改』，最终请求里只剩这一句」。
 *
 * 2026-10-23 第二轮：上一版只钉了「最后一轮整轮在」，但真机症状还在 —— 上一轮
 * 30 次工具调用展开成 61 条，预算 20（默认 historyLimit）→ 那一轮**整轮被丢**。
 * 所以现在断言的是**三个要点必须进最终请求**：
 *
 *   ① 上一轮的用户目标（「把 userStore 拆成两个文件」）
 *   ② 上一轮的明确约束（「不要改 public API」「不要引入新依赖」）
 *   ③ 上一轮的最终结论（「结论：拆完了，npm test 全绿」）
 *
 * 而且看的是**发送前实际请求载荷**：`buildHistory → windowHistory →
 * buildChatBody → JSON`（`buildChatBody` 就是 `llm.cjs` 发出去的那个 body 的
 * 唯一构造函数），不是「磁盘上有什么」。0 / 1 / 30 / 100 四档都跑；
 * 另有一条**反证**（关掉折叠时这三个要点确实不在载荷里），确保断言有牙齿。
 */

import { check, group } from '../harness.mjs'
import { join, readFileSync, require, ROOT, session } from '../env.mjs'

const windowCore = require(join(ROOT, 'electron/core/history-window.cjs'))
/* 请求体的唯一构造函数（llm.cjs 就是用它拼 body 的） */
const bodyCore = require(join(ROOT, 'electron/core/llm-body.cjs'))
/* 主进程那一道字符预算裁剪（loop-prompt 每轮都过它） */
const contextBuilder = require(join(ROOT, 'electron/core/context-builder.cjs'))

/* ── 三个要点：写死在夹具里，断言也按原文比（不模糊匹配） ── */
const GOAL = '目标：把 userStore 拆成两个文件'
const LIMIT_A = '不要改 public API'
const LIMIT_B = '不要引入新依赖'
const CONCLUSION = '结论：拆完了，npm test 全绿'

/** 上一轮的助手消息（磁盘形态：一条记录 + toolRuns） */
function assistantWithRuns(n) {
  return {
    role: 'assistant',
    content: n > 0 ? `${CONCLUSION}（跑了 ${n} 次工具）` : CONCLUSION,
    toolRuns: Array.from({ length: n }, (_, i) => ({
      name: 'run_shell',
      ok: true,
      output: `out#${i}`,
    })),
  }
}

/** 磁盘记录 → 展开后的 API 消息（与 session-replay 同形状） */
function expandOf(history) {
  return history.flatMap((m) => {
    const runs = m.toolRuns ?? []
    if (m.role !== 'assistant' || runs.length === 0) return [{ role: m.role, content: m.content }]
    const id = (k) => `replay_x_${k}`
    return [
      {
        role: 'assistant',
        content: m.content,
        tool_calls: runs.map((_, k) => ({
          id: id(k),
          type: 'function',
          function: { name: 'run_shell', arguments: '{}' },
        })),
      },
      ...runs.map((_, k) => ({ role: 'tool', tool_call_id: id(k), content: `run_shell: 成功\nout#${k}` })),
    ]
  })
}

/** 展开后的消息里，有没有「tool 消息找不到对应 tool_calls」或反过来的情况 */
function orphanOf(messages) {
  const callIds = new Set()
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) callIds.add(call.id)
  }
  const tools = messages.filter((m) => m.role === 'tool')
  const orphans = tools.filter((m) => !callIds.has(m.tool_call_id))
  const dangling = [...callIds].filter((id) => !tools.some((m) => m.tool_call_id === id))
  return { orphans: orphans.length, dangling: dangling.length }
}

/**
 * 交给模型的那一份 → **发送前的实际请求载荷**（字符串）。
 *
 * 走的就是 `llm.cjs` 里那唯一一次构造（`buildChatBody` + JSON.stringify），
 * 所以这里断言的是「线上会发出去的内容」，不是「我们以为发出去的内容」。
 */
function payloadOf(messages) {
  const body = bodyCore.buildChatBody({ model: 'probe-model', messages, stream: true })
  return JSON.stringify(body)
}

export async function run() {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

  group('P0-1 / groupTurns：轮次边界')
  const turns = windowCore.groupTurns([
    { role: 'system', content: '摘要' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'tool', tool_call_id: 't' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ])
  check('★ 开头的系统段单独成一组（压缩摘要钉住）', turns.length === 3, turns.length)
  check('★ 第一组只有那条系统消息', turns[0].messages.length === 1 && turns[0].messages[0].role === 'system')
  check('★ 工具消息跟着它那一轮（不另起一轮）', turns[1].messages.length === 3)
  check(
    '★ 开头系统段被认成「钉住」（不参与预算）',
    windowCore.isPinnedTurn(turns[0]) && !windowCore.isPinnedTurn(turns[1]),
  )

  group('P0-1 / 0 / 1 / 30 / 100 次工具调用：三个要点必须进最终请求')
  for (const n of [0, 1, 30, 100]) {
    const history = [
      { role: 'user', content: `${GOAL}\n约束：${LIMIT_A}，${LIMIT_B}。` },
      assistantWithRuns(n),
      { role: 'user', content: '那个地方接着改' },
    ]
    const expanded = expandOf(history)

    /* 默认预算（设置里 historyLimit 的默认值 20）：真机复现用的就是它 */
    const squeezed = windowCore.takeTurns(expanded, 20, { minTurns: 1 })
    const orphan = orphanOf(squeezed.kept)
    check(
      `★ ${n} 次工具 + 预算 20：没有孤立 tool 消息、也没有悬空 tool_calls`,
      orphan.orphans === 0 && orphan.dangling === 0,
      JSON.stringify(orphan),
    )
    check(
      `★ ${n} 次工具 + 预算 20：最后一轮（「那个地方接着改」）整轮都在`,
      squeezed.kept.some((m) => m.role === 'user' && m.content === '那个地方接着改'),
    )

    const payload = payloadOf(squeezed.kept)
    check(`★★ ${n} 次工具：上一轮的**用户目标**进了实际请求载荷`, payload.includes(GOAL))
    check(`★★ ${n} 次工具：上一轮的**明确约束**进了实际请求载荷（两条都要）`, payload.includes(LIMIT_A) && payload.includes(LIMIT_B))
    check(`★★ ${n} 次工具：上一轮的**最终结论**进了实际请求载荷`, payload.includes(CONCLUSION))
    check(
      `★ ${n} 次工具：不再是「只剩这一句」（载荷里不只有最后那句话）`,
      payload.length > '那个地方接着改'.length * 10,
      `载荷 ${payload.length} 字符`,
    )

    if (n > 20) {
      /*
       * 装不下整轮 → 折叠。2026-10-23 第三轮改了折叠产物的形状：
       * 原角色 + 低信任数据 —— 工具只给条数 / 字数 / 指纹，**正文不搬**。
       */
      check(`★ ${n} 次工具：确实折叠了（预算装不下整轮）`, squeezed.foldedTurns === 1, String(squeezed.foldedTurns))
      const digest = squeezed.kept.find((m) => m.role === 'user' && m.content.includes('低信任数据'))
      check(`★ ${n} 次工具：工具摘要带可核对元数据（指纹）`, Boolean(digest?.content.includes('指纹 ')))
      check(
        `★ ${n} 次工具：工具输出**正文**不进任何消息（只留可核对摘要）`,
        !JSON.stringify(squeezed.kept).includes('out#0'),
      )
      check(
        `★ ${n} 次工具：超出 ${windowCore.TOOL_LINES} 条时明说「另有 N 次」（数字对得上，不编造）`,
        Boolean(digest?.content.includes(`另有 ${n - windowCore.TOOL_LINES} 次没逐条列出`)),
      )
      check(
        `★ ${n} 次工具：折叠后协议里没有任何 tool 消息（摘要不冒充工具结果）`,
        !squeezed.kept.some((m) => m.role === 'tool'),
      )
      check(
        `★ ${n} 次工具：折叠产物里没有 system 角色（历史数据不冒充系统指令）`,
        !squeezed.kept.some((m) => m.role === 'system'),
      )
    }

    /* 预算够大时整段都在，且顺序与展开后一致 */
    const roomy = windowCore.takeTurns(expanded, 10_000, { minTurns: 1 })
    check(
      `★ ${n} 次工具 + 预算充裕：一条不少、顺序不变、不折叠`,
      roomy.kept.length === expanded.length &&
        roomy.kept.every((m, i) => m.role === expanded[i].role) &&
        roomy.foldedTurns === 0,
      `${roomy.kept.length}/${expanded.length} folded=${roomy.foldedTurns}`,
    )
  }

  check('预算 0 → 一条都不带（保留 historyLimit=0 的老语义）', windowCore.takeTurns([{ role: 'user', content: 'x' }], 0).kept.length === 0)
  check(
    '钉住的系统段在预算 0 时仍然保留（摘要不该被切掉）',
    windowCore.takeTurns([{ role: 'system', content: '摘要' }, { role: 'user', content: 'x' }], 0).kept.length === 1,
  )
  check(
    'foldTurns=0 时退回「整轮丢」（旧行为，便于对照）',
    windowCore.takeTurns(expandOf([{ role: 'user', content: 'a' }, assistantWithRuns(30), { role: 'user', content: 'b' }]), 20, { foldTurns: 0 }).foldedTurns === 0,
  )
  /* 反证：不折叠时那三个要点确实**不在**载荷里 —— 证明上面的断言有牙齿 */
  const noFold = windowCore.takeTurns(
    expandOf([
      { role: 'user', content: `${GOAL}\n约束：${LIMIT_A}，${LIMIT_B}。` },
      assistantWithRuns(30),
      { role: 'user', content: '那个地方接着改' },
    ]),
    20,
    { foldTurns: 0 },
  )
  const noFoldPayload = payloadOf(noFold.kept)
  check(
    '★ 反证：不折叠时目标 / 结论都不在载荷里（这就是要修的「只剩这一句」）',
    !noFoldPayload.includes(GOAL) && !noFoldPayload.includes(CONCLUSION),
    `载荷 ${noFoldPayload.length} 字符`,
  )

  group('P0-1 / 磁盘那条路径（session.toApiMessages）也按轮次切 + 要点还在')
  const thread = session.create({ title: 'P0-1 窗口', mode: 'pair' })
  session.append(thread.id, { role: 'user', content: `${GOAL}\n约束：${LIMIT_A}，${LIMIT_B}。` })
  session.append(thread.id, assistantWithRuns(30))
  session.append(thread.id, { role: 'user', content: '那个地方接着改' })
  session.append(thread.id, { role: 'assistant', content: '改好了' })

  const api = session.toApiMessages(thread.id, 20)
  const orphanApi = orphanOf(api)
  check('★ 30 次工具调用 + limit=20：没有孤立 tool 消息', orphanApi.orphans === 0 && orphanApi.dangling === 0, JSON.stringify(orphanApi))
  check(
    '★ 最后两轮里的最后一句用户话还在（模型知道要改什么）',
    api.some((m) => m.role === 'user' && String(m.content).includes('那个地方接着改')),
  )
  check(
    '★ 那条助手回答也在（同一轮整轮保留）',
    api.some((m) => m.role === 'assistant' && String(m.content).includes('改好了')),
  )
  const diskPayload = payloadOf(api)
  check(
    '★★ 重开会话这条路：目标 / 约束 / 结论也都在实际请求载荷里',
    diskPayload.includes(GOAL) && diskPayload.includes(LIMIT_A) && diskPayload.includes(LIMIT_B) && diskPayload.includes(CONCLUSION),
  )

  /*
   * 还要再过一遍**主进程那一道字符预算裁剪**（`context-builder.assemble`，loop-prompt 每轮都调）。
   * 摘要才几百字符、conversation 层有上万字符的额度，所以它不该被裁掉 —— 但这件事得真跑，
   * 不能靠「看起来够短」。
   */
  const assembled = contextBuilder.assemble({ messages: api }).messages
  const afterBudget = payloadOf(assembled)
  check(
    '★★ 过完 context-builder 的预算裁剪后，三个要点仍在载荷里（不是被长度裁掉）',
    afterBudget.includes(GOAL) && afterBudget.includes(LIMIT_A) && afterBudget.includes(CONCLUSION),
    `${assembled.length}/${api.length} 条`,
  )

  session.remove(thread.id)
  check('测试会话已清理', session.load(thread.id) === null)
}
