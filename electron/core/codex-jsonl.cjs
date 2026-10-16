/**
 * codex CLI 的 **JSONL 解析与事件归约**（纯函数 · 可单测 · 不 require electron）
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────
 *
 * 子进程的 stdout 是**字节流**，一次 chunk 可能切在行中间；而 `codex exec --json`
 * 是**一行一个 JSON 事件**。这两件事都必须处理，且都必须能**单测**（不能真起 codex）。
 * 所以：切行 + 解析 + 归约全在这里；`codex-cli.cjs` 只管起进程与接线。
 *
 * ── ★ 三条「不信任输入」的规矩 ────────────────────────────────
 *
 *   ① **半行不丢**：chunk 末尾没有换行的部分留在缓冲区，等下一块；`flush()` 处理
 *      最后一行（有些进程结尾不带换行）。
 *   ② **坏行不炸**：解析失败的行**计数跳过**，不抛 —— 上游多打一行非 JSON 的日志
 *      不该让整次对话失败（但计数要看得见，见 `stats.badLines`）。
 *   ③ **超长行防护**：超过上限的行丢弃并计数（畸形输出不该把内存吃掉）。
 *
 * ── ★★ 一条容易搞错的语义（实测得出，别按 HTTP 那套写）────────
 *
 * codex 的 `error` 事件**不是致命错误**：实测里它是
 * `Reconnecting... 2/5 (request timed out)` 这种**可恢复的重连提示**，
 * 之后照样拿到了正常回答。所以归约层**只收集、不抛**；
 * 「到底算不算失败」由调用方按「最后有没有内容」判（见 `codex-cli.cjs`）。
 * 这与 `llm.cjs` 的「流里带 error 就抛」**刻意不同** —— 两边协议不同，别统一。
 *
 * 实测形状见 `docs/research/codex-cli-adapter-design.md` §2。
 */

/** 单行上限（8MB）：超过就当坏行丢掉 —— 正常事件是几百字节 */
const DEFAULT_MAX_LINE = 8 * 1024 * 1024

/**
 * 造一个增量 JSONL 解析器。逐块 `push()`，结束时 `flush()`。
 *
 * @param {{ maxLine?: number }} [opts]
 */
function createJsonlParser(opts = {}) {
  const maxLine = Number(opts.maxLine) > 0 ? Number(opts.maxLine) : DEFAULT_MAX_LINE
  let buffer = ''
  let badLines = 0
  let droppedLines = 0

  /** 一行 → 事件对象（空行/坏行/超长行 → null，并计数） */
  function parseLine(line) {
    const trimmed = line.trim() /* 顺带吃掉 \r（Windows 的 \r\n）与首尾空白 */
    if (!trimmed) return null
    if (trimmed.length > maxLine) {
      droppedLines += 1
      return null
    }
    try {
      const value = JSON.parse(trimmed)
      /* ★ 事件必须是**对象**：数组/标量不是 codex 的事件形状，一律当无效行（不塞给归约层） */
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch {
      badLines += 1
      return null
    }
  }

  return {
    /** 喂一块文本，返回这次能解析出的事件（0 个或多个） */
    push(chunk) {
      buffer += String(chunk ?? '')
      /* 一次 push 里可能有多个换行；**最后一段**（无换行）留在缓冲区等下一块 */
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      const events = []
      for (const part of parts) {
        const ev = parseLine(part)
        if (ev) events.push(ev)
      }
      return events
    },
    /** 收尾：处理缓冲区里最后一行（可能没有） */
    flush() {
      if (!buffer) return []
      const last = buffer
      buffer = ''
      const ev = parseLine(last)
      return ev ? [ev] : []
    },
    /** 解析统计（自检/诊断用）：坏行、丢弃的超长行、还没凑成整行的字节数 */
    get stats() {
      return { badLines, droppedLines, pending: buffer.length }
    },
  }
}

/**
 * codex 的 usage → **OpenAI 原字段**。
 *
 * ★ 为什么必须转：下游（`budget.cjs` / `stats.cjs` / `token-metrics.cjs`）一律按
 *   `prompt_tokens` / `completion_tokens` / `total_tokens` 读 —— 形状知识只那一处。
 *   直接把 codex 的 `{input_tokens,…}` 递下去，用量会永远记成 0（单测还全绿）。
 *   （`budget.cjs` 文件头记过同类事故：把 `total_tokens` 读成 `total`。）
 *
 * @param {object} raw `turn.completed.usage`
 */
function mapUsage(raw) {
  const u = raw && typeof raw === 'object' ? raw : {}
  const input = Number(u.input_tokens) || 0
  const output = Number(u.output_tokens) || 0
  const cached = Number(u.cached_input_tokens) || 0
  const reasoning = Number(u.reasoning_output_tokens) || 0
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    /* 缓存命中与思考 token 也是既有读法（stats.cjs / budget.cjs）—— 一起给全 */
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: reasoning },
  }
}

/** 归约状态的初值 */
function newState() {
  return {
    /** 正文（把多个 agent_message 拼起来） */
    text: '',
    /** 进度/可恢复的提示（重连、配置警告…）——**不作为失败判据**，只在真没内容时当线索 */
    notices: [],
    /** OpenAI 形状的 usage（没拿到就是 null） */
    usage: null,
    /** `thread.started.thread_id`（将来做 resume 会用，本批只记） */
    threadId: '',
    /** 收到过 turn.completed */
    turnCompleted: false,
  }
}

/**
 * 把一个事件归约进状态（原地改 state 并返回它）。
 *
 * 认得的四种实测事件：`thread.started` / `turn.started` / `item.completed` /
 * `turn.completed`，外加 `error`。**认不出的一律忽略**（上游加事件不该让我们炸）。
 */
function applyEvent(state, event) {
  const s = state
  const type = String(event?.type ?? '')
  if (type === 'thread.started') {
    s.threadId = String(event.thread_id ?? '')
    return s
  }
  if (type === 'turn.completed') {
    s.usage = mapUsage(event.usage)
    s.turnCompleted = true
    return s
  }
  if (type === 'item.completed') {
    const item = event.item && typeof event.item === 'object' ? event.item : {}
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      s.text += item.text
    } else if (item.type === 'error' || item.type === 'warning') {
      /* 实测这种是「配置项被忽略」一类 —— 记下来，不当作失败 */
      s.notices.push(String(item.message ?? ''))
    }
    return s
  }
  if (type === 'error') {
    s.notices.push(String(event.message ?? ''))
    return s
  }
  return s
}

module.exports = { createJsonlParser, mapUsage, newState, applyEvent, DEFAULT_MAX_LINE }
