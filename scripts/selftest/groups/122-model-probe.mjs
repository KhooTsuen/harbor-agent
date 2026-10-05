import { check, group } from '../harness.mjs'
import { join, require, ROOT } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   能力探测（model-probe.cjs）

   这一组**不联网**：探测函数支持注入假 fetch，所以「好模型 / 只有文本的模型 /
   名字打错 / 流里报错 / 网络直接挂」这五种现场都能在这儿造出来。
   （就为了这个才把 fetchImpl 做成参数 —— 否则这些分支只能靠真机试。）

   钉住的重点是**四条硬口径里最容易被人改坏的那条**：
   探测失败或未知时必须是「未知（null）」而不是「不支持（false）」——
   把未知画成不支持等于替用户猜了。
   ══════════════════════════════════════════════════════════════ */

const probe = require(join(ROOT, 'electron/core/model-probe.cjs'))

/** 造一段 SSE */
const sse = (payloads) => `${payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')}data: [DONE]\n`
const delta = (text) => ({ choices: [{ delta: { content: text } }] })

/**
 * 假 fetch：按请求体判断「这是在探什么」，按场景决定回什么。
 * 返回值形状要跟 `Response` 对得上（探测只用 text() / json() / ok / status）。
 */
function fakeFetch({ listed = [], rejectTools = false, rejectVision = false, carryError = false } = {}) {
  return async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, status: 200, json: async () => ({ data: listed.map((id) => ({ id })) }) }
    }
    const body = JSON.parse(String(options.body ?? '{}'))
    if (carryError) {
      return { ok: true, status: 200, text: async () => sse([{ error: { message: 'Insufficient credits' } }]) }
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      if (rejectTools) return { ok: false, status: 400, text: async () => 'tools not supported' }
      return {
        ok: true,
        status: 200,
        text: async () => sse([{ choices: [{ delta: { tool_calls: [{ id: 'c1' }] } }] }]),
      }
    }
    if (Array.isArray(body.messages?.[0]?.content)) {
      if (rejectVision) return { ok: false, status: 400, text: async () => 'images not supported' }
      return { ok: true, status: 200, text: async () => sse([delta('红色')]) }
    }
    return { ok: true, status: 200, text: async () => sse([delta('hi'), { usage: { total_tokens: 3 } }]) }
  }
}

const PROVIDER = { id: 'p1', baseUrl: 'https://example.test/v1', chatPath: '/chat/completions' }
const probeWith = (model, options) =>
  probe.probeModel({ provider: PROVIDER, model, apiKey: 'k', fetchImpl: fakeFetch(options) })

/** 自检组的入口（清单里按 `run` 收） */
export async function run() {
  group('能力探测 / 纯函数')

  check('认 data: 行', probe.parseSse('data: {"a":1}').length === 1)
  check(
    '跳过 `:` 开头的保活注释（OpenRouter 会发）',
    probe.parseSse(': OPENROUTER PROCESSING\ndata: {"a":1}').length === 1,
  )
  check('跳过 [DONE]', probe.parseSse('data: [DONE]').length === 0)
  check('坏 JSON 不抛、当没有', probe.parseSse('data: {oops').length === 0)
  check(
    '取第一个有正文的 delta',
    probe.firstDelta([{ choices: [{ delta: {} }] }, { choices: [{ delta: { content: 'hi' } }] }]) === 'hi',
  )
  check(
    'reasoning_content 也算正文（思考型模型）',
    probe.firstDelta([{ choices: [{ delta: { reasoning_content: '想' } }] }]) === '想',
  )
  check('认得出工具调用', probe.hasToolCall([{ choices: [{ delta: { tool_calls: [{ id: 'c' }] } }] }]) === true)
  check('没有 tool_calls 就是 false', probe.hasToolCall([{ choices: [{ delta: { content: 'x' } }] }]) === false)
  check('认得出 usage', probe.hasUsage([{ usage: { total_tokens: 3 } }]) === true)
  check(
    '★ 流里的 error 读得出来（就是「回答空白」那个坑的源头）',
    probe.streamError([{ error: { message: 'Insufficient credits' } }]).includes('Insufficient'),
  )
  check(
    'chatUrl 缺省走 OpenAI 兼容',
    probe.chatUrl('https://a/v1', undefined) === 'https://a/v1/chat/completions',
  )
  check(
    'chatUrl 去掉多余的斜杠',
    probe.chatUrl('https://a/v1/', '/chat/completions') === 'https://a/v1/chat/completions',
  )

  group('能力探测 / 实测（注入假 fetch）')

  const good = await probeWith('m1', { listed: ['m1'] })
  check('好模型：整体 ok', good.ok === true, JSON.stringify(good.notes))
  check('好模型：能回话', good.results.connection === true)
  check('好模型：回的是 SSE', good.results.streaming === true)
  check('好模型：认工具', good.results.tool_call === true)
  check('好模型：收图片', good.results.vision === true)
  check('好模型：回 usage', good.results.usage === true)
  check('好模型：名字在清单里', good.results.listed === true)

  const textOnly = await probeWith('m1', { listed: ['m1'], rejectTools: true, rejectVision: true })
  check('★ 不认工具 → false（而不是未知）', textOnly.results.tool_call === false)
  check('★ 不收图片 → false', textOnly.results.vision === false)
  check('并且写清了为什么（HTTP 400 原话）', String(textOnly.notes.tool_call ?? '').includes('400'))
  check('能回话仍然成立（只有那两维不支持）', textOnly.results.connection === true)

  const typo = await probeWith('m-typo', { listed: ['m1', 'm2'] })
  check('★ 名字打错 → listed=false 并说清', typo.results.listed === false)
  check('提示里带上模型名', String(typo.notes.listed ?? '').includes('m-typo'))

  const streamErr = await probeWith('m1', { listed: ['m1'], carryError: true })
  check('★ 流里报错 → 探测整体失败（不带错继续往下探）', streamErr.ok === false)
  check('把上游原话带出来', String(streamErr.notes.connection ?? '').includes('Insufficient credits'))
  check(
    '★ 失败时其它维度是 null（未知），不是 false（不支持）',
    streamErr.results.tool_call === null && streamErr.results.vision === null,
  )

  const dead = await probe.probeModel({
    provider: PROVIDER,
    model: 'm1',
    apiKey: 'k',
    fetchImpl: async () => {
      throw new Error('fetch failed')
    },
  })
  check('★ 网络直接挂 → ok=false，且仍然不猜', dead.ok === false)
  check('失败原因照抄底层错误', String(dead.notes.connection ?? '').includes('fetch failed'))
  check('结果全是 null', Object.values(dead.results).every((value) => value === null))

  /* 源码级守卫：探测**不许**参与请求体构造（只影响提示，不改请求形状） */
  const { readFileSync } = require('node:fs')
  const probeSrc = readFileSync(join(ROOT, 'electron/core/model-probe.cjs'), 'utf8')
  /*
   * ⚠️ 只认**调用**（带括号）：注释里写着「不参与 buildChatBody」是在解释口径，
   *    不是违规 —— 第一版守卫就是被自己那句注释判红的（check-rules 里那条
   *    「规范检查自己不会被自己的正则误伤」踩的是同一个坑）。
   */
  check('★ 探测不调 buildChatBody（只影响提示）', !/buildChatBody\s*\(/.test(probeSrc))
  check('★ 探测不写用户配置（只记结果）', !/config\.(patch|set)\s*\(/.test(probeSrc))
}
