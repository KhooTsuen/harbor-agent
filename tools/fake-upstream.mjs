/**
 * 假上游：喂各种坏响应（破坏性测试用）。比「拔网线」可控 —— 每种坏法能精确指定、可复现。
 *   node tools/fake-upstream.mjs          # 监听 127.0.0.1:9977
 * 坏法写在 **baseUrl 的路径前缀**里（不能用 query —— 客户端会把 `/chat/completions`
 * 直接拼在 baseUrl 后面，query 会被拼坏）：
 *   html     返回 HTML 错误页（不是 JSON）—— 中转站挂掉时的典型样子
 *   truncate 发半截 SSE 后断连（最怕客户端卡在「生成中」）
 *   slow     每 5 秒一个 token（测「停止」按钮能不能立刻停住）
 *   empty    200 但空 body          · garbage  200 但一段二进制垃圾
 *   replan   同一任务里先后给两版计划（AG-004）
 *   loop     永远 A B A B 地调两个工具（AG-041）
 *   confirm  第 1 轮调一次 run_shell（medium → 弹**确认卡**）—— 冒烟用
 *   ask      第 1 轮调一次 ask_user（→ 弹**澄清卡**）—— 自动化测试「脚本会自己点卡」用
 *   fail     连着读**不同的**不存在文件 → 连续失败（CE-011）
 *   retry    第一次发半截正文后报 429（可重试）、第二次正常 —— 验证「重试不显示两遍」
 *   shellfail 工具真失败冒烟
 *   experience 每轮都发同一条 `run_shell` 命令（自我纠错闭环真机验收用）
 *   busy     每轮发一条 `run_shell`（`dir /b`）：造「任务真的在干活」的画面
 *            —— 验「注入不打断在跑的任务」必须在这个状态下注入（见 fake-upstream-busy.mjs）
 *   （无后缀）正常返回（对照组）
 */

import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { handleRetryMode } from './fake-retry-mode.mjs' /* retry 模式整套住在那边 */
import { streamExperienceRound } from './fake-upstream-experience.mjs' /* experience 模式整套住在那边 */
import { streamBusyRound } from './fake-upstream-busy.mjs' /* busy 模式：「任务真在干活」那一幕 */
import { handleFailMode } from './fake-upstream-fail.mjs' /* fail 模式整套住在那边 */

const PORT = Number(process.env.FAKE_PORT ?? 9977)

/** `slow` 出片间隔（默认 5 秒）。可调是为了验收脚本能跑快些（3b 要在「还在跑」时再发一条）。 */
const SLOW_MS = Number(process.env.FAKE_SLOW_MS ?? 5000)

/* replan 模式的轮次计数（一次对话会依次调用，所以按进程累计） */
let planRounds = 0
/* loop 模式的轮次计数（AG-041）：偶数轮 A、奇数轮 B */
let loopRounds = 0
/* 「第 1 轮发一次工具调用、之后收尾」的模式计数：confirm（确认卡）/ ask（澄清卡）/ shellfail（工具真失败）/ sensitive（敏感文件授权） */
const onceRounds = { confirm: 0, ask: 0, shellfail: 0, sensitive: 0 }

function sseChunk(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
}

/** 假上游主路由 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  /* 路径第一段就是坏法：/v1-truncate/chat/completions → truncate */
  const seg = url.pathname.split('/').filter(Boolean)[0] ?? 'v1'
  const mode = seg.replace(/^v1-?/, '') || 'ok'
  /* 把请求体读掉，否则有些客户端会卡住（fail 模式还要拿它当证据） */
  const bodyChunks = []
  req.on('data', (chunk) => bodyChunks.push(chunk))
  req.resume()

  console.log(`[fake-upstream] ${req.method} ${url.pathname} → mode=${mode}`)
  /*
   * C-1 真机验收要读「第 2 个请求里到底有没有那个密钥」——
   * 假上游自己记一份请求体（只在设了 FAKE_DUMP_PATH 时写，默认不写盘）。
   */
  if (process.env.FAKE_DUMP_PATH) {
    req.on('end', () => {
      try {
        writeFileSync(
          process.env.FAKE_DUMP_PATH,
          Buffer.concat(bodyChunks).toString('utf8'),
          { flag: 'a' },
        )
      } catch {
        /* 记不下来不影响上游本身 */
      }
    })
  }

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

  if (mode === 'retry') {
    handleRetryMode(res, sseChunk) /* 「为什么报 429 而不是撕连接」见 fake-retry-mode.mjs 文件头 */
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
    }, SLOW_MS)
    /*
     * ⚠️ 绑 **`res`** 的 close，不能绑 `req` 的：HTTP keep-alive 下 `req` 的 close
     * 在「请求体读完」就触发（不是连接断了）→ 定时器当场被清、**一片都发不出去**
     * （3b 真机排查逮到：假上游明明收到 POST，客户端却没内容）。
     */
    res.on('close', () => clearInterval(timer))
    return
  }

  if (mode === 'fail') {
    handleFailMode(req, res, bodyChunks, sseChunk)
    return
  }

  if (mode === 'loop') {
    /*
     * AG-041 真机验证：永远转圈。
     *
     * 每轮给一个**成功**的工具调用，两个调用交替、参数一模一样 ——
     * 正是文档画的 A B A B。检测器应当在几轮之后改道、再几轮之后停下来问用户。
     * 全程用 content 发不出 tool_calls，所以这里直接写 tool_calls 的 SSE 增量。
     */
    loopRounds += 1
    const odd = loopRounds % 2 === 1
    const call = {
      index: 0,
      id: `call_${loopRounds}`,
      type: 'function',
      function: odd
        ? { name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) }
        : { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(sseChunk({ tool_calls: [call] }))
    res.write('data: [DONE]' + String.fromCharCode(10, 10))
    res.end()
    return
  }

  /*
   * 「第 1 轮发一次工具调用、之后收尾」的三种模式（第 2 轮起发文本收尾，别无限调工具）：
   *   · confirm  → `run_shell` 写文件（medium → 弹**确认卡**）· 冒烟用（事故 ③）
   *   · ask      → `ask_user`（→ 弹**澄清卡**）· 自动化测试「脚本自己点卡」用
   *   · shellfail→ `run_shell` 跑 `exit /b 7`（退出码 7）· 「工具真失败」冒烟的入口
   */
  if (mode === 'confirm' || mode === 'ask' || mode === 'shellfail' || mode === 'sensitive') {
    onceRounds[mode] += 1
    const askCall = {
      name: 'ask_user',
      arguments: JSON.stringify({
        questions: [
          {
            question: '这个改动按哪种范围来做？',
            options: [
              { label: '只改这一处', effect: '动 1 个文件，多花 2 分钟' },
              { label: '连相关的地方一起改', effect: '要动 5 个文件' },
            ],
            defaultValue: '只改这一处',
          },
        ],
      }),
    }
    /* shellfail = 「工具真失败」冒烟：`exit /b 7`。正文只会多一行 `[退出码 7]`、没有
       `错误：` 前缀 —— 改动前界面是绿勾，改动后必须显示失败（见 tool-failure.cjs 文件头） */
    const once =
      mode === 'confirm'
        ? { name: 'run_shell', arguments: JSON.stringify({ command: 'echo smoke-ok > smoke-shell-ok.txt' }) }
        : mode === 'shellfail'
          ? { name: 'run_shell', arguments: JSON.stringify({ command: 'exit /b 7' }) }
          : mode === 'sensitive'
            ? { name: 'read_file', arguments: JSON.stringify({ path: process.env.FAKE_SENSITIVE_PATH ?? '' }) }
            : askCall
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    if (onceRounds[mode] === 1) {
      const call = { index: 0, id: `call_${mode}_1`, type: 'function', function: once }
      res.write(sseChunk({ tool_calls: [call] }))
    } else {
      const done = {
        confirm: '确认卡冒烟：这一步已经处理完了。',
        shellfail: '接住了这次失败，换一条命令再试。',
        sensitive: '敏感文件那一步已经处理完了。',
      }
      res.write(sseChunk({ content: done[mode] ?? '澄清卡冒烟：这一步已经处理完了。' }))
    }
    res.write('data: [DONE]' + String.fromCharCode(10, 10))
    res.end()
    return
  }

  if (mode === 'experience') {
    await streamExperienceRound(res, sseChunk)
    return
  }

  /* busy：「任务真的在干活」那一幕 —— 每轮一条真工具调用，实现见那边文件头 */
  if (mode === 'busy') {
    await streamBusyRound(res, sseChunk)
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
  模式：html | truncate | slow | empty | garbage | replan | loop | confirm | ask | fail | （无后缀=正常）`,
  )
})
