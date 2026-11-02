/**
 * 假上游的 `fail` 模式：CE-011「连续失败」真机验证
 *
 * 从 `tools/fake-upstream.mjs` 拆出来的（那边贴 300 行红线）。
 *
 * **连续失败**，但每次调用签名都不同：为什么不用现成的 `loop` 模式 —— 那个是
 * 「同一个调用转圈」，会先被 loop-guard 抓走；这里要单独验证 failure-streak
 * （判据是「不同的尝试在失败」），所以每轮换文件名。
 *
 * 每轮先把请求体里那句话数一遍打印出来 —— 这就是「界面链路真的注入了它」的硬证据：
 * 这条链（界面 → chat handler → loop → HTTP）全是真的，只有模型是假的。
 */

/** 轮次计数（一次对话会依次调用，所以按进程累计） */
let rounds = 0

/** 收到的请求体里那句话出现了几次 */
function streakInBody(body) {
  const hits = String(body).match(/已经连续失败/g)
  return hits ? hits.length : 0
}

/**
 * 应答一轮 fail 模式。
 *
 * @param {import('node:http').IncomingMessage} req 已经挂上 data 收集器（路由那边统一收）
 * @param {import('node:http').ServerResponse} res
 * @param {Buffer[]} bodyChunks 请求体分片
 * @param {(delta: object) => string} sseChunk SSE 分片格式 —— 唯一一份留在 `fake-upstream.mjs`
 */
function handleFailMode(req, res, bodyChunks, sseChunk) {
  rounds += 1
  const round = rounds
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks).toString('utf8')
    const hits = streakInBody(body)
    console.log(`[fake-upstream] fail 第 ${round} 轮 | 请求体含「已经连续失败」=${hits > 0}（${hits} 处）`)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    /*
     * 那句话已经在请求里了 = 提示生效了。这一轮**收尾**（回一段文字、不再要工具），
     * 让任务能干净结束 —— 否则假上游永远要工具，循环会一直转到预算耗尽。
     */
    if (hits > 0) {
      res.write(sseChunk({ content: '好，换个办法：先用 list_dir 看看这个目录里到底有什么。' }))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const call = {
      index: 0,
      id: `call_fail_${round}`,
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: `no-such-file-${round}.txt` }) },
    }
    res.write(sseChunk({ tool_calls: [call] }))
    res.write('data: [DONE]\n\n')
    res.end()
  })
}

export { handleFailMode, streakInBody }
