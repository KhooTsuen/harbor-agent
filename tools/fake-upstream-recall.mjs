/**
 * 假上游：`tools/e2e-recall.mjs` 专用 —— 证明 `recall` 在真实链路里能跑通
 *
 * ── 它要证的那件事（两轮用户消息，共四次模型往返）───────────────
 *
 * **第一条用户消息**（第 1、2 次往返）：
 *   第 1 轮 `run_shell`（`echo RECALL_MARK_xxx`）→ 真执行
 *   第 2 轮 纯文本收尾 → 这一轮结束，工具结果**落盘**
 * **第二条用户消息**（第 3、4 次往返）：
 *   第 3 轮 `recall({ tool: 'run_shell' })` → 真读会话文件
 *   第 4 轮 纯文本收尾
 *
 * ★ 判据只看**第 4 轮那个真实请求体**：里面必须出现只有 `recall` 才会写的字样
 *   （「本会话最近 N 次工具调用」「指纹 abc12345」），并且带着第 1 轮那条命令的真实输出。
 *
 * 为什么必须分两条用户消息：会话是**每轮结束后**才写盘的 —— 同一轮进行中调 recall
 * 读不到本轮刚跑的结果（这个限制是真的，`recall` 会如实说「还没落盘」）。
 * 真实的「压缩后 / 重启接着做」都发生在后续轮次，所以这里按那个场景造。
 *
 * 标记为什么要随机：防止「上下文里本来就有」冒充「recall 取回的」。
 *
 * 请求体按行落 `FAKE_DUMP_PATH`（`{round, body}`）；不设就只打日志。
 *
 *   node tools/fake-upstream-recall.mjs      # 监听 FAKE_PORT（默认 9981）
 */

import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 第 1 轮那条命令里的随机标记（e2e 从本模块 import，比对用） */
export const MARK = process.env.FAKE_MARK || `RECALL_MARK_${Math.random().toString(36).slice(2, 10)}`

const PORT = Number(process.env.FAKE_PORT ?? 9981)

let round = 0

/** 一帧 SSE delta */
function sseChunk(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {
      /* 坏 JSON 也照样回一段，免得调用方卡住 */
    }
    /*
     * ★ 只对**主对话请求**计轮次。
     *   起标题 / 生成建议是伴随请求（`tools` 为空、`max_tokens` 很小），它们也会打到这里；
     *   算进轮次的话第 1、2、3 轮就全错位了（实测：以为第 3 轮是 recall，其实是标题）。
     *   判据用 `tools` 非空 —— 主对话一定带工具清单，辅助请求不带。
     */
    const isChat = Array.isArray(parsed?.tools) && parsed.tools.length > 0
    if (!isChat) {
      console.log(`[recall] 辅助请求（标题 / 建议）· ${body.length} 字符 · 不计轮次`)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(sseChunk({ content: '随便起个标题' }))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    round += 1
    if (process.env.FAKE_DUMP_PATH) {
      try {
        appendFileSync(process.env.FAKE_DUMP_PATH, `${JSON.stringify({ round, body })}\n`)
      } catch {
        /* 记不下来不影响上游本身 */
      }
    }
    const messageCount = Array.isArray(parsed?.messages) ? parsed.messages.length : -1
    console.log(`[recall] 第 ${round} 轮 · 请求体 ${body.length} 字符 · messages ${messageCount}`)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    if (round === 1) {
      /* 真跑一条命令：输出带随机标记 */
      res.write(
        sseChunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_shell_1',
              type: 'function',
              function: { name: 'run_shell', arguments: JSON.stringify({ command: `echo ${MARK}` }) },
            },
          ],
        }),
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (round === 2) {
      /* 第一条消息收尾 —— 这一轮结束，工具结果落盘 */
      res.write(sseChunk({ content: '跑完了，那条命令的输出是那个标记。' }))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (round === 3) {
      /*
       * 第二条消息：先列目录拿到指纹，再按指纹**取回原文** —— 两个动作一次做完。
       * 一次只发一个 tool_call（同一条 assistant 消息里发两个也行，但分开发更容易看清
       * 「第一个的返回有没有被第二个用上」）。
       */
      res.write(
        sseChunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_recall_1',
              type: 'function',
              function: { name: 'recall', arguments: JSON.stringify({ tool: 'run_shell' }) },
            },
          ],
        }),
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (round === 4) {
      /*
       * 取回原文：`n: 1` = 最近一次工具调用。
       * 这里用序号而不是指纹 —— 假上游拿不到上一轮返回的指纹（它只是无状态回包），
       * 而**序号**同样能证明「取回的是真内容」：正文里会出现那条命令的真实输出。
       */
      res.write(
        sseChunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_recall_2',
              type: 'function',
              function: { name: 'recall', arguments: JSON.stringify({ n: 1, limit: 2000 }) },
            },
          ],
        }),
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    /* 第 5 轮起收尾 */
    res.write(sseChunk({ content: '查到了，上一轮那条命令的输出我取回来了。' }))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  req.resume()
})

/*
 * ⚠️ 只有**直接运行**才监听：`e2e-recall.mjs` 要 import 常量 `MARK`，
 *   一 import 就起服务器的话，脚本会在自己 spawn 之前先占掉端口（这坑踩过）。
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[recall] 假上游就绪：http://127.0.0.1:${PORT}/v1-recall/ · 标记 ${MARK}`)
  })
}
