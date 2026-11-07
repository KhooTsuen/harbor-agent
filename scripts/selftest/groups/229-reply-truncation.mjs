/**
 * 自检 / 229 —— 最终回复被截断：识别、续写、不重跑工具
 *
 * 2026-11-08 假上游实测三种结束方式：
 *   · 正常 stop       → 306 字完整 | 用户看到「完成」        | 落盘完整
 *   · finish=length   → 150 字丢一半 | 用户只看到会消失的 toast | 落盘当成完整
 *   · 中途断流（无收尾）→ 120 字      | **什么提示都没有**      | 落盘当成完整
 *
 * 正文没丢（`loop-transcript.soFar()` 保住了），丢的是**「这条没写完」这个事实**。
 * 钉三件事：① 判据分得开 ② 续写请求体里没有 tools（不可能重跑工具）③ 拼接不重复。
 * ⚠️ 全走假上游（`globalThis.fetch`），不联网、不碰真实会话。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, require, mkdirSync } from '../env.mjs'

const OPENAI_KIND = 'openai'

/** 假上游：按剧本第 n 次请求返回一段 SSE */
function sse(rows) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        for (const row of rows) controller.enqueue(enc.encode(`${row}\n\n`))
        controller.close()
      },
    }),
  }
}
const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`
const DONE = 'data: [DONE]'
const finish = (reason) =>
  `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  })}`

export async function run() {
  group('回复截断 / 判据（三种结束方式必须分得开）')
  const replyContinue = require(join(ROOT, 'electron/core/reply-continue.cjs'))
  const classify = replyContinue.classify

  check(
    '★★ 正常 stop → 不算截断',
    classify({ finishReason: 'stop', sawDone: true, content: '写完了' }).cut === false,
    JSON.stringify(classify({ finishReason: 'stop', sawDone: true, content: '写完了' })),
  )
  check(
    '★★ finish_reason=length → 判截断，可续写',
    (() => {
      const r = classify({ finishReason: 'length', sawDone: true, content: '一半' })
      return r.cut === true && r.reason === 'length' && r.canContinue === true
    })(),
    JSON.stringify(classify({ finishReason: 'length', sawDone: true, content: '一半' })),
  )
  check(
    '★★ 流没给收尾标记（sawDone=false）→ 判断流，可续写',
    (() => {
      const r = classify({ finishReason: '', sawDone: false, content: '断开前的内容' })
      return r.cut === true && r.reason === 'stream_cut' && r.canContinue === true
    })(),
    JSON.stringify(classify({ finishReason: '', sawDone: false, content: '断开前的内容' })),
  )
  /* ★★★ 第一版拿「没有 finish_reason」判断流，把 05 组打桩误判成断流 → 正文拼成两遍 */
  check('★★★ 没有 sawDone 字段 → 不知道，绝不判截断', (() => {
    const r = classify({ content: '有内容但没这个字段' })
    return r.cut === false && r.canContinue === false
  })(), JSON.stringify(classify({ content: '有内容但没这个字段' })))
  check(
    '★ 有工具调用 → 不算「总结被截断」（这轮还没到最后收尾）',
    classify({ finishReason: '', sawDone: false, content: 'x', toolCalls: [{}] }).cut === false,
  )
  check(
    '★ 空回复不算截断（那是另一条错：上游什么都没给）',
    classify({ finishReason: '', sawDone: false, content: '' }).cut === false,
  )
  check(
    '★★ 判据不看「最后有没有句号」—— 中文这种判法基本无效',
    (() => {
      /* ★ 必须先剥注释：文件头正解释着「不靠句号判」，不剥就会误伤（踩过好几次） */
      const src = require('node:fs')
        .readFileSync(join(ROOT, 'electron/core/reply-continue.cjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      /* 只认结构化信号；出现「以句末标点结尾就判截断」这类判法就红 */
      return !/endsWith\(['"][。.!！？?]/.test(src)
    })(),
  )

  group('回复截断 / 拼接（续写不能出现两遍同样的话）')
  const strip = replyContinue.stripOverlap
  const head = '这是第一段的最后一句。'
  check(
    '★★ 模型把最后一句重说一遍 → 接缝被去掉',
    strip(head, `${head}接着写新的内容`) === '接着写新的内容',
    JSON.stringify(strip(head, `${head}接着写新的内容`)),
  )
  check(
    '★ 没有重叠时原样返回（不许乱切）',
    strip(head, '完全不同的新内容') === '完全不同的新内容',
    JSON.stringify(strip(head, '完全不同的新内容')),
  )
  check(
    '★ 短重叠（<10 字）不切 —— 那多半是巧合，切了会吞真内容',
    strip('结尾是「总结」', '「总结」二字之后的内容').startsWith('「总结」'),
    JSON.stringify(strip('结尾是「总结」', '「总结」二字之后的内容')),
  )
  check('★ 空的那一边不炸', strip('', 'abc') === 'abc' && strip('abc', '') === '')

  group('回复截断 / 端到端（假上游：真跑 Agent Loop）')
  const configModule = require(join(ROOT, 'electron/core/config.cjs'))
  const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
  const credentials = require(join(ROOT, 'electron/core/credentials.cjs'))
  const kinds = require(join(ROOT, 'electron/core/provider-kinds.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

  mkdirSync(SANDBOX, { recursive: true })

  const cfg = configModule.get()
  const provider = {
    id: 'selftest-trunc',
    name: 'selftest-trunc',
    kind: kinds.OPENAI ?? OPENAI_KIND,
    enabled: true,
    baseUrl: 'https://trunc.invalid/v1',
    chatPath: '/chat/completions',
    models: ['trunc-model'],
    credentialRef: 'selftest-trunc-key',
  }
  try {
    credentials.set('selftest-trunc-key', 'sk-selftest-not-real')
  } catch {
    /* 写不进去也不影响：providerKey 会返回空串，请求照样打到假上游 */
  }

  const base = {
    ...cfg,
    activeProvider: provider,
    providers: [provider],
    assistant: { ...cfg.assistant, model: 'trunc-model', maxTokens: 0 },
    tools: { ...cfg.tools, permission: 'full' },
    memory: { ...cfg.memory, autoWrite: 'off' },
    fallback: { enabled: false, attempts: 0, retryOn: [] },
  }

  const realFetch = globalThis.fetch
  const created = []
  /** 每次请求记下「带没带工具」—— 这是「不会重跑工具」的硬证据 */
  let calls = []

  const play = (script) => {
    calls = []
    let nth = 0
    globalThis.fetch = async (_url, init) => {
      let body = {}
      try {
        body = init?.body ? JSON.parse(String(init.body)) : {}
      } catch {
        body = {}
      }
      calls.push({ tools: Array.isArray(body.tools) ? body.tools.length : -1, msgs: body.messages?.length ?? 0 })
      const step = script[nth] ?? script[script.length - 1]
      nth += 1
      return sse(step)
    }
  }

  const runOnce = async (name) => {
    const out = await loopCore.run({
      config: base,
      workdir: SANDBOX,
      mode: 'pair',
      signal: new AbortController().signal,
      emit: () => {},
      confirm: async () => true,
      history: [{ role: 'user', content: '写一段总结' }],
      goal: '写一段总结',
      sessionId: 'sess_selftest_trunc',
      traceId: `req_selftest_trunc_${name}`,
    })
    if (out?.taskId) created.push(out.taskId)
    return out
  }

  const FIRST = '开头部分。' + 'A'.repeat(60) + '这是第一段的结尾句子。'
  const TAIL = '这是第一段的结尾句子。' + 'B'.repeat(40) + '【真正结束】'

  try {
    /* ① 正常：一次请求，不许白花续写那次 */
    play([[delta('完整的一段回答。'), finish('stop'), DONE]])
    const normal = await runOnce('normal')
    check('★★ 正常结束只发一次请求（截断判据不许误伤）', calls.length === 1, `${calls.length} 次`)
    check('★ 正常结束不带截断标记', !normal.truncated, JSON.stringify(normal.truncated))

    /* ② length → 续写一次 */
    play([
      [delta(FIRST.slice(0, 30)), delta(FIRST.slice(30)), finish('length'), DONE],
      [delta(TAIL), finish('stop'), DONE],
    ])
    const once = await runOnce('length')
    check('★★ length 之后真的又发了一次（续写发生）', calls.length === 2, `${calls.length} 次`)
    check('★★★ 续写那次请求体里没有 tools —— 结构上不可能重跑已完成的工具', calls[1]?.tools === -1, `第 2 次 tools=${calls[1]?.tools}（-1=字段不存在）`)
    check('★ 第一次请求是带工具的（对照组，证明确实是「续写才不带」）', calls[0]?.tools > 0, String(calls[0]?.tools))
    check('★★ 续完后正文是两段拼起来的（没丢第一段）', once.content.includes('【真正结束】') && once.content.includes(FIRST.slice(0, 10)), `长度 ${once.content.length}`)
    check('★★ 拼完没有重复段落', !once.content.includes('这是第一段的结尾句子。这是第一段'), JSON.stringify(once.content.slice(-40)))
    check('★ 救回来了 → 不标截断', !once.truncated, JSON.stringify(once.truncated))

    /* ③ 中途断流（没有 [DONE]，也没 finish_reason）→ 也续 */
    play([
      [delta(FIRST.slice(0, 30)), delta(FIRST.slice(30))],
      [delta('补完的部分。【真正结束】'), finish('stop'), DONE],
    ])
    const cut = await runOnce('cut')
    check('★★ 断流也会续写', calls.length === 2, `${calls.length} 次`)
    check('★ 断流续写同样不带工具', calls[1]?.tools === -1, String(calls[1]?.tools))
    check('★ 断流续写后正文完整', cut.content.includes('【真正结束】'), JSON.stringify(cut.content.slice(-20)))

    /* ④ 一直截断 → 续满上限就停，如实标「没写完」 */
    play([
      [delta('第一段。'), finish('length'), DONE],
      [delta('第二段。'), finish('length'), DONE],
      [delta('第三段。'), finish('length'), DONE],
    ])
    const endless = await runOnce('endless')
    check(
      '★ 一直截断时续写有上限（不是死循环）',
      calls.length === 1 + replyContinue.MAX_CONTINUE,
      `${calls.length} 次（上限 ${replyContinue.MAX_CONTINUE}）`,
    )
    check(
      '★★★ 救不回来就如实标截断（不伪装成完整完成）',
      endless.truncated === 'length',
      JSON.stringify(endless.truncated),
    )

    /* ⑤ 用户主动中止 → 绝不续写 */
    play([[delta('一半就停。')]])
    const controller = new AbortController()
    const stopping = loopCore.run({
      config: base,
      workdir: SANDBOX,
      mode: 'pair',
      signal: controller.signal,
      emit: () => {},
      confirm: async () => true,
      history: [{ role: 'user', content: '写' }],
      goal: '写',
      sessionId: 'sess_selftest_trunc',
      traceId: 'req_selftest_trunc_abort',
    })
    controller.abort()
    let abortErr = null
    try {
      const out = await stopping
      if (out?.taskId) created.push(out.taskId)
    } catch (error) {
      abortErr = error?.name ?? 'other'
    }
    check('★★ 用户按停 → 抛中止错误（不是「模型失败」）', abortErr === 'AbortError', String(abortErr))
    check('★★ 用户按停后一次续写请求都不发（他要停，你接着写是抗命）', calls.length <= 1, `${calls.length} 次`)
  } finally {
    globalThis.fetch = realFetch
    /* 收尾：把这一组建的任务删干净（见 env.mjs 的 disposeTasks 说明） */
    try {
      for (const id of created) taskCore.remove?.(id)
    } catch {
      /* 删不掉不影响结论 */
    }
  }

  group('回复截断 / 接线（信号必须真的从内核传到落盘与界面）')
  const read = (rel) => require('node:fs').readFileSync(join(ROOT, rel), 'utf8')

  check('★★ loop.cjs 收尾前调了续写（不是写了个没人用的模块）', /finishReply\(/.test(read('electron/core/loop.cjs')))
  check(
    '★★ loop.cjs 把 truncated 往上带（缺了这一行，下面全白做）',
    /truncated:\s*reply\.cut/.test(read('electron/core/loop.cjs')),
  )
  check('★★ done 事件带 truncated（渲染层才知道这条没写完）', /truncated:\s*result\.truncated/.test(read('electron/handlers/chat.cjs')))
  check('★★ 渲染层收到就标上', /truncated:\s*event\.truncated/.test(read('src/stores/thread/streamEvents.ts')))
  check('★★ 落盘也写（否则重开会话看不出来）', /final\.truncated/.test(read('src/stores/thread/replyPersistence.ts')))
  check(
    '★★ 读盘映射进 UI（漏一行就是「明明存了但看不见」）',
    /stored\.truncated/.test(read('src/stores/app/disk.ts')),
  )
  check(
    '★ 续写真的把 tools 传空了（这是「不重跑工具」的实现处）',
    /tools:\s*\[\]/.test(read('electron/core/reply-continue.cjs')),
  )
  check(
    '★ 界面有一句说明（不然用户以为模型就写了这么多）',
    /* 2026-11-08：那句说明搬到了 message/ReplyNotes.tsx（MessageItem 撞 300 行红线） */
    /truncated/.test(read('src/components/chat/message/ReplyNotes.tsx')),
  )
  check('★ 导出也带上（读文件的人不该以为那是全篇）', /message\.truncated/.test(read('src/lib/export.ts')))
}
