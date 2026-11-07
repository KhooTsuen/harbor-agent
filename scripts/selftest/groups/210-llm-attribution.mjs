/**
 * 自检 / 210 —— 模型调用记录能不能归属到任务（P2，2026-11-05）
 *
 * 三个标识各管一段：`sessionId`（会话）、`req_*`（一次运行，`chat.cjs` 的 phaseKey）、
 * `task_*`（任务台账）。生产入口 `phaseKey = payload.taskId || requestId`，而渲染层从不
 * 发 `payload.taskId` → 指标行 `trace` 恒为 `req_*`，台账里又没有 `req_*` 字段，
 * 唯一能连的 `type:'task'` 事件还不落盘 —— 于是「这次调用属于哪个任务」永久查不回来
 * （实测 4182 行指标 × 100 条台账，一条都对不上）。
 *
 * 修法：`loop.cjs` 把 `taskId` 传给 `callModel` → `loop-model` 带下去 → 落进指标行，
 * `trace` 保留不动。
 *
 * 本组**不打桩 `chatStream`**（打了桩指标根本不落盘，等于什么都没验），只替换
 * `globalThis.fetch` 跑真实链路，再**读回磁盘上的 jsonl** 判 —— 判据是写下去又读回来的
 * 字段，不是源码里的字符串。
 */

import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, join, require } from '../env.mjs'
import { readFileSync } from 'node:fs'

export async function run() {
  group('模型调用归属（P2）')

  const paths = require(join(ROOT, 'electron/core/paths.cjs'))
  const credentials = require(join(ROOT, 'electron/core/credentials.cjs'))
  const configModule = require(join(ROOT, 'electron/core/config.cjs'))
  const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
  const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
  const metricsCore = require(join(ROOT, 'electron/core/token-metrics.cjs'))

  const before = metricsCore.summarize().requests

  credentials.set('provider:selftest-p2', 'sk-selftest-p2-123456')
  credentials.set('provider:selftest-p2-backup', 'sk-selftest-p2-backup-123456')
  const mk = (id, host) => ({
    id,
    name: id,
    baseUrl: `https://${host}/v1`,
    credentialRef: `provider:${id}`,
    chatPath: '/chat/completions',
    models: ['probe-model'],
    enabled: true,
  })
  const main = mk('selftest-p2', 'p2.invalid')
  const backup = mk('selftest-p2-backup', 'p2-backup.invalid')

  const cfg = configModule.get()
  const base = {
    ...cfg,
    activeProvider: main,
    providers: [main],
    assistant: { ...cfg.assistant, model: 'probe-model' },
    tools: { ...cfg.tools, permission: 'full' },
    memory: { ...cfg.memory, autoWrite: 'off' },
    fallback: { enabled: false, attempts: 0, retryOn: [] },
  }

  /* ── 假上游：按剧本第 n 次请求返回 ── */
  const originalFetch = globalThis.fetch
  let nth = 0
  let script = []
  const hosts = []
  const sse = (rows) => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(c) {
        const enc = new TextEncoder()
        for (const r of rows) c.enqueue(enc.encode(`${r}\n\n`))
        c.close()
      },
    }),
  })
  const answer = (text, toolCall) => {
    const delta = text ? { content: text } : {}
    if (toolCall) {
      delta.tool_calls = [
        { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.txt"}' } },
      ]
    }
    return sse([
      `data: ${JSON.stringify({ choices: [{ delta }] })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}`,
      'data: [DONE]',
    ])
  }

  const created = []
  try {
    globalThis.fetch = async (url) => {
      hosts.push(new URL(String(url)).host)
      const step = script[nth] ?? { text: '（默认）' }
      nth += 1
      if (step.error) {
        /* 抛可重试的网络错（errors.classify 认 code）——HTTP 5xx 会被归成 unknown 不重试 */
        const err = new Error('fetch failed')
        err.code = 'ECONNRESET'
        throw err
      }
      return answer(step.text ?? '好了', step.toolCall === true)
    }

    const reset = (s) => {
      nth = 0
      script = s
    }
    const run = (o) =>
      loopCore.run({
        config: base,
        workdir: SANDBOX,
        mode: 'pair',
        signal: new AbortController().signal,
        emit: () => {},
        confirm: async () => true,
        ...o,
      })

    /* ① 单任务两轮（第 1 轮要工具，第 2 轮收尾）—— trace 用真实入口的形状 req_* */
    reset([{ toolCall: true }, { text: '读完了' }])
    const a = await run({
      history: [{ role: 'user', content: '读一下 hello.txt' }],
      goal: '读一下 hello.txt',
      sessionId: 'selftest-p2-a',
      traceId: 'req_selftest_a',
    })
    created.push(a.taskId)

    /* ② 并发两个任务 */
    reset([{ text: '甲' }, { text: '乙' }])
    const [b1, b2] = await Promise.all([
      run({ history: [{ role: 'user', content: '甲' }], goal: '甲', sessionId: 'selftest-p2-b1', traceId: 'req_selftest_b1' }),
      run({ history: [{ role: 'user', content: '乙' }], goal: '乙', sessionId: 'selftest-p2-b2', traceId: 'req_selftest_b2' }),
    ])
    created.push(b1.taskId, b2.taskId)

    /* ③ 失败后重试成功 */
    reset([{ error: true }, { text: '重试后成功' }])
    const c = await run({
      history: [{ role: 'user', content: '重试' }],
      goal: '重试',
      sessionId: 'selftest-p2-c',
      traceId: 'req_selftest_c',
      config: {
        ...base,
        fallback: { enabled: true, attempts: 2, retryOn: ['network', 'server', 'timeout', 'rate_limit'] },
      },
    })
    created.push(c.taskId)

    /* ④ 降级：主供应商全挂、备用能通 */
    reset([{ error: true }, { error: true }, { text: '备用答的' }])
    const d = await run({
      history: [{ role: 'user', content: '降级' }],
      goal: '降级',
      sessionId: 'selftest-p2-d',
      traceId: 'req_selftest_d',
      config: {
        ...base,
        providers: [main, backup],
        fallback: { enabled: true, attempts: 1, retryOn: ['network', 'server', 'timeout', 'rate_limit'] },
      },
    })
    created.push(d.taskId)
  } finally {
    globalThis.fetch = originalFetch
  }

  /* ── 读回磁盘上的指标行（只看本次新增的） ── */
  const rows = (() => {
    try {
      return readFileSync(metricsCore.file(), 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .slice(before)
    } catch {
      return []
    }
  })()

  check('指标行真的写下去了', rows.length > 0, `新增 ${rows.length} 行`)
  check(
    '★ 每一行都带 `taskId` 字段（不是只靠 trace）',
    rows.length > 0 && rows.every((r) => 'taskId' in r),
    rows[0] ? `字段=${Object.keys(rows[0]).join(',')}` : '(没有行)',
  )
  check(
    '★ 每行的 taskId 都能在台账里查到',
    rows.length > 0 && rows.every((r) => r.taskId && taskCore.get(r.taskId)),
    JSON.stringify(rows.map((r) => r.taskId)),
  )
  check(
    'trace 仍是那一轮运行实例的 key（req_*），没被 taskId 顶掉',
    rows.length > 0 && rows.every((r) => String(r.trace).startsWith('req_selftest_')),
    JSON.stringify(rows.map((r) => r.trace)),
  )

  const byTask = {}
  for (const r of rows) byTask[r.taskId] = (byTask[r.taskId] ?? 0) + 1
  check(
    '一个任务跑两轮 → 同一个 taskId 两行调用',
    byTask[created[0]] === 2,
    `taskId=${created[0]} 行数=${byTask[created[0]]}`,
  )
  check(
    '并发两个任务 → 各 1 行，没并到一起',
    byTask[created[1]] === 1 && byTask[created[2]] === 1,
    `${created[1]}=${byTask[created[1]]} ${created[2]}=${byTask[created[2]]}`,
  )

  /* ★ 并发最容易出错的地方：trace 与 taskId 的配对。逐行比对发起时的对应关系 */
  const pairs = [
    ['req_selftest_a', created[0]],
    ['req_selftest_b1', created[1]],
    ['req_selftest_b2', created[2]],
    ['req_selftest_c', created[3]],
    ['req_selftest_d', created[4]],
  ]
  const mismatched = rows.filter((r) => {
    const want = pairs.find(([trace]) => trace === r.trace)
    return !want || want[1] !== r.taskId
  })
  check(
    '★ trace ↔ taskId 的配对与发起时完全一致（并发没串用）',
    rows.length > 0 && mismatched.length === 0,
    JSON.stringify(mismatched.map((r) => ({ trace: r.trace, taskId: r.taskId }))),
  )

  /*
   * ★ 每次尝试都单独一行（2026-11-07 第 6 项）—— 所以这里要**挑成功那次**，
   *   而不是“第一条”：c 的第一条是失败的重试，d 的前两条是主供应商的失败。
   *   顺带把“每次都记”本身钉住：漏记重试的话，消耗会比真实少。
   */
  const rowsOf = (trace) => rows.filter((r) => r.trace === trace)
  check('★★ 重试 2 次 → 账上 2 行（失败那次也记，否则消耗会比真实少）', rowsOf('req_selftest_c').length === 2, `${rowsOf('req_selftest_c').length} 行`)
  const retried = rowsOf('req_selftest_c').find((r) => r.outcome === 'ok')
  check(
    '重试成功那次仍归属到同一个任务，且 retryIndex 记了第 2 次',
    retried?.retryIndex === 1 && retried?.taskId === created[3],
    JSON.stringify(retried && { retryIndex: retried.retryIndex }),
  )
  check('★★ 降级场景账上 3 行（主家 2 次失败 + 备用 1 次成功）', rowsOf('req_selftest_d').length === 3, `${rowsOf('req_selftest_d').length} 行`)
  const fallbackRow = rowsOf('req_selftest_d').find((r) => r.outcome === 'ok')
  check(
    '降级到备用供应商后，调用仍归属到同一个任务，且记的是**实际执行的那家**',
    fallbackRow?.providerId === 'selftest-p2-backup' && fallbackRow?.taskId === created[4],
    JSON.stringify(fallbackRow && { providerId: fallbackRow.providerId }),
  )
  check(
    '★ 失败那两行记的仍是主家（谁失败记谁，不冒功）',
    rowsOf('req_selftest_d').filter((r) => r.outcome === 'failed').every((r) => r.providerId === 'selftest-p2'),
    JSON.stringify(rowsOf('req_selftest_d').map((r) => `${r.providerId}:${r.outcome}`)),
  )

  /*
   * 辅助调用（起标题 / 起建议 / 预热 / 压缩）**不属于任何任务** —— 调用方没给
   * taskId 时必须记空串，不能瞎填一个。这里直接调 `logLlm` 钉住这条。
   */
  metricsCore.logLlm({ label: '场景 title', model: 'probe-model', providerId: 'selftest-p2' })
  const auxRow = (() => {
    try {
      const all = readFileSync(metricsCore.file(), 'utf8').trim().split('\n')
      return JSON.parse(all[all.length - 1])
    } catch {
      return null
    }
  })()
  check(
    '★ 不属于任何任务的辅助调用 → taskId 是空串（不瞎填）',
    auxRow?.taskId === '' && auxRow?.label === '场景 title',
    JSON.stringify(auxRow),
  )

  /* 收尾：把这一组建的任务删干净（见 env.mjs 的 disposeTasks 说明） */
  const { disposeTasks } = await import('../env.mjs')
  disposeTasks(created)
  check(
    '测试建的任务已清理干净',
    created.every((id) => !taskCore.get(id)),
    created.filter((id) => taskCore.get(id)).join(','),
  )
  check('数据根是隔离的（不在用户真 data 里）', paths.DIRS.data.includes('selftest'), paths.DIRS.data)
  check('打过的主机只有假域名（没联网）', hosts.every((h) => h.endsWith('.invalid')), hosts.join(','))
}
