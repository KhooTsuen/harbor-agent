/**
 * 本会话历史工具证据 —— **只读回取**（P1-C，2026-11-07）
 *
 * ── 治什么病 ──────────────────────────────────────────────────
 *
 * P0/P1 查实：原始会话完整躺在 `data/sessions/<id>.jsonl`（实测工具输出 5 万字符
 * 逐字保留），但**模型没有任何一条路能自己走到它面前** ——
 *   ① 提示不说路径（六个提示模块搜 `sessions` / `.jsonl` 零命中）
 *   ② 没有读会话的工具（内置工具一个都不沾）
 *   ③ 知道了也读不了（`capability.check` 判「在工作目录之外」）
 * 于是压缩之后模型只剩折叠块里那行「第 3 次 · 工具 [read_file] · 成功 · 输出 1200 字 ·
 * 指纹 a1b2c3d4」，想不起当时到底读出什么，只能**重跑一遍**。
 *
 * ── 边界（授权里点名的几条，别松）──────────────────────────────
 *
 * ① **只认 `ctx.sessionId`**：每个入口只接一个 `sessionId`，路径由
 *    `sessionIo.fileFor()` 算 —— 模型在 schema 里只能给「第几次 / 指纹 / 关键词」，
 *    **给不出路径，也给不出别人的会话 id**。这是它和 `read_file` 的根本区别：
 *    read_file 的风险是「模型指定任意路径」，这里连那个参数都不存在。
 * ② **不调 `capability.check`**：会话文件是 Harbor 自己写的应用数据，不在用户工作区；
 *    要让它过 `capability` 就得给 `data/sessions` 开一条通用白名单
 *    （`capability.cjs` 是硬禁区），那等于让**所有**路径型工具都多一条可走的路。
 *    **专用窄口 > 通用宽口。**
 *    ⚠️ 若以后有人给这个模块加 `path` / `sessionId` 参数，就必须回到 capability 体系。
 * ③ **只读**：只用 `fs.createReadStream` + `readline`，一次写入都没有。
 * ④ **指纹与折叠块同一份**：`fp` 由 `session-replay.replayToolRuns` 的回放视图算 ——
 *    与 `history-fold.toolItemOf` 的输入逐字相同。自己再拼一遍格式 = 硬约束 9 那类事故
 *    （折叠块写着 fp、这里算不出同一个数，模型永远对不上）。
 */

const fs = require('node:fs')
const readline = require('node:readline')
const { redact } = require('./redact.cjs')
const sessionIo = require('./session-io.cjs')
const { openLineDetailed } = require('./session-crypto.cjs')
const { replayToolRuns } = require('./session-replay.cjs')
const { fingerprint } = require('./history-fold.cjs')

/** 最多往回找多少次工具调用（再早的已在压缩摘要里，且单次取回没有意义） */
const MAX_KEEP = 60
/** 目录一次最多列几条 */
const MAX_CATALOG = 20
/** 取回正文默认 / 上限（字符） */
const DEF_BODY = 4000
const MAX_BODY = 12000
/** 单次扫描的时间上限（毫秒）—— 141MB 的会话不能拖住整轮对话 */
const SCAN_MS = 8000

/**
 * 一次工具调用在**回放视图**里的正文。
 *
 * ★ 必须走 `replayToolRuns`：折叠块里的 `fp` 是对这条消息的 content 算的
 *   （`history-fold.toolItemOf` 的 `raw`）。内容只依赖 run 自己，所以单独回放
 *   一条与批量回放的第 k+1 条逐字相同。
 */
function viewContentOf(run) {
  const pair = replayToolRuns({ content: '' }, [run], 'recall')
  return String(pair[1]?.content ?? '')
}

/** 打开一行会话记录（兼容加密会话：解不开就返回 null，不抛） */
function parseLine(raw) {
  const opened = openLineDetailed(String(raw ?? '').trim())
  if (!opened.ok) return null
  try {
    return JSON.parse(opened.text)
  } catch {
    return null
  }
}

/**
 * 流式扫一份会话，收集工具调用**元数据**（不存正文 —— 内存 O(1)）。
 *
 * @param {string} sessionId 只能是 `ctx.sessionId`
 * @param {{ query?: string, tool?: string, lineNo?: number }} [options]
 *        `query` 关键词（在输出正文里找）；`tool` 工具名精确过滤；
 *        `lineNo` 给了就只解析那一行（取回路径用，扫到即停）
 * @returns {Promise<{ calls: Array<object>, total: number, lines: number,
 *                     broken: number, truncated: boolean, row: object|null }>}
 */
async function collect(sessionId, options = {}) {
  const file = sessionIo.fileFor(sessionId) /* id 不合法 → 抛，交给调用方转成错误文本 */
  const query = String(options.query ?? '')
  const toolFilter = String(options.tool ?? '')
  const onlyLine = Number(options.lineNo) > 0 ? Number(options.lineNo) : 0
  const started = Date.now()

  const calls = []
  let total = 0
  let lines = 0
  let broken = 0
  let truncated = false
  let row = null

  let stream
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' })
  } catch {
    return { calls, total, lines, broken, truncated, row }
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  /*
   * ★ 文件不存在 / 读不出来时 `for await` 会**抛**（`createReadStream` 的错误是异步的，
   *   外层的 try/catch 抓不到）。这里明确接住，当成「没有记录」——
   *   与 `session-io.readLines` 的口径一致（ENOENT = 正常，还没建过 / 刚删）。
   *   实测：不接的话 `sess_notexist…` 直接把整轮对话打断。
   */
  try {
    for await (const raw of rl) {
      lines += 1
      if (onlyLine && lines === onlyLine) {
        row = parseLine(raw)
        break
      }
      if (Date.now() - started > SCAN_MS) {
        truncated = true
        break
      }
      const parsed = parseLine(raw)
      if (!parsed) {
        broken += 1
        continue
      }
      if (parsed.type !== 'message' || parsed.role !== 'assistant') continue
      const runs = Array.isArray(parsed.toolRuns) ? parsed.toolRuns : []
      for (let i = 0; i < runs.length; i += 1) {
        const run = runs[i]
        const name = String(run?.name ?? '')
        if (toolFilter && name !== toolFilter) continue
        const output = String(run?.output ?? '')
        if (query && !output.includes(query)) continue
        total += 1
        calls.push({
          line: lines,
          runIndex: i,
          name,
          ok: run?.ok === true,
          chars: output.length,
          fp: fingerprint(viewContentOf(run)),
          at: Number(parsed.at ?? parsed.ts ?? 0),
          /* `n` 等扫完再填（要说「最近一次」得知道总共有几条），先占位让形状固定 */
          n: 0,
        })
        if (calls.length > MAX_KEEP) calls.shift()
      }
    }
  } catch {
    /* 读不到（ENOENT / 权限 / 加密行异常）：返回已收集到的，不抛 */
  } finally {
    rl.close()
    stream.destroy()
  }

  /* `n` = 从最近往前数（1 = 最近一次）—— 与折叠块「第 N 次」的直觉一致，也好记 */
  for (let i = 0; i < calls.length; i += 1) calls[i].n = calls.length - i
  return { calls, total, lines, broken, truncated, row }
}

/** 一条元数据 → 目录里那一行 */
function lineOf(call, index) {
  const when = call.at ? new Date(call.at).toLocaleString('zh-CN', { hour12: false }) : '时间未知'
  return `n=${call.n} · ${call.name || '(未知工具)'} · ${call.ok ? '成功' : '失败'} · ${call.chars} 字 · 指纹 ${call.fp} · ${when}`
}

/**
 * 目录：本会话最近可回取的工具调用。
 *
 * @param {string} sessionId
 * @param {{ query?: string, tool?: string, limit?: number }} [options]
 * @returns {Promise<{ text: string, count: number, total: number, truncated: boolean }>}
 */
async function catalogOf(sessionId, options = {}) {
  const got = await collect(sessionId, { query: options.query, tool: options.tool })
  const limit = Math.min(MAX_CATALOG, Math.max(1, Number(options.limit) || MAX_CATALOG))
  const recent = got.calls.slice(-limit)
  if (recent.length === 0) {
    const why = got.broken > 0 ? `（另有 ${got.broken} 行解不开，已跳过）` : ''
    /*
     * ★ 分清「真没有」和「还没落盘」。
     *   会话是**每轮结束之后**才写盘的（渲染层拿到 done 才 append），所以**同一轮进行中**
     *   调 recall 时，本轮刚跑完的工具结果还只在内存里 —— 这时说「没有可回取的记录」
     *   是在撒谎（有，只是还没落盘），模型会以为当时真的什么都没跑。
     */
    const pending = got.lines <= 2
    if (pending) {
      return {
        text:
          `本会话还没有已落盘的工具记录（只扫到 ${got.lines} 行，看起来是刚建 / 本轮还没结束）。` +
          '会话是**每轮结束后**才写盘的 —— 本轮刚跑的工具结果要等这一轮收尾之后才能回取；' +
          '如果它就在上面的上下文里，直接用那份，不必回取。',
        count: 0,
        total: 0,
        truncated: got.truncated,
      }
    }
    return {
      text: `本会话没有可回取的工具记录${options.query ? `（没找到含「${options.query}」的输出）` : ''}${why}。扫描 ${got.lines} 行。`,
      count: 0,
      total: 0,
      truncated: got.truncated,
    }
  }
  const head =
    `本会话最近 ${recent.length} 次工具调用（共扫到 ${got.total} 次，只保留最近 ${MAX_KEEP} 次）：` +
    (got.truncated ? `\n⚠ 扫描超过 ${SCAN_MS / 1000} 秒提前停止，更早的记录没扫到。` : '') +
    (got.broken > 0 ? `\n⚠ 有 ${got.broken} 行解不开（换了 Windows 账户或 data/ 换机器会出现），已跳过。` : '')
  return {
    text: [head, '', ...recent.map(lineOf)].join('\n'),
    count: recent.length,
    total: got.total,
    truncated: got.truncated,
  }
}

/**
 * 取回某一次工具调用的**原始输出**（脱敏后按 offset/limit 切片）。
 *
 * 定位方式二选一：`fp`（折叠块里那串 8 位指纹）或 `n`（目录里的序号）。
 * 两种都必须**重新核对指纹** —— 记录可能在这之后被改写 / 被压缩点重排。
 *
 * @param {string} sessionId
 * @param {{ fp?: string, n?: number, offset?: number, limit?: number }} [options]
 * @returns {Promise<{ text: string, ok: boolean }>}
 */
async function fragmentOf(sessionId, options = {}) {
  const fp = String(options.fp ?? '').trim().toLowerCase()
  const n = Number(options.n) > 0 ? Number(options.n) : 0
  if (!fp && !n) {
    return { ok: false, text: '错误：要给 fp（折叠块里的 8 位指纹）或 n（目录里的序号）之一，否则不知道取哪一条。先调 recall 不带参数看目录。' }
  }

  const got = await collect(sessionId, {})
  const hit = fp
    ? got.calls.find((call) => call.fp === fp)
    : got.calls.find((call) => call.n === n)
  if (!hit) {
    const hint = fp
      ? `没找到指纹 ${fp} 的记录（只覆盖最近 ${MAX_KEEP} 次工具调用；更早的可能已被压缩点覆盖）`
      : `没有 n=${n} 的记录（目录里最多 ${MAX_KEEP} 条，n 从 1 = 最近一次开始数）`
    return { ok: false, text: `错误：${hint}。` }
  }

  /* 按行重读，只解析那一行 —— 不把整份会话读进内存 */
  const one = await collect(sessionId, { lineNo: hit.line })
  const runs = Array.isArray(one.row?.toolRuns) ? one.row.toolRuns : []
  const run = runs[hit.runIndex]
  if (!run) {
    return { ok: false, text: `错误：第 ${hit.line} 行里已经没有第 ${hit.runIndex + 1} 条工具记录了（记录被改写过）。` }
  }
  const raw = String(run?.output ?? '')
  const nowFp = fingerprint(viewContentOf(run))
  if (nowFp !== hit.fp) {
    return {
      ok: false,
      text: `错误：指纹对不上（目录里是 ${hit.fp}，现在算出来是 ${nowFp}）—— 这条记录在这之后被改写过，不能当成原来那份证据。`,
    }
  }

  const offset = Math.max(0, Number(options.offset) || 0)
  const limit = Math.min(MAX_BODY, Math.max(200, Number(options.limit) || DEF_BODY))
  const body = redact(raw.slice(offset, offset + limit))
  const end = Math.min(raw.length, offset + limit)
  const when = hit.at ? new Date(hit.at).toLocaleString('zh-CN', { hour12: false }) : '时间未知'
  const more =
    end < raw.length
      ? `\n\n（还有 ${raw.length - end} 字没有返回 —— 用 recall({ fp: "${hit.fp}", offset: ${end} }) 继续读）`
      : ''

  return {
    ok: true,
    text:
      `来源：会话 ${sessionId} · 第 ${hit.line} 行第 ${hit.runIndex + 1} 条 · 工具 [${hit.name || '未知'}] · ` +
      `${hit.ok ? '成功' : '失败'} · ${when} · 指纹 ${hit.fp}（已核对）\n` +
      `本次返回：偏移 ${offset}-${end} / 共 ${raw.length} 字\n\n` +
      `─── 正文 ───\n${body}${more}`,
  }
}

module.exports = {
  MAX_KEEP,
  MAX_CATALOG,
  DEF_BODY,
  MAX_BODY,
  viewContentOf,
  collect,
  catalogOf,
  fragmentOf,
}
