/**
 * 真机验收用的假上游「行为库」（`tools/live-harness.mjs` 调用它）。
 *
 * ── 两条必须的讲究（都是踩出来的）──────────────────────────────────
 * ① **按请求体认「主对话」，不能按请求次数排队**：一轮跑完应用会立刻再发
 *    「场景 title / 场景 suggest」两个请求（同一个 baseUrl、同一个端口）。
 *    按次数排队的话，工具调用那一轮会被发给 title 场景，主对话永远收不到工具
 *    → 界面没有过程入口（第一版就这么错：判据几乎全过，结束态却连入口都没有）。
 *    判据：主对话的请求体带 `tools`，场景请求不带。
 * ② **收尾帧要带 `finish_reason`**：只发 `[DONE]` 的话内核会记一条
 *    「上游流没有结束标记就断了」的警告（数据没错，但日志会骗人）。
 *
 * ── 两种行为 ─────────────────────────────────────────────────────
 *   slow  慢速发正文（撑开「运行中」这个观察窗口），一轮末尾给一次工具调用；
 *         这一轮的正文随后会被判成「过程话」收进折叠区，下一轮那句才是正文。
 *   error 立刻回 400（不可重试）→ 整轮失败，用来看「失败态有没有残留流光」。
 */

export const sse = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`

export const end = (reason = 'stop') =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`

/** 主对话的请求体带 `tools`；title / suggest 这类场景请求不带 */
export const isMainChat = (body) => /"tools"/.test(body)

/** 场景请求（title / suggest）：给一句普通正文就够，**不占**主对话的轮次 */
export function replyScene(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(sse({ content: '过程区流光' }))
  res.write(end())
  res.end()
}

/**
 * 主对话的一次响应。
 *
 * @param {object} res node 的 ServerResponse
 * @param {'slow'|'error'|'retry-ok'|'all-fail'} kind
 * @param {number} pace 每片正文之间的间隔（毫秒）—— 它决定「运行中」窗口有多长
 * @param {number} pieces 一共发几片
 * @param {number} round 这是主对话的第几轮（1 起）
 *   ★ 只有第 1 轮要工具：之后每轮都要的话，同一个调用会撞上 loop guard，
 *     界面改成提示「疑似陷入重复执行」—— 判据会被它盖住（踩过一次）。
 */
export function respond(res, kind, pace, pieces, round) {
  /* 两个「按轮次发不同工具」的场景（图2 验收表的失败 / 重试两行） */
  if (kind === 'retry-ok' || kind === 'all-fail') return respondByRound(res, kind, round)
  /*
   * 「工具跑过之后再停」：第 1 轮立刻给一次工具（过程区因此有内容、有入口），
   * 第 2 轮慢速吐正文 —— 用户在这段时间点停止，入口应当写「已中断」。
   * 只靠 slow 模式验不到这条：它停的时候还没调过工具，按设计就没有入口。
   */
  if (kind === 'stop-long') return respondStopLong(res, round, pace, pieces)

  if (kind === 'error') {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '攒不出来的错（验收用）', code: 400 } }))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  let n = 0
  const timer = setInterval(() => {
    n += 1
    res.write(sse({ content: `我先看一下现状，第 ${n} 段。` }))
    if (n < pieces) return
    clearInterval(timer)
    if (round === 1) {
      /* 第 1 轮末尾要一次工具 → 内核会带着结果再问一轮 */
      res.write(
        sse({
          tool_calls: [
            {
              index: 0,
              id: 'call_live_1',
              type: 'function',
              function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
            },
          ],
        }),
      )
      res.write(end('tool_calls'))
    } else {
      res.write(sse({ content: '看完了。流光只在跑的时候有，现在应该已经停下来了。' }))
      res.write(end())
    }
    res.end()
  }, pace)
  /* 客户端断开就别再往死连接里写 */
  res.on('close', () => clearInterval(timer))
}

/* ══════════════════════════════════════════════════════════════
   按轮次发工具（图2 验收表「失败后重试成功」「工具失败无法完成」两行）

   ★ 为什么读一个**不存在**的文件：失败是真的（内核真去读盘、真的报错），
     但零副作用 —— 不写盘、不改仓库、不执行命令，也就不需要用户点授权卡。
     用它当「一次失败」比伪造一个失败事件可信得多。
   ══════════════════════════════════════════════════════════════ */

const MISSING_A = 'tmp/__e2e_missing_a__.txt'

/* 用来「真成功」的那次调用：`list_dir` 读当前工作目录，肯定存在、零副作用 */
const OK_ARGS = { path: '.' }

const headers = (res) =>
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

const call = (id, name, args) =>
  sse({
    tool_calls: [
      { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  })

function respondByRound(res, kind, round) {
  /* all-fail 的最后一轮：让上游直接报错，任务因此「无法完成」 */
  if (kind === 'all-fail' && round >= 3) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '这一步做不下去了（验收用）', code: 400 } }))
    return
  }

  headers(res)
  if (round === 1) {
    /* 第一轮一定失败：读一个不存在的文件（真失败，且零副作用） */
    res.write(call('call_state_1', 'read_file', { path: MISSING_A }))
    res.write(end('tool_calls'))
  } else if (round === 2) {
    /*
     * retry-ok：第二次换成**一定成功**的调用（列目录）。
     * all-fail：再失败一次（换个不存在的路径，免得撞上 loop guard 的「同调用连来」）。
     */
    if (kind === 'retry-ok') res.write(call('call_state_2', 'list_dir', OK_ARGS))
    else res.write(call('call_state_2', 'read_file', { path: `${MISSING_A}.again` }))
    res.write(end('tool_calls'))
  } else {
    res.write(sse({ content: '第一次没读到，第二次读到了，结论如下：可以。' }))
    res.write(end())
  }
  res.end()
}

function respondStopLong(res, round, pace, pieces) {
  headers(res)
  if (round === 1) {
    /* 立刻给一次工具（成功的那次，零副作用）→ 过程区有了内容，入口也就有了 */
    res.write(call('call_stop_1', 'list_dir', OK_ARGS))
    res.write(end('tool_calls'))
    res.end()
    return
  }
  /* 之后慢速吐正文：留出足够长的窗口，让脚本从容地点「停止生成」 */
  let n = 0
  const timer = setInterval(() => {
    n += 1
    res.write(sse({ content: `这段会被中途停掉，第 ${n} 段。` }))
    if (n < pieces) return
    clearInterval(timer)
    res.write(end())
    res.end()
  }, pace)
  res.on('close', () => clearInterval(timer))
}
