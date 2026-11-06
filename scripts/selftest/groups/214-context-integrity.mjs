/**
 * 自检 / P1-A + P1-B：上下文消息完整性与用量口径（2026-11-07）
 *
 * ── 这一组钉什么（P0 报告 `docs/research/context-continuity-p0-baseline-2026-11-06.md`）
 *
 * 三个病灶，全部用**真实内核函数**跑，不手搓逻辑：
 *
 *   ① `assemble` 把「一串孤立 tool」判成「历史为空」：真实会话实测 863 条 → **0 条**。
 *   ② `assemble` 里正文为空的 `assistant(tool_calls)` 算成 0 → 它的 tool 全成孤儿：
 *      30 次工具调用 + 空正文，实测 62 条 → **2 条 / 13 字符**。
 *   ③ `compact.rebuild` 的 `slice(-6)` 切出孤儿 tool：16 个用例里 **8 个**协议不合法。
 *
 * 加上 P1-B 的口径：用量必须按**最终请求体**算（展开工具记录），而不是只算正文 ——
 * 实测低估 2.3～6.3 倍，而自动压缩线判的就是那个偏小的数。
 *
 * ⚠️ 判据不止「条数变多」：每一条都同时验**协议是否合法**（每个 tool 都有对应的
 *    `assistant(tool_calls)` 带同 id、每个 `tool_calls` 的 id 都有对应的 tool）。
 *    条数变多但协议坏了，那只是把「丢内容」换成了「上游 400」，更糟。
 */

import { check, group } from '../harness.mjs'
import { join, require, ROOT } from '../env.mjs'

const builder = require(join(ROOT, 'electron/core/context-builder.cjs'))
const groups = require(join(ROOT, 'electron/core/context-groups.cjs'))
const text = require(join(ROOT, 'electron/core/context-text.cjs'))
const compact = require(join(ROOT, 'electron/core/compact.cjs'))
const bodyCore = require(join(ROOT, 'electron/core/llm-body.cjs'))

/** 协议体检：孤儿 tool（找不到调用）/ 悬空 tool_calls（找不到结果） */
function protocolOf(messages) {
  const callIds = new Set()
  for (const m of messages) for (const call of m.tool_calls ?? []) callIds.add(call.id)
  const tools = messages.filter((m) => m.role === 'tool')
  const orphans = tools.filter((m) => !callIds.has(m.tool_call_id))
  const dangling = [...callIds].filter((id) => !tools.some((m) => m.tool_call_id === id))
  return { orphans: orphans.length, dangling: dangling.length }
}

/** 一组「assistant(tool_calls) + N 条 tool」，正文可空 */
function toolGroup(ids, body = '') {
  return [
    {
      role: 'assistant',
      content: body,
      tool_calls: ids.map((id) => ({
        id,
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      })),
    },
    ...ids.map((id) => ({ role: 'tool', tool_call_id: id, content: `read_file: 成功\n${'y'.repeat(700)}` })),
  ]
}

/** 把请求体真的构造出来（llm.cjs 发出去的就是它），用来验「线上会发什么」 */
function payloadOf(messages) {
  return JSON.stringify(bodyCore.buildChatBody({ model: 'probe', messages, stream: true }))
}

export async function run() {
  group('P1-A / 分项大小：正文为空 ≠ 这条消息没内容')
  const withCalls = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  }
  check(
    '★ 空正文 + 带工具调用：算出来的大小 > 0（以前是 0 → 被当成无意义消息跳过）',
    text.sizeOfMessage(withCalls) > 0,
    String(text.sizeOfMessage(withCalls)),
  )
  check(
    '★ 空正文 + 带工具调用：比纯空消息大（tool_calls 的 id / 名字 / 参数真的占预算）',
    text.sizeOfMessage(withCalls) > text.sizeOfMessage({ role: 'assistant', content: '' }),
  )

  group('P1-A / 空正文的工具组不再连带丢失')
  const emptyBody = [
    { role: 'user', content: '把那 30 个文件都读一遍' },
    ...Array.from({ length: 30 }, (_, i) => toolGroup([`c${i}`])).flat(),
    { role: 'assistant', content: '30 个都读完了，一共 3 处问题。' },
  ]
  const keptEmpty = builder.assemble({ maxTokens: 52428, messages: emptyBody })
  const protoEmpty = protocolOf(keptEmpty.messages)
  check(
    '★★ 30 次工具 + 空正文：保留的 tool 消息 = 30 条（改前是 0 条）',
    keptEmpty.messages.filter((m) => m.role === 'tool').length === 30,
    String(keptEmpty.messages.filter((m) => m.role === 'tool').length),
  )
  check(
    '★★ 30 次工具 + 空正文：协议合法（0 孤儿 / 0 悬空）',
    protoEmpty.orphans === 0 && protoEmpty.dangling === 0,
    JSON.stringify(protoEmpty),
  )
  const payloadEmpty = payloadOf(keptEmpty.messages)
  check(
    '★★ 30 次工具 + 空正文：工具输出真的进了**实际请求体**',
    payloadEmpty.includes('read_file: 成功'),
    `载荷 ${payloadEmpty.length} 字符`,
  )
  check(
    '★ 空正文的那条 assistant 的正文仍是空串（不编造它没说过的话）',
    keptEmpty.messages
      .filter((m) => m.role === 'assistant' && (m.tool_calls ?? []).length > 0)
      .every((m) => m.content === ''),
  )

  group('P1-A / 真实会话那种形状：尾部一串孤立 tool 不清零整份历史')
  /* P0 归因复刻：866 条里绝大部分是 tool，尾部连续 26 条 tool 先被取到 */
  const realShape = [{ role: 'user', content: '对八个能力领域做只读边界审查' }]
  for (let g = 0; g < 40; g += 1) {
    realShape.push(...toolGroup([`g${g}_0`, `g${g}_1`], `第 ${g} 组读完`))
  }
  realShape.push({ role: 'user', content: '继续' })
  const keptReal = builder.assemble({ maxTokens: 52428, messages: realShape })
  const protoReal = protocolOf(keptReal.messages)
  check(
    '★★ 真实形状：不再是「0 条」（改前整份历史清零）',
    keptReal.messages.length > 0,
    String(keptReal.messages.length),
  )
  check(
    '★★ 真实形状：最后那句「继续」还在（模型得知道自己要干嘛）',
    keptReal.messages.some((m) => m.role === 'user' && m.content === '继续'),
  )
  check(
    '★★ 真实形状：协议合法（孤儿 tool 一条都不留，但别的内容照进）',
    protoReal.orphans === 0 && protoReal.dangling === 0,
    JSON.stringify(protoReal),
  )
  check(
    '★ 真实形状：工具组**要么整组进要么整组不进**（不存在半组）',
    keptReal.messages.every((m) => {
      if (m.role !== 'tool') return true
      const owner = keptReal.messages.find((x) => (x.tool_calls ?? []).some((c) => c.id === m.tool_call_id))
      return Boolean(owner)
    }),
  )
  check(
    '★ 真实形状：省了多少条要如实报出来（不是静默丢）',
    keptReal.estimates.droppedMessages > 0 &&
      keptReal.systemContext.conversationState.includes('因预算没进上下文'),
    JSON.stringify(keptReal.estimates),
  )

  group('P1-A / 记录本身残缺时单独说明原因')
  const orphanOnly = builder.assemble({
    maxTokens: 52428,
    messages: [{ role: 'user', content: '在' }, { role: 'tool', tool_call_id: 'nope', content: '孤儿' }],
  })
  check(
    '★ 孤立 tool：被排除，且说明里写的是「记录不完整」而不是「预算不够」',
    orphanOnly.messages.length === 1 &&
      orphanOnly.systemContext.conversationState.includes('工具调用记录不完整') &&
      !orphanOnly.systemContext.conversationState.includes('因预算没进上下文'),
    JSON.stringify(orphanOnly.systemContext.conversationState.slice(-60)),
  )
  check(
    '★ 孤立 tool 不会被当成「一条对话」计数（两种原因分开报）',
    orphanOnly.estimates.droppedMessages === 1 && orphanOnly.estimates.invalidMessages === 1,
    JSON.stringify(orphanOnly.estimates),
  )

  group('P1-A / 预算不足以装完整工具组时不编造')
  /* 对话层额度极小：只够放下一两次调用 */
  const tiny = builder.assemble({
    maxTokens: 2000,
    budget: { conversation: 3 },
    messages: [{ role: 'user', content: '读吧' }, ...toolGroup(['t0', 't1', 't2'], '')],
  })
  const protoTiny = protocolOf(tiny.messages)
  check(
    '★ 额度极小时：协议仍然合法（要么整组不留，要么留的是真发生过的子集）',
    protoTiny.orphans === 0 && protoTiny.dangling === 0,
    JSON.stringify(protoTiny) + ' | ' + JSON.stringify(tiny.estimates),
  )
  check(
    '★ 额度极小时：留下的一定是**连续且靠后**的那几次调用（不跳着留）',
    (() => {
      const keptIds = tiny.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
      const order = ['t0', 't1', 't2']
      const indexes = keptIds.map((id) => order.indexOf(id))
      return indexes.every((v, i) => i === 0 || v === indexes[i - 1] + 1)
    })(),
  )

  group('P1-A / 「可用消息」判据：正文为空但有工具记录，不许在挑之前就扔掉')
  /*
   * 为什么这条要单独钉：`context-builder` 修的是「挑的时候别算成 0」，
   * 而**在它之前**还有两道「这条记录算不算可用」的过滤（内核 `session-read.toApiMessages`
   * 与渲染层 `history.isUsable`）。旧判据是「正文非空或带图」—— 于是
   * `loop.cjs` 写出来的 `content: '' + toolRuns` 那种形状，在还没轮到组装时
   * **整条就没了**，它引出的那一串 tool 跟着消失（P0 实测 `sess_mw2ab` 189 条里 18 条）。
   * 修了组装层却不修这两处，等于给一个进不来的东西加座位。
   */
  const sessionReadSrc = require('node:fs').readFileSync(join(ROOT, 'electron/core/session-read.cjs'), 'utf8')
  check(
    '★ 内核可用判据里认「有工具记录」（hasToolRuns 真的参与判定）',
    /const hasToolRuns = \(m\) => Array\.isArray\(m\.toolRuns\)/.test(sessionReadSrc) &&
      /hasImages\(m\) \|\| hasToolRuns\(m\)/.test(sessionReadSrc),
  )
  const historySrc = require('node:fs').readFileSync(join(ROOT, 'src/stores/thread/history.ts'), 'utf8')
  check(
    '★ 渲染层可用判据同一条（两边各写一份就会绿一边，所以这里同时钉）',
    /\(m\.toolRuns\?\.length \?\? 0\) > 0/.test(historySrc),
  )

  group('P1-A / 压缩尾巴按工具组边界留（不再切出孤儿）')
  let bad = 0
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const tailBody of ['', '末条是正文']) {
      const history = [{ role: 'system', content: '稳定前缀' }]
      for (let g = 0; g < n; g += 1) history.push(...toolGroup([`b${g}_0`], `第 ${g} 组`))
      if (tailBody) history.push({ role: 'assistant', content: tailBody })
      const rebuilt = compact.rebuild(history, '摘要', 6)
      const proto = protocolOf(rebuilt.filter((m) => m.role !== 'system'))
      if (proto.orphans > 0 || proto.dangling > 0) bad += 1
    }
  }
  check('★★ 16 种真实形状跑 rebuild：协议不合法的 0 个（改前 8 个）', bad === 0, `不合法 ${bad} 个`)
  const rebuilt = compact.rebuild([{ role: 'system', content: 'S' }, ...toolGroup(['x0'], '正文')], '摘要', 6)
  check('★ 摘要段仍是 user 角色（背景不是指令）', rebuilt[1].role === 'user' && rebuilt[1].content.includes('摘要'))
  check('★ 系统消息原样保留在最前', rebuilt[0].role === 'system' && rebuilt[0].content === 'S')
  check(
    '★ 版本号跟着历史里已有的摘要块递增（不原地覆盖）',
    (() => {
      /* ⚠️ 摘要段不一定在 index 1 —— 只有存在 system 消息时它才排第二。
         按内容找，别按位置猜（第一版就是按位置写的，当场被这一组自己逮住）。 */
      const out = compact.rebuild(
        [{ role: 'user', content: '【之前对话的摘要 v1】\n旧的' }, { role: 'user', content: '新问题' }],
        '新的',
        6,
      )
      return out.some((m) => String(m.content ?? '').startsWith('【之前对话的摘要 v2】'))
    })(),
  )

  /*
   * P1-B（估算四项 + 口径源码守位）搬到了 `215-usage-accounting.mjs`：
   * 它回答的是另一个问题（「这个数从哪来」而不是「消息有没有丢」），
   * 顺手也让本文件回到行数红线以内。
   */

  group('P1-A / 普通聊天行为不变（没有工具调用时一个字都不该变）')
  const plain = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在' },
    { role: 'user', content: '帮我看看这个' },
  ]
  const keptPlain = builder.assemble({ maxTokens: 52428, messages: plain })
  check(
    '★ 纯文本短会话：三条原样保留、顺序不变、一个字不改',
    keptPlain.messages.length === 3 &&
      keptPlain.messages.every((m, i) => m.content === plain[i].content && m.role === plain[i].role),
  )
  check('★ 纯文本短会话：没有「因预算没进上下文」那行', keptPlain.estimates.droppedMessages === 0)

  group('P1-A / 消息组切分本身')
  const shaped = groups.groupMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'k', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'k', content: 'r' },
    { role: 'assistant', content: '答' },
  ])
  check('★ 组：user / [assistant+tool] / assistant —— 工具组当成一个整体', shaped.length === 3)
  check('★ 组：完整的那一组标 complete', shaped[1].complete === true && shaped[1].messages.length === 2)
  const broken = groups.groupMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'k2', type: 'function', function: { name: 't', arguments: '{}' } }] },
  ])
  check('★ 组：缺结果的 tool_calls 标成不完整（它自己一条都不留）', broken[0].complete === false)
}
