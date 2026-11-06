/**
 * 假上游：`tools/e2e-context-integrity.mjs` 专用的「多工具 + 空正文」上游
 *
 * ── 它要证的那件事 ────────────────────────────────────────────
 *
 * 第 1 轮：发 **12 个 tool_calls**，正文**一个字都不发**（正是 `loop.cjs` 写
 *         `content: result.content || ''` 时真实会话的形状）。
 * 第 2 轮：发纯文本收尾。
 *
 * 判据不看界面、不看日志，只看**第 2 轮那个真实请求体里有没有第 1 轮的 12 条工具结果**。
 * 这是「模型到底看到了什么」的最强证据：请求体是内核真的构造出来、真的发到 HTTP 上的东西。
 *
 * 为什么单独一个文件（不进 `fake-upstream.mjs`）：那边是「坏响应大全」，
 * 每条模式各住一个文件已经是这个项目的老做法（`fake-upstream-fail.mjs` /
 * `fake-upstream-busy.mjs` / `fake-upstream-experience.mjs`）。
 *
 * 请求体按行落 `FAKE_DUMP_PATH`（`{round, body}`）。不设就只打日志 —— 不写盘。
 *
 *   node tools/fake-upstream-context.mjs        # 监听 FAKE_PORT（默认 9978）
 */

import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 第 1 轮发几次工具调用（够多才能压出「预算被工具吃光」那个形状） */
export const TOOL_COUNT = 12

const PORT = Number(process.env.FAKE_PORT ?? 9978)

let round = 0
function sseChunk(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
}

const server = createServer((req, res) => {
  const bodyChunks = []
  req.on('data', (chunk) => bodyChunks.push(chunk))
  req.on('end', () => {
    round += 1
    const body = Buffer.concat(bodyChunks).toString('utf8')
    if (process.env.FAKE_DUMP_PATH) {
      try {
        appendFileSync(process.env.FAKE_DUMP_PATH, `${JSON.stringify({ round, body })}\n`)
      } catch {
        /* 记不下来不影响上游本身 */
      }
    }
    let messageCount = -1
    try {
      messageCount = JSON.parse(body).messages?.length ?? -1
    } catch {
      /* 坏 JSON 就报 -1，别猜 */
    }
    console.log(`[ctx] 第 ${round} 轮 · 请求体 ${body.length} 字符 · messages ${messageCount}`)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    if (round === 1) {
      /* 12 个调用一次发完（同一条 assistant 消息里），正文留空 —— 这形状正是要验的 */
      const calls = Array.from({ length: TOOL_COUNT }, (_, i) => ({
        index: i,
        id: `ctx_${i}`,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `ctx-probe-${i}.txt` }) },
      }))
      res.write(sseChunk({ tool_calls: calls }))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    res.write(sseChunk({ content: '读完了。' }))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  req.resume()
})

/*
 * ⚠️ 只有**直接运行**才监听。`e2e-context-integrity.mjs` 要 import 常量 `TOOL_COUNT`
 * —— 一 import 就起服务器的话，那个脚本会在自己 spawn 之前先占掉端口（真撞过：
 * EADDRINUSE 9978）。判据：`process.argv[1]` 就是本文件。
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[ctx] 假上游就绪：http://127.0.0.1:${PORT}/v1-ctx/ （第 1 轮 ${TOOL_COUNT} 次工具 + 空正文）`)
  })
}
