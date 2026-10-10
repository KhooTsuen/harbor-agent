import { join, readFileSync, ROOT, require } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   带图提问（多模态）—— 2026-09-28 真机事故的回归

   用户报的原话：「DeepSeek flash 现已支持多模态，但它依然说没办法看图」。
   翻真机会话（`data/sessions/sess_muk6ue18khi5o.jsonl`）能看到**模型自己的推理**：
   「图片 base64 被 `[…上下文已按预算裁剪…]` 切掉了，只剩一段 JPEG 文件头」——
   也就是说，问题不在模型，在**内核把图片当纯文本切了**。

   这一组把三件事钉住（在修之前，这三件全是坏的）：
     · 预算裁剪**只切文本**，图片块整块留（切一半的 base64 就是坏图）
     · 图片按固定成本占预算，且**带图的那条消息总能被选上**
     · 图片能落盘、能读回、能进「恢复任务」的请求（`session.toApiMessages`）

   ⚠️ 以前 `contextBuilderCore` 在 env.mjs 里 require 了却**没有任何断言** ——
      这就是它能一路溜到真机的原因。别再删这一组。
   ══════════════════════════════════════════════════════════════ */

const contextBuilder = require(join(ROOT, 'electron/core/context-builder.cjs'))
const conversationState = require(join(ROOT, 'electron/core/conversation-state.cjs'))
const sessionCore = require(join(ROOT, 'electron/core/session.cjs'))
const presets = require(join(ROOT, 'electron/core/provider-presets.cjs'))

/** 一张「大图」：200KB 的 base64（真机上一张截图就是这个量级） */
const PNG = `data:image/png;base64,${'A'.repeat(200_000)}`
const MARK = '…上下文已按预算裁剪…'
const withImage = (text) => [
  ...(text ? [{ type: 'text', text }] : []),
  { type: 'image_url', image_url: { url: PNG } },
]

export async function run() {
  const created = []

  /* ── ① 图片不被切 ────────────────────────────────── */
  group('看图 / 预算不切图片')
  const one = contextBuilder.assemble({
    maxTokens: 4096,
    messages: [{ role: 'user', content: withImage('这是什么') }],
  })
  const parts = one.messages[0]?.content
  check(
    '带图消息仍然是**多模态数组**（不是被压成一个字符串）',
    Array.isArray(parts),
    JSON.stringify(parts)?.slice(0, 120),
  )
  check(
    '图片 data URL **原样**送出去（逐个字符比，不是"看起来差不多"）',
    parts?.[1]?.image_url?.url === PNG,
    `长度 ${String(parts?.[1]?.image_url?.url ?? '').length} / 期望 ${PNG.length}`,
  )
  check(
    '整条消息里没有出现裁剪标记',
    !JSON.stringify(one.messages).includes(MARK),
    JSON.stringify(one.messages).slice(0, 200),
  )

  /* 文字很长时：只切文字，图片照旧 */
  const mixed = contextBuilder.assemble({
    maxTokens: 2000,
    messages: [{ role: 'user', content: withImage('x'.repeat(50_000)) }],
  })
  const mixedParts = mixed.messages[0]?.content
  check(
    '文字超预算 → 文字被切（老行为不变）',
    mixedParts?.[0]?.text?.includes(MARK) === true,
    String(mixedParts?.[0]?.text ?? '').slice(-40),
  )
  check(
    '同一条里图片**没被切**（这是这次事故的核心）',
    mixedParts?.[1]?.image_url?.url === PNG,
    `长度 ${String(mixedParts?.[1]?.image_url?.url ?? '').length}`,
  )

  /* 纯图（用户一个字都没打） */
  const imageOnly = contextBuilder.assemble({
    maxTokens: 4096,
    messages: [{ role: 'user', content: withImage('') }],
  })
  check(
    '只发一张图、没有文字：这条也要选上（否则整条消失）',
    imageOnly.messages.length === 1 && imageOnly.messages[0].content.length === 1,
    JSON.stringify(imageOnly.estimates),
  )

  /* 五张图 + 一句话：不够给文字了，就丢文字，**图全留** */
  const five = contextBuilder.assemble({
    maxTokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这五张图有什么不同' },
          ...Array.from({ length: 5 }, (_, i) => ({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,AAAA${i}${'B'.repeat(1000)}` },
          })),
        ],
      },
    ],
  })
  check(
    '图多到顶满文本预算：图仍然 5 张全在、文字退场（不是把某张图切成两半）',
    five.messages[0]?.content?.filter((p) => p.type === 'image_url').length === 5 &&
      five.messages[0].content.every((p) => p.type !== 'text'),
    JSON.stringify(five.messages[0]?.content?.map((p) => p.type)),
  )

  /* 文本口径的兜底：多模态消息不该把 base64 当文本算进去 */
  const huge = contextBuilder.assemble({
    maxTokens: 4096,
    messages: [
      { role: 'user', content: withImage('第一句') },
      { role: 'assistant', content: '好的' },
    ],
  })
  check(
    '图不吃文本预算：带图那条 + 后面一条都排得进来',
    huge.messages.length === 2,
    JSON.stringify(huge.estimates),
  )

  /* ── ② 会话状态认得带图提问 ──────────────────────── */
  group('看图 / 状态摘要')
  const state = conversationState.update(null, [
    { role: 'user', content: withImage('看看这张截图里的报错') },
  ])
  check(
    '带图提问的**文字部分**要进「当前焦点」（以前整条被跳过，焦点退回上一条无关的旧消息）',
    state.currentFocus.includes('看看这张截图里的报错'),
    JSON.stringify(state.currentFocus),
  )
  check(
    'base64 **不能**进状态摘要（那是纯噪音）',
    !JSON.stringify(state).includes('AAAAAAAA'),
    JSON.stringify(state).slice(0, 120),
  )

  /* ── ③ 落盘 / 读回 / 恢复任务 ─────────────────────── */
  group('看图 / 会话读写')
  const meta = sessionCore.create({ title: '看图回归', mode: 'pair', workdir: '' })
  created.push(meta.id)
  sessionCore.append(meta.id, { role: 'user', content: '（图片）', images: [PNG], ts: Date.now() })
  sessionCore.append(meta.id, { role: 'assistant', content: '我看到一张图', ts: Date.now() })

  const loaded = sessionCore.load(meta.id)
  check(
    '读回会话时图片还在（`images` 字段要跟着回来）',
    loaded?.messages?.[0]?.images?.[0] === PNG,
    `messages=${loaded?.messages?.length}`,
  )
  const api = sessionCore.toApiMessages(meta.id, 20)
  check(
    '「恢复任务」的请求里也是多模态数组（只发文字的话模型只会回"没收到图片"）',
    Array.isArray(api[0]?.content) && api[0].content[1]?.image_url?.url === PNG,
    JSON.stringify(api[0]?.content)?.slice(0, 120),
  )
  check(
    '恢复任务那条同样没有裁剪标记',
    !JSON.stringify(api).includes(MARK),
    JSON.stringify(api).slice(0, 160),
  )

  /* ── ④ 能力声明（用户报的另一半） ─────────────────── */
  group('看图 / 能力声明')
  check(
    'deepseek-flash 声明为支持读图（以前写死 vision:false，于是贴图就弹"会失败"）',
    presets.match('deepseek-flash')?.caps?.vision === true,
    JSON.stringify(presets.match('deepseek-flash')?.caps),
  )
  check(
    'deepseek 只有 flash 系声明支持读图；**v4-pro 官方不支持**（2026-10-11 照定价页更正）',
    presets.match('deepseek-v4-pro')?.caps?.vision === false,
    JSON.stringify(presets.match('deepseek-v4-pro')?.caps),
  )
  check(
    '老规则不受影响：deepseek-reasoner / 别家的纯文本模型仍是"不能读图"',
    presets.match('deepseek-reasoner')?.caps?.vision === false &&
      presets.match('qwen-max')?.caps?.vision === false,
    JSON.stringify([presets.match('deepseek-reasoner')?.caps?.vision, presets.match('qwen-max')?.caps?.vision]),
  )

  /* ── ⑤ 文本口径只有一处（防复发） ─────────────────── */
  group('看图 / 文本口径只有一处')
  const msgText = require(join(ROOT, 'electron/core/message-text.cjs'))
  check('字符串原样', msgText.textOf('你好') === '你好')
  check(
    '多模态数组取 text、**不带 base64**',
    msgText.textOf([{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: PNG } }]) ===
      '看图',
  )
  check(
    'undefined / null / 数字 → 空串（不抛异常、不产生 [object Object]）',
    msgText.textOf(undefined) === '' && msgText.textOf(null) === '' && msgText.textOf(123) === '',
  )
  check(
    'countImages 数得对',
    msgText.countImages([{ type: 'image_url' }, { type: 'text', text: 'x' }]) === 1 &&
      msgText.countImages('纯文本') === 0,
  )
  /*
   * 源码守位：以前「怎么把 content 变成文本」每个文件各写一遍，各写各的错
   * （context-builder 切坏了图、conversation-state 整条跳过、scene/diagnostics 渲染成
   * [object Object]）。现在统一 require message-text.cjs —— 少一个就会退回老毛病。
   */
  const users = [
    'electron/core/context-builder.cjs',
    'electron/core/conversation-state.cjs',
    'electron/core/session-read.cjs',
    'electron/handlers/chat-parts.cjs',
    'electron/handlers/scene.cjs',
    'electron/core/diagnostics.cjs',
  ]
  const missing = users.filter((rel) => !readFileSync(join(ROOT, rel), 'utf8').includes('message-text.cjs'))
  check('这 6 个文件都走 message-text.cjs 的统一口径', missing.length === 0, missing.join(', '))

  /* 收尾：把测试建的会话删掉（别在 data/sessions 里留垃圾） */
  for (const id of created) sessionCore.remove(id)
}
