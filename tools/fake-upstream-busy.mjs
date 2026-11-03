/**
 * 假上游的 `busy` 模式：**任务真的在干活**的那一幕。
 *
 * 为什么单独一个模式（2026-11-04，用户纠正测试方法）：
 * 用户原话「应该是发出问题，然后任务正在进行，然后再注入」。
 * 老的 `slow` 模式只发文本 token，**一次工具调用都没有** —— 那不是「任务在进行」，
 * 只是「字在往外冒」，所以注入时机怎么调都复现不了他遇到的场景（读页 / 执行命令时被打断）。
 *
 * 这一模式每轮发**一条真工具调用**（`run_shell` 跑 `dir /b <子目录>`），
 * 由内核真执行：真起 cmd、真拿输出、真把结果喂回模型。于是界面上真的有
 * `data-run-status="running"` → `completed` 的推进，`sendingThreads` 里也真的有这一轮。
 *
 * 三条要注意的：
 *   ① 命令走 `dir`（`risk-patterns.cjs` 的 LOW 名单）—— low = 静默放行，不会弹确认卡把脚本卡死。
 *   ② 每轮命令末尾多一个空格：`loop-guard` 会把「同一个调用连续 3 次」判成转圈并打断，
 *      那是它的正事，不该为了验收去放宽（见 `busyCommand`）。
 *   ③ 轮与轮之间留 `PACE_MS`：给验收脚本留出「此时注入」的时间窗。
 *      不放开节奏的话 14 轮会在几百毫秒内跑完，脚本还没反应过来任务就结束了。
 */

/** 轮次计数（一次验收一个进程） */
let rounds = 0

/** 一共跑几轮（到顶就收尾）。默认 14 轮 × 1.2 秒 ≈ 17 秒的「任务进行中」窗口 */
const MAX_ROUNDS = Number(process.env.FAKE_BUSY_ROUNDS ?? 14)

/** 每轮之间的节奏（毫秒）—— 注入要落在这段时间里 */
const PACE_MS = Number(process.env.FAKE_BUSY_PACE_MS ?? 1200)

/** 本地小睡（只为给验收脚本留出注入的时间窗） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 第 n 轮的 shell 命令。
 *
 * 只用 `dir`（只读、low、不弹确认卡）。
 *
 * 为什么是「末尾多几个空格」而不是换子目录：`dir /b src` 在**会话工作目录**下跑，
 * 而工作目录继承自上一次对话（可能是别的仓库），子目录不一定存在 —— 一失败就多一份
 * 噪音，还分不清「任务在跑」和「命令本来就错」。空格则保证命令永远成功。
 *
 * 空格也不只是为了整齐：`loop-guard` 把「同一个调用连续 3 次」判成转圈并打断
 * （那是它的正事，不该为验收去放宽），而它按**原文**比对 —— 每轮多一个空格就绕开了。
 *
 * @param {number} round 1 起
 */
function busyCommand(round) {
  return `dir /b${' '.repeat(round)}`
}

/**
 * 收尾那一帧：只带 `finish_reason`，不带 delta。
 *
 * 为什么单独写这一帧：`sseChunk` 的形状是 `{ choices: [{ delta }] }`（只装增量），
 * `finish_reason` 是**另一个字段**，塞进 delta 就是错的（客户端读不到）。
 * 不补这一帧的后果在真机上看得见：内核会报
 * 「上游流没有结束标记就断了 … 没收到 finish_reason」——虽然它仍会按收到的
 * 工具调用继续，但日志里那行 WARN 会让人以为上游坏了。
 */
function sseFinish(reason) {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`
}

/**
 * 应答一轮。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {(delta: object) => string} sseChunk SSE 分片格式 —— 唯一一份留在 `fake-upstream.mjs`
 *   （不在这里再写一遍，否则两处形状漂了就没人发现）
 */
async function streamBusyRound(res, sseChunk) {
  rounds += 1
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  if (rounds <= MAX_ROUNDS) {
    /* 先静一下，让脚本能在「上一轮工具已经落地」之后注入 */
    await sleep(PACE_MS)
    res.write(sseChunk({ content: `第 ${rounds} 轮：核对一下仓库目录。` }))
    const call = {
      index: 0,
      id: `call_busy_${rounds}`,
      type: 'function',
      function: { name: 'run_shell', arguments: JSON.stringify({ command: busyCommand(rounds) }) },
    }
    res.write(sseChunk({ tool_calls: [call] }))
    res.write(sseFinish('tool_calls'))
  } else {
    res.write(sseChunk({ content: `核对完了，共 ${MAX_ROUNDS} 轮，任务结束。` }))
    res.write(sseFinish('stop'))
  }
  res.write('data: [DONE]' + String.fromCharCode(10, 10))
  res.end()
}

export { busyCommand, streamBusyRound, MAX_ROUNDS as BUSY_ROUNDS }
