/**
 * host 主循环（**事件驱动**）—— Phase 3a 路线 A
 *
 * ── 为什么要有这个文件（而不塞进 native-host.cjs）────────────
 *
 * 双向要求 host **同时**等两个来源：Edge 的 stdin、以及主进程的管道回复。
 * 单线程同步循环做不到（那正是 `run()` 的老路子，它只能等 stdin）。
 * 所以路线 A 改成事件驱动 —— 但 `native-host.cjs` 已经贴着 300 行红线，
 * 塞不下第二个主循环，于是把「新驱动 + 分派」整块放这里。
 *
 * ⚠️ **`run()`（同步阻塞）仍然保留在 native-host.cjs**：它是 main.cjs 那条
 *    兼容分支（Edge 直接拉 Harbor.exe）的承重墙，`run()` 一旦返回，main.cjs
 *    后面的建窗口代码就会跑起来（Phase 1a 真机踩过）。两条驱动并存是裁决 A3
 *    的代价，新功能**一律进这里**。
 *
 * ── 保活与收尾 ───────────────────────────────────────────────
 *
 *   · `stdin` 处于读取态即保活事件循环（探针实测：空闲 30s 存活、CPU 0%）。
 *   · `stdin` 的 `end` / `error`（浏览器关了端口）→ `process.exit(0)`。
 *     ★ 这里可以安全用 exit：本文件**不在** main.cjs 那条分支上，
 *       没有「返回后继续建窗口」的隐患（那是 run() 才有的约束）。
 *   · 帧失步（长度离谱）→ exit(0)，同 run() 的口径。
 *
 * ── 处理是**串行**的 ─────────────────────────────────────────
 *
 * 一个 Promise 链把消息一条条处理完再写下一条 —— 这样回帧顺序与输入顺序一致，
 * 也不会出现两条消息并发写 stdout（帧本身不会被撕开，但顺序错乱会让扩展侧
 * 的「按 id 匹配」白白多一层调试成本）。代价：一条卡住的请求会拖住后面的，
 * 但有 8s 超时兜底。
 *
 * ⚠️ 本模块**不 require electron**（host 进程要 require 它）。
 */

const fs = require('node:fs')
const P = require('./ext-protocol.cjs')
const { createClient } = require('./ext-client.cjs')

/**
 * 一条来自 Edge 的消息该回什么。
 *
 * ⚠️ 返回值形状是**扩展侧的契约**：`ext:page.result` 沿用 Phase 2 的字段
 *   （扩展读 `ok` / `chars` / `error`），`ext:sessionList.result` 是 3a 新增。
 *
 * @param {{ request: (kind: string, payload?: object) => Promise<object> }} client
 */
function createDispatcher(client) {
  return async function dispatch(message) {
    if (message && typeof message === 'object' && 'ping' in message) {
      return { pong: 1, echo: message }
    }

    const obj = message && typeof message === 'object' ? message : {}
    const type = String(obj.type ?? '')
    const id = 'id' in obj ? (obj.id ?? null) : null

    if (type === 'ext:page') {
      const text = String(obj.text ?? '')
      const res = await client.request(P.KIND.EXT_PAGE, {
        url: String(obj.url ?? ''),
        title: String(obj.title ?? ''),
        text,
        truncated: obj.truncated === true,
      })
      if (res.ok) {
        return {
          type: 'ext:page.result',
          ok: true,
          delivered: true,
          chars: text.length,
          id,
          sessionId: String(res.payload?.sessionId ?? ''),
        }
      }
      return {
        type: 'ext:page.result',
        ok: false,
        delivered: false,
        chars: text.length,
        id,
        error: res.error.message,
        code: res.error.code,
      }
    }

    if (type === 'ext:sessionList') {
      const res = await client.request(P.KIND.SESSION_LIST, {})
      if (res.ok) {
        return { type: 'ext:sessionList.result', ok: true, id, sessions: res.payload?.sessions ?? [] }
      }
      return { type: 'ext:sessionList.result', ok: false, id, error: res.error.message, code: res.error.code }
    }

    if (type === 'ext:sessionActive') {
      const res = await client.request(P.KIND.SESSION_ACTIVE, {})
      if (res.ok) {
        return { type: 'ext:sessionActive.result', ok: true, id, sessionId: String(res.payload?.sessionId ?? '') }
      }
      return { type: 'ext:sessionActive.result', ok: false, id, error: res.error.message, code: res.error.code }
    }

    /*
     * Phase 3b：侧边栏发消息 / 重连要流快照 —— 都是「转给主进程拿结果」，
     * 与上面两条同一种形状（host 只做转发，业务判断全在主进程）。
     * Phase 3c 又加两条：选一条会话（session:select）/ 新建一条（session:new）。
     * M03 再加一条：结构化页面观察（observe-page）。
     */
    if (
      type === 'chat:send' ||
      type === 'chat:resume' ||
      type === 'session:select' ||
      type === 'session:new' ||
      type === 'observe-page'
    ) {
      /** @type {Record<string, [string, object]>} */
      const map = {
        'chat:send': [P.KIND.CHAT_SEND, { text: String(obj.text ?? '') }],
        /* 续流按 **sessionId** 问（真实那轮的 requestId 是渲染层生成的，扩展侧没听过） */
        'chat:resume': [P.KIND.CHAT_RESUME, { sessionId: String(obj.sessionId ?? '') }],
        'session:select': [P.KIND.SESSION_SELECT, { sessionId: String(obj.sessionId ?? '') }],
        'session:new': [P.KIND.SESSION_NEW, {}],
        /* ★ 观察结果是**结构化对象**，原样转（不 String()）—— 形状的真相源是 observe.js */
        'observe-page': [P.KIND.PAGE_OBSERVE, { observation: obj.observation ?? null }],
      }
      const [kind, ask] = map[type]
      const res = await client.request(kind, ask)
      if (res.ok) return { ...res.payload, type: `${type}.result`, ok: true, id }
      return { type: `${type}.result`, ok: false, id, error: res.error.message, code: res.error.code }
    }

    /*
     * M04-1：元素列表视图（`page:elements`）—— 与 observe-page 同一形状，
     * 多带一个 `ref`（主进程按它解析失效）。host 仍只做转发。
     */
    if (type === 'get-elements') {
      const ask = { observation: obj.observation ?? null }
      if (obj.ref) ask.ref = String(obj.ref)
      const res = await client.request(P.KIND.PAGE_ELEMENTS, ask)
      if (res.ok) return { ...res.payload, type: 'get-elements.result', ok: true, id }
      return { type: 'get-elements.result', ok: false, id, error: res.error.message, code: res.error.code }
    }

    return {
      error:
        '只认 {"ping":…} / ext:page / ext:sessionList / ext:sessionActive / chat:send / chat:resume / session:select / session:new / observe-page / get-elements',
      echo: message ?? null,
    }
  }
}

/**
 * 进事件驱动的 host 循环（**路径 2 的主驱动**）。
 *
 * @param {{ note: (t: string) => void, redirectOutput: () => void }} deps
 *   `note` / `redirectOutput` 由 native-host.cjs 传入 —— 那边才有那条「stdout 是
 *   协议通道」的保命线，不在这里再抄一份。
 */
function runInteractive(deps) {
  const note = deps.note
  const client = createClient({ log: { warn: note } })
  const dispatch = createDispatcher(client)

  deps.redirectOutput()
  note(`已就绪（pid=${process.pid}，事件驱动）`)

  /* 主进程的主动推送（3b 用）→ 原样转给扩展 */
  client.setPushHandler((msg) => {
    try {
      fs.writeSync(1, P.encodeFrame(msg))
    } catch (error) {
      note(`推送转发失败：${error instanceof Error ? error.message : error}`)
    }
  })

  /** 串行处理链（见文件头「处理是串行的」） */
  let chain = Promise.resolve()
  function enqueue(message) {
    chain = chain
      .then(() => dispatch(message))
      .then((reply) => {
        try {
          fs.writeSync(1, P.encodeFrame(reply))
        } catch (error) {
          note(`回帧失败：${error instanceof Error ? error.message : error}`)
        }
      })
      .catch((error) => note(`处理消息失败：${error instanceof Error ? error.message : error}`))
  }

  /** @type {Buffer} */ /* 显式标注：`alloc` 与 `concat` 的泛型参数不同（见 native-host.cjs 同一处） */
  let buf = Buffer.alloc(0)
  process.stdin.on('data', (chunk) => {
    /* stdin 的 chunk 类型是 `string | Buffer`（未设 encoding 时实际总是 Buffer）——
       显式归一，既让类型检查过，也防将来有人给 stdin 设了 encoding */
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    buf = Buffer.concat([buf, bytes])
    const { messages, rest, errors, fatal } = P.decodeFrames(buf, { max: P.MAX_FRAME })
    buf = rest
    for (const e of errors) note(`丢弃一帧：${e}`)
    /* 帧头已经不可能对齐 —— 断掉比继续读安全（Edge 会走 onDisconnect） */
    if (fatal) {
      note('协议失去同步，退出')
      process.exit(0)
    }
    for (const m of messages) enqueue(m)
  })

  /* 浏览器关了端口（EOF）/ 读失败 → 干净退出 */
  process.stdin.on('end', () => {
    client.close()
    note('stdin EOF → exit(0)')
    process.exit(0)
  })
  process.stdin.on('error', () => process.exit(0))
  process.stdin.resume()
}

module.exports = { createDispatcher, runInteractive }
