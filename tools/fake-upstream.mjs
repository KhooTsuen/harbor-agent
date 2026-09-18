/**
 * 假上游：专门用来喂各种坏响应
 *
 * 破坏性测试用。比「拔网线」可控 —— 每种坏法都能精确指定，还能反复复现。
 *
 *   node tools/fake-upstream.mjs          # 监听 127.0.0.1:9977
 *
 * 坏法写在 **baseUrl 的路径前缀**里（不能用 query —— 客户端会把
 * `/chat/completions` 直接拼在 baseUrl 后面，query 会被拼坏）：
 *
 *   http://127.0.0.1:9977/v1-html      → 返回 HTML 错误页
 *   http://127.0.0.1:9977/v1-truncate  → 半截 SSE 后断连
 *   http://127.0.0.1:9977/v1-slow      → 每 5 秒一个 token
 *   http://127.0.0.1:9977/v1-empty     → 200 但空 body
 *   http://127.0.0.1:9977/v1-garbage   → 200 但二进制垃圾
 *   http://127.0.0.1:9977/v1-replan    → 同一个任务里先后给两版计划（AG-004 用）
 *   http://127.0.0.1:9977/v1           → 正常（对照组）
 *
 * 坏法：
 *   html      返回一个 HTML 错误页（不是 JSON）—— 中转站挂掉时的典型样子
 *   truncate  发半截 SSE 然后**直接断连接**（最怕客户端卡在「生成中」）
 *   slow      每 5 秒吐一个 token（测「停止」按钮能不能立刻停住）
 *   empty     200 但空 body
 *   garbage   200 但返回一段随机二进制
 *   replan    第 1 轮给计划 A，第 2 轮给计划 B（多一条），第 3 轮起不给
 *   ok        正常返回（对照组）
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.FAKE_PORT ?? 9977)

/* replan 模式的轮次计数（一次对话会依次调用，所以按进程累计） */
let planRounds = 0

function sseChunk(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  /* 路径第一段就是坏法：/v1-truncate/chat/completions → truncate */
  const seg = url.pathname.split('/').filter(Boolean)[0] ?? 'v1'
  const mode = seg.replace(/^v1-?/, '') || 'ok'
  /* 把请求体读掉，否则有些客户端会卡住 */
  req.resume()

  console.log(`[fake-upstream] ${req.method} ${url.pathname} → mode=${mode}`)

  if (mode === 'html') {
    res.writeHead(502, { 'Content-Type': 'text/html' })
    res.end('<html><body><h1>502 Bad Gateway</h1><p>upstream is down</p></body></html>')
    return
  }

  if (mode === 'empty') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('')
    return
  }

  if (mode === 'garbage') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7b, 0x7b, 0x7b]))
    return
  }

  if (mode === 'truncate') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(sseChunk({ content: '我正在回答一半' }))
    /* 故意发半截 JSON，然后撕掉连接 —— 客户端应该报错收尾，不该永远转圈 */
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"这里被截')
      setTimeout(() => res.destroy(), 200)
    }, 800)
    return
  }

  if (mode === 'slow') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    let n = 0
    const timer = setInterval(() => {
      n += 1
      res.write(sseChunk({ content: `慢${n} ` }))
      if (n >= 12) {
        res.write('data: [DONE]\n\n')
        clearInterval(timer)
        res.end()
      }
    }, 5000)
    req.on('close', () => clearInterval(timer))
    return
  }

  if (mode === 'replan') {
    /*
     * AG-004 真机验证。前两轮各给一版计划（第二版多一条）。
     *
     * 为什么不用工具调用来拖长循环：假上游只会发 content 增量，搬 tool_calls
     * 字段得不偿失。计划条目不勾选（`[ ]`）就够了 —— 内核的完成门禁会把这一轮
     * 顶回去继续，于是同一个任务里自然出现两次计划。第三轮起不给计划块，
     * 让对话能收尾（门禁有刹车：顶够次数就放行）。
     */
    planRounds += 1
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    if (planRounds === 1) {
      res.write(sseChunk({ content: '先规划一下：\n\n```plan\n- [ ] 读配置\n- [ ] 改代码\n```\n' }))
    } else if (planRounds === 2) {
      res.write(
        sseChunk({
          content:
            '还得跑测试，计划改一下：\n\n```plan\n- [ ] 读配置\n- [ ] 改代码\n- [ ] 跑测试\n```\n',
        }),
      )
    } else {
      res.write(sseChunk({ content: '这轮没别的了。' }))
    }
    /* 故意慢 2.5 秒才收尾：真机验证得在「任务还在跑」的时候查界面，
       任务一结束横幅就没了 —— 采样总是慢一步 */
    setTimeout(() => {
      res.write('data: [DONE]\n\n')
      res.end()
    }, 2500)
    return
  }

  /* ok：正常的 SSE，立刻结束 */
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(sseChunk({ content: '假上游回答：' }))
  res.write(sseChunk({ content: '好' }))
  res.write('data: [DONE]\n\n')
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `假上游就绪：http://127.0.0.1:${PORT}/v1-<模式>/
  模式：html | truncate | slow | empty | garbage | replan | （无后缀=正常）`,
  )
})
