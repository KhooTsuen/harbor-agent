import fs from 'node:fs'
import path from 'node:path'
import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, require, tools } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   图像：异步任务 + generate_image 工具

   中转站的生图接口大多不是「一次调用就出图」：
   提交 → task_id → 轮询查询 → 出图。这一组用假 fetch 把整条路走一遍，
   不联网、不花钱。

   文档依据（2026-09-17，APIMart 官方文档）：
     · POST /v1/images/generations → { code:200, data:[{status:'submitted', task_id}] }
     · GET  /v1/tasks/{task_id}    → 状态 pending/processing/completed/failed
                                     成功结果在 result.images[].url
   ══════════════════════════════════════════════════════════════ */

const task = require(join(ROOT, 'electron/core/image-task.cjs'))
const llm = require(join(ROOT, 'electron/core/llm.cjs'))
const registry = require(join(ROOT, 'electron/core/tools/registry.cjs'))
const scene = require(join(ROOT, 'electron/core/scene.cjs'))

/** 最小的 Response 替身：llm 那边只用到 ok/status/json/text/headers */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from('fake-image-bytes'),
  }
}

const origin = globalThis.fetch
/** 每次用例换一段「剧本」，把请求过的 URL 记下来 */
function stubFetch(script) {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? 'GET' })
    return script(String(url), options, calls.length)
  }
  return calls
}

export async function run() {
  try {
    /* ── ① 响应解析：各家包裹层数不一样，都得认 ─────────────── */

    group('图像 / 响应解析')
    check(
      '同步响应：b64_json',
      task.pickSyncImage({ data: [{ b64_json: 'AAA' }] }) === 'data:image/png;base64,AAA',
    )
    check(
      '同步响应：url',
      task.pickSyncImage({ data: [{ url: 'https://cdn/a.png' }] }) === 'https://cdn/a.png',
    )
    check('只给了 task_id 时不算同步出图', task.pickSyncImage({ data: [{ task_id: 't1' }] }) === '')

    check(
      '拿到 task_id（标准形状）',
      task.pickTaskId({ code: 200, data: [{ task_id: 't1' }] }) === 't1',
    )
    check('拿到 task_id（data 不是数组）', task.pickTaskId({ data: { task_id: 't2' } }) === 't2')
    check('拿到 task_id（顶层 id）', task.pickTaskId({ id: 't3' }) === 't3')
    check('没有 task_id 时返回空串', task.pickTaskId({ data: [{ status: 'submitted' }] }) === '')

    check('状态统一小写', task.pickStatus({ data: { status: 'PROCESSING' } }) === 'processing')
    check('状态兼容顶层', task.pickStatus({ status: 'completed' }) === 'completed')

    check(
      '结果取 result.images[].url',
      task.pickTaskImage({ data: { result: { images: [{ url: 'https://cdn/1.png' }] } } }) ===
        'https://cdn/1.png',
    )
    check(
      '结果兼容 MJ 风格 image_urls',
      task.pickTaskImage({ data: { image_urls: ['https://cdn/2.png'] } }) === 'https://cdn/2.png',
    )
    check(
      '★ url 是字符串数组也能拿到（真机踩过：图出了但永远找不到）',
      task.pickTaskImage({
        data: { status: 'completed', result: { images: [{ url: ['https://cdn/arr.png'] }] } },
      }) === 'https://cdn/arr.png',
    )
    check(
      '★ url 数组里有多个时取第一个',
      task.pickTaskImage({
        data: { result: { images: [{ url: ['https://cdn/a.png', 'https://cdn/b.png'] }] } },
      }) === 'https://cdn/a.png',
    )
    check(
      '失败原因能读出来',
      task.pickFailReason({ data: { fail_reason: '内容审核不通过' } }) === '内容审核不通过',
    )

    /* ── ② 异步任务的完整轮询 ───────────────────────────────── */

    group('图像 / 异步任务轮询')
    let calls = stubFetch((url, options, n) => {
      if (options?.method === 'POST') {
        return jsonResponse({ code: 200, data: [{ status: 'submitted', task_id: 'task_abc' }] })
      }
      if (n === 2) return jsonResponse({ code: 200, data: { status: 'pending' } })
      if (n === 3) return jsonResponse({ code: 200, data: { status: 'processing' } })
      return jsonResponse({
        code: 200,
        data: { status: 'completed', result: { images: [{ url: 'https://cdn/out.png' }] } },
      })
    })

    let result = await llm.generateImage({
      baseUrl: 'https://api.test/v1',
      apiKey: 'k',
      model: 'gpt-image-2',
      prompt: '一只猫',
      interval: 5,
      timeout: 400,
    })

    check('异步任务最终能轮询到图', result.ok === true && result.image === 'https://cdn/out.png')
    check('轮询了 4 次（提交 + 3 次查询）', calls.length === 4, String(calls.length))
    check(
      '查询打的是 /tasks/{id}',
      calls[1].url === 'https://api.test/v1/tasks/task_abc',
      calls[1]?.url,
    )
    check('带了鉴权头之外的地址没拼错', !calls[1].url.includes('//tasks'))

    /* 同步站点：一次就出图，不该再去轮询 */
    calls = stubFetch(() => jsonResponse({ data: [{ b64_json: 'ZZZ' }] }))
    result = await llm.generateImage({
      baseUrl: 'https://sync.test/v1',
      model: 'm',
      prompt: 'p',
      interval: 5,
      timeout: 400,
    })
    check('同步站点直接用结果', result.ok && result.image === 'data:image/png;base64,ZZZ')
    check('同步站点只请求了一次', calls.length === 1, String(calls.length))

    /* 任务失败 */
    stubFetch((url, options) =>
      options?.method === 'POST'
        ? jsonResponse({ code: 200, data: [{ task_id: 'task_bad' }] })
        : jsonResponse({ code: 200, data: { status: 'failed', fail_reason: '内容审核不通过' } }),
    )
    result = await llm.generateImage({
      baseUrl: 'https://api.test/v1',
      model: 'm',
      prompt: 'p',
      interval: 5,
      timeout: 400,
    })
    check('任务失败会把上游原因带出来', result.ok === false && /内容审核不通过/.test(result.error))
    check('失败时不带 pending 标记', result.pending !== true)

    /* 超时：不能当成失败，要把 task_id 交出去 */
    stubFetch((url, options) =>
      options?.method === 'POST'
        ? jsonResponse({ code: 200, data: [{ task_id: 'task_slow' }] })
        : jsonResponse({ code: 200, data: { status: 'processing' } }),
    )
    result = await llm.generateImage({
      baseUrl: 'https://api.test/v1',
      model: 'm',
      prompt: 'p',
      interval: 5,
      timeout: 400,
      timeout: 40,
    })
    check('超时标记为 pending', result.ok === false && result.pending === true)
    check('超时把 task_id 带回来（可以稍后续查）', result.taskId === 'task_slow')

    /*
     * once 模式：只查一眼就走。
     * 用户问「那个任务现在怎么样了」时用它 —— 不该再等 5 分钟。
     */
    calls = stubFetch((url, options) =>
      options?.method === 'POST'
        ? jsonResponse({ data: [{ task_id: 'task_peek' }] })
        : jsonResponse({ code: 200, data: { status: 'processing' } }),
    )
    result = await llm.generateImage({
      baseUrl: 'https://api.test/v1',
      model: 'm',
      taskId: 'task_peek',
      once: true,
    })
    check('★ once 模式只请求一次（不轮询）', calls.length === 1, String(calls.length))
    check('★ once 模式把上游状态原样带回来', result.status === 'processing', String(result.status))

    /*
     * 超时要留下现场。
     * 之前只说「等了 5 分钟没出图」—— 什么都说明不了：是上游真的慢，
     * 还是我们压根没认出它的状态字段？现在把原始响应带上。
     */
    stubFetch((url, options) =>
      options?.method === 'POST'
        ? jsonResponse({ data: [{ task_id: 'task_x' }] })
        : jsonResponse({
            code: 200,
            data: { status: 'PROCESSING', weird_field: '上游字段名不一样' },
          }),
    )
    result = await llm.generateImage({
      baseUrl: 'https://api.test/v1',
      model: 'm',
      prompt: 'p',
      interval: 5,
      timeout: 40,
    })
    check(
      '★ 超时错误里带着原始响应（能排查了）',
      /上游字段名不一样/.test(result.error),
      result.error.slice(0, 200),
    )

    /* 只查不提交：不该再打 /images/generations（不重复扣费） */
    calls = stubFetch((url, options) =>
      options?.method === 'POST'
        ? jsonResponse({ data: [{ b64_json: 'SHOULD-NOT-HAPPEN' }] })
        : jsonResponse({
            code: 200,
            data: { status: 'completed', result: { images: [{ url: 'https://cdn/later.png' }] } },
          }),
    )
    result = await llm.generateImage({
      baseUrl: 'https://api.test/v1',
      model: 'm',
      taskId: 'task_later',
      interval: 5,
      timeout: 400,
    })
    check(
      '传 taskId 时只查询、不重新提交',
      calls.every((c) => c.method === 'GET'),
      JSON.stringify(calls),
    )
    check('能查到之前那张图', result.ok === true && result.image === 'https://cdn/later.png')
  } finally {
    globalThis.fetch = origin
  }
}
