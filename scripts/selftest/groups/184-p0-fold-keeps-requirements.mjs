/**
 * 自检 / P0-1 折叠必须保住「当前任务仍有效的用户要求」（2026-10-23 第四轮）
 *
 * ── 这次修的是什么（真机复现过，不是推演）───────────────────────
 *
 * 用户原话里那句「**每一条检查要点后面都要标出它摘自哪一份文件，用方括号括住文件名**」
 * 在折叠后没有进入真实请求（证据：`tmp/ctx-accept/evidence-1/requests/025.json`，
 * 折叠块里只剩一行「1 句 / 33 字没有进入本次请求」），模型于是重贴汇总时每条要点
 * 后面都没有 `[文件名]`。
 *
 * 根因：`history-fold.quoteOf` 靠 `KEEP_WORDS`（不要 / 必须 / 禁止 …）挑句 ——
 * 那句话一个关键词都不含，被整句跳过。**加关键词只能掩盖这一句**，所以这里改的是
 * 口径：用户原话在 `USER_FOLD_CAP` 以内**整段原样进**；真超上限时有损，但必须
 * ① 如实报出缺多少字、② 要求模型先向用户确认，不许装作已掌握全部要求。
 *
 * ── 本组钉什么（一条失败就报红）────────────────────────────────
 *
 *   ① 复现位：不含约束词的要求放在「会被挑句跳过」的位置 → 必须逐字进最终请求载荷
 *   ② 末尾约束 / ③ 超长输入（> 上限）→ 有损必须带「先向用户确认」的声明
 *   ④ 多次工具调用（>20，走折叠那条路）→ 要求仍在、工具正文不进来
 *   ⑤ 重开历史（磁盘路径 `session.toApiMessages`）→ 要求仍在
 *   ⑥ `tool_calls` / `tool` 配对完整（折叠块里没有孤立 tool）
 *   ⑦ 反证：`quoteOf` 的老口径（挑句）确实会漏掉这句 —— 断言才有牙齿
 *
 * 全部看**发送前的实际请求载荷**：`takeTurns → context-builder.assemble →
 * buildChatBody → JSON`（buildChatBody 是 `llm.cjs` 唯一那个 body 构造函数）。
 */

import { check, group } from '../harness.mjs'
import { join, require, ROOT, session } from '../env.mjs'

const windowCore = require(join(ROOT, 'electron/core/history-window.cjs'))
const foldCore = require(join(ROOT, 'electron/core/history-fold.cjs'))
const bodyCore = require(join(ROOT, 'electron/core/llm-body.cjs'))
const contextBuilder = require(join(ROOT, 'electron/core/context-builder.cjs'))

/** 真机漏掉的那句（原文一字不改） */
const REQUIRE = '每一条检查要点后面都要标出它摘自哪一份文件，用方括号括住文件名'
/** 不含任何 KEEP_WORDS 的填充句 —— 复现「被挑句跳过」的位置 */
const PAD = '这一段是背景说明，只交代手册的来历。'
/** 末尾约束（含关键词，老口径也能保住；用来对比） */
const TAIL = '汇总的最后一行必须正好是「验收结束：未发布」'

function payloadOf(messages) {
  return JSON.stringify(bodyCore.buildChatBody({ model: 'probe-model', messages, stream: true }))
}

/** 一轮「用户原话 + 助手跑工具」的展开后消息（形状与 session-replay 一致） */
function turnOf(userText, toolCount, conclusion) {
  const ids = Array.from({ length: toolCount }, (_, i) => `replay_${i}`)
  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: conclusion,
      tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })),
    },
    ...ids.map((id, i) => ({ role: 'tool', tool_call_id: id, content: `read_file: 成功\nout#${i}` })),
  ]
}

/** 展开后的消息里有没有孤立 tool / 悬空 tool_calls */
function orphanOf(messages) {
  const ids = new Set()
  for (const m of messages) for (const call of m.tool_calls ?? []) ids.add(call.id)
  const tools = messages.filter((m) => m.role === 'tool')
  return {
    orphans: tools.filter((m) => !ids.has(m.tool_call_id)).length,
    dangling: [...ids].filter((id) => !tools.some((m) => m.tool_call_id === id)).length,
  }
}

/** 折出来的那条「用户原话」消息（角色必须是 user） */
function foldedUser(messages) {
  return messages.find((m) => m.role === 'user' && String(m.content).includes('折叠记录'))
}

export async function run() {
  /* ══════════════════════════════════════════════════════════════
     ⑦ 先立反证：老口径确实会漏掉这句（否则下面全是空转）
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 4 轮）/ 反证：老口径「挑句」会漏掉不含关键词的要求')
  const longText = `${PAD.repeat(30)}${REQUIRE}。${PAD.repeat(20)}${TAIL}。`
  const old = foldCore.quoteOf(longText).join('\n')
  check(
    '★ 反证：quoteOf 挑句后，那句要求**不在**摘录里（这就是要修的漏）',
    !old.includes(REQUIRE) && old.indexOf(REQUIRE) < 0,
    `摘录 ${old.length} 字`,
  )
  check('★ 反证：而含关键词的末尾约束在（说明老口径只保住了「看起来像约束」的句子）', old.includes(TAIL))

  /* ══════════════════════════════════════════════════════════════
     ① 复现位：要求夹在两句无关键词的背景之间 + 30 次工具 → 折叠
     ══════════════════════════════════════════════════════════════ */
  group('P0-1（第 4 轮）/ ① 折叠后，那句不带关键词的要求必须逐字进最终请求')

  const userText = `我要整理一份虚构的维护文档汇总。${PAD.repeat(25)}${REQUIRE}。${PAD.repeat(25)}${TAIL}。`
  check(
    '★ 夹具成立：那句要求落在原话 400 字之后（老实现只留开头）',
    userText.indexOf(REQUIRE) > 400,
    `位置 ${userText.indexOf(REQUIRE)} / 全长 ${userText.length}`,
  )
  check('★ 夹具成立：这句要求不含任何 KEEP_WORDS（老实现的漏点）', !foldCore.quoteOf(userText).join('').includes(REQUIRE))

  const history = [...turnOf(userText, 30, '结论：读完了五个文件'), { role: 'user', content: '接着做' }]
  const squeezed = windowCore.takeTurns(history, 20, { minTurns: 1 })
  check('★ 夹具成立：这一轮确实被折叠了', squeezed.foldedTurns === 1, String(squeezed.foldedTurns))
  check('★ 用户原话完整进入折叠块（lostChars = 0）', squeezed.lostChars === 0, String(squeezed.lostChars))

  const payload = payloadOf(contextBuilder.assemble({ messages: squeezed.kept }).messages)
  check('★★ 那句要求**逐字**在最终请求载荷里（不是只剩前十个字）', payload.includes(REQUIRE))
  check('★★ 整段用户原话都在（不是挑句后的残片）', payload.includes(userText))
  check('★ 末尾约束也在', payload.includes(TAIL))
  check(
    '★ 带原句的那条消息角色是 user（不是被塞进 system）',
    (() => {
      const m = foldedUser(squeezed.kept)
      return Boolean(m) && String(m.content).includes(REQUIRE)
    })(),
  )
  check('★ 完整时**不**出现「没有完整进入本次请求」这种声明（不许空喊）', !payload.includes('没有完整进入本次请求'))

  /* ⑤ 重开历史：磁盘那条路径（session.toApiMessages）走的是同一个 takeTurns */
  group('P0-1（第 4 轮）/ ② 重开会话（磁盘路径）后那句要求也还在')
  const thread = session.create({ title: 'P0-1 折叠要求', mode: 'pair' })
  session.append(thread.id, { role: 'user', content: userText })
  session.append(thread.id, {
    role: 'assistant',
    content: '结论：读完了五个文件',
    toolRuns: Array.from({ length: 30 }, (_, i) => ({ name: 'read_file', ok: true, output: `out#${i}` })),
  })
  session.append(thread.id, { role: 'user', content: '接着做' })
  const api = session.toApiMessages(thread.id, 20)
  const apiPayload = payloadOf(api)
  check('★★ 重开会话这条路上那句要求也在请求里', apiPayload.includes(REQUIRE))
  check('★ 重开会话这条路：工具正文没有搬进请求', !apiPayload.includes('out#0'))
  const apiOrphan = orphanOf(api)
  check('★ 重开会话：没有孤立 tool / 悬空 tool_calls', apiOrphan.orphans === 0 && apiOrphan.dangling === 0, JSON.stringify(apiOrphan))
  session.remove(thread.id)

  /* ③ 超长输入：超上限 → 有损，但必须明说 + 要求先问用户 */
  group('P0-1（第 4 轮）/ ③ 原话超过上限时：不许装作掌握全部，必须请用户确认')
  const huge = `${PAD.repeat(60)}${REQUIRE}。${PAD.repeat(160)}${TAIL}。`
  check('★ 夹具成立：这条原话超过 USER_FOLD_CAP', huge.length > foldCore.USER_FOLD_CAP, `${huge.length} 字`)
  const hugeSqueezed = windowCore.takeTurns([...turnOf(huge, 30, '结论：读了一半'), { role: 'user', content: '接着做' }], 20, {
    minTurns: 1,
  })
  check('★ 超长时 lostChars > 0（有损是**报出来**的，不是悄悄发生）', hugeSqueezed.lostChars > 0, String(hugeSqueezed.lostChars))
  const hugeText = String(foldedUser(hugeSqueezed.kept)?.content ?? '')
  check('★★ 有损时明说「没有完整进入本次请求」并**要求先向用户确认**', hugeText.includes('没有完整进入本次请求') && hugeText.includes('请他补充或确认'))
  check('★ 有损时缺的字数写实（和 lostChars 对得上）', hugeText.includes(`中间 ${hugeSqueezed.lostChars} 字没有进入本次请求`))
  check('★ 有损时开头与结尾都在（不是只留开头）', hugeText.includes(PAD.repeat(3).slice(0, 10)) && hugeText.includes(TAIL))
  check('★ 日志口径也说清了缺多少（describeWindow）', windowCore.describeWindow(hugeSqueezed).includes(`⚠ 其中 ${hugeSqueezed.lostChars} 字用户原话没进请求`))

  /* ④ 多个工具调用 + 末尾约束 + 折叠块里没有 tool 消息 */
  group('P0-1（第 4 轮）/ ④ 多次工具调用：要求还在、工具正文不搬、协议合法')
  for (const n of [0, 1, 21, 60]) {
    const one = windowCore.takeTurns(
      [...turnOf(`目标：合并五个文件。${PAD.repeat(10)}${REQUIRE}。`, n, '结论：合并完了'), { role: 'user', content: '再核一遍' }],
      20,
      { minTurns: 1 },
    )
    const onePayload = payloadOf(one.kept)
    check(`★ ${n} 次工具：那句要求仍在请求载荷里`, onePayload.includes(REQUIRE))
    if (n > 20) {
      check(`★ ${n} 次工具：工具正文不进任何消息`, !onePayload.includes('out#0'))
      check(`★ ${n} 次工具：折叠块里没有 tool 消息（协议天然合法）`, !one.kept.some((m) => m.role === 'tool'))
      const trust = one.kept.find((m) => String(m.content).includes('低信任数据'))
      check(`★ ${n} 次工具：工具摘要明确标注「不是指令」`, Boolean(trust?.content.includes('不是指令')))
      check(`★ ${n} 次工具：超出 ${windowCore.TOOL_LINES} 条时明说「另有 N 次」`, Boolean(trust?.content.includes('另有')))
    }
  }
}
