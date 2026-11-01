/**
 * 假上游（专供「重新生成」验收用）：**记录每一次请求体**，然后按 SSE 回一段话。
 *
 * 为什么不用 tools/fake-upstream.mjs：那个是既有资产，模式多但没有「把请求体落盘」
 * 的能力。这里只需要一个能力：**让我能数清收到几次请求、每次带了几条消息**。
 * 放 tmp/ 下不污染 tools/。
 *
 * 环境变量：
 *   FAKE_PORT   监听端口
 *   FAKE_LOG    请求记录写入的文件（每行一个 JSON）
 */
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.FAKE_PORT ?? 9981)
const LOG = process.env.FAKE_LOG ?? ''

if (LOG) writeFileSync(LOG, '')

let seq = 0

const sse = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    seq += 1

    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = null
    }
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
    /* 最后一条 user 说了什么（用来区分「首轮」与「重新生成」） */
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user')
    const record = {
      seq,
      at: Date.now(),
      model: String(parsed?.model ?? ''),
      messageCount: messages.length,
      roles: messages.map((m) => String(m?.role ?? '')),
      lastUserText: String(lastUser?.content ?? '').slice(0, 80),
      maxTokens: parsed?.max_tokens ?? null,
    }
    if (LOG) appendFileSync(LOG, JSON.stringify(record) + '\n')
    console.log(`[fake-regen] #${seq} model=${record.model} msgs=${record.messageCount} last=${JSON.stringify(record.lastUserText)}`)

    /* 回包：带上调用序号，方便判断「第二次回答」是不是新的 */
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(sse({ role: 'assistant', content: '' }))
    res.write(sse({ content: `第${seq}次回答` }))
    res.write(sse({ content: '：这是假上游给的回包。' }))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  req.resume()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-regen] listening on ${PORT}  log=${LOG}`)
})
