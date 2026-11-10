/**
 * 外部接入的**适配入口**（第 2 项）
 *
 * ── 这个文件是什么，不是什么 ────────────────────────────────────
 * 它**不是** App Server / ACP 的实现，也**没有**连到任何外部进程。
 * 它做两件已能落地的事：
 *
 *   ① 把「外部来源能提供什么」写成一张**能力声明表** —— 阶段信号、消息身份、
 *      工具状态、取消确认、历史加载，各自「有 / 没有 / 不知道」。
 *      没有这张表，下游只能拿一个布尔量猜，或者干脆假设「都一样」。
 *   ② `normalizeIncoming()` 把外部形状归一到 Harbor 的统一形状，**缺失一律留空**，
 *      绝不按位置或内容补一个看起来合理的值（那是第 2 项禁止的「靠内容猜身份」）。
 *
 * ── 为什么先做这一层 ──────────────────────────────────────────
 * 2026-11-11 全仓扫 1775 个源码文件：`app-server` / `acp` **零命中** —— 适配层
 * 根本不存在。所以「映射真实可用的正文阶段信号」没有可映射的对象。先定契约，
 * 将来谁接谁按这张表来；表里写「不知道」的项，实现方必须保留未知，不许自己造。
 *
 * ⚠️ 纯函数、不 require electron、不联网 —— 自检能直接跑。
 */

/**
 * 每个来源能提供什么。`true` = 有；`false` = 明确没有；`'unknown'` = **没核实过**。
 *
 * ★ `'unknown'` 和 `false` 必须分开：前者是「还没查」，后者是「查过，没有」。
 *   合并成一个值，将来就会出现「以为没有、其实只是没查」的误判。
 */
const CAPABILITIES = {
  /* 本机 codex 子进程（`codex-cli.cjs`）—— 已核实 */
  'codex-cli': {
    textStages: false, // content 事件不带 stage（单模型普通正文确实没有）
    messageIdentity: true, // item.id 已保住 → segments
    toolStatus: false, // JSONL 没有 tool_call 事件，工具在 Codex 自己那边
    cancelConfirm: false, // 只能 abort，拿不到「对端确认已取消」
    historyLoad: false, // 不能回读历史，只能实时
  },
  /* HTTP/SSE 的 OpenAI 兼容接口（`llm.cjs`）—— 已核实 */
  openai: {
    textStages: false,
    messageIdentity: false, // 流里没有消息 id
    toolStatus: true, // tool_calls 与 finish_reason 都在
    cancelConfirm: false,
    historyLoad: false,
  },
  /* 2026-11-11：适配层尚未实现，以下全部按「没核实过」记，不假装有 */
  'app-server': {
    textStages: 'unknown',
    messageIdentity: 'unknown',
    toolStatus: 'unknown',
    cancelConfirm: 'unknown',
    historyLoad: 'unknown',
  },
  acp: {
    textStages: 'unknown',
    messageIdentity: 'unknown',
    toolStatus: 'unknown',
    cancelConfirm: 'unknown',
    historyLoad: 'unknown',
  },
}

/** 这条来源有没有真的接上（当前只有前两个有实现） */
function isWired(source) {
  return source === 'codex-cli' || source === 'openai'
}

/** 这一项能不能当作「确定有」来依赖 —— `'unknown'` 一律不能 */
function confirmed(source, key) {
  const item = CAPABILITIES[source]
  return Boolean(item) && item[key] === true
}

/**
 * 外部消息 → Harbor 的统一形状。
 *
 * `origin` 说明这段从哪儿来，下游据此决定能不能信它的顺序：
 *   · `live`    实时流（正常执行）
 *   · `replay`  本地回放（读自己落盘的记录）
 *   · `remote`  对端加载（从外部来源拉回来的历史，顺序可信度取决于对端）
 *
 * ★ `text` 缺失就是空串，`id` 缺失就是空串 —— **不生成序号、不拿位置冒充**。
 */
function normalizeIncoming(input, origin = 'live') {
  const raw = input && typeof input === 'object' ? input : {}
  const kind = raw.kind === 'tool' || raw.kind === 'reasoning' ? raw.kind : 'speech'
  const stage = raw.stage === 'answer' || raw.stage === 'process' ? raw.stage : undefined
  return {
    kind,
    /* 上游给的身份：没有就空串，绝不用「第几段」顶替 */
    sourceId: typeof raw.id === 'string' ? raw.id : '',
    text: typeof raw.text === 'string' ? raw.text : '',
    /* 阶段信号缺失 = 不知道这一段算不算答复，下游按「未确认」处理 */
    ...(stage ? { stage } : {}),
    ...(typeof raw.toolId === 'string' && raw.toolId ? { toolId: raw.toolId } : {}),
    origin,
  }
}

/**
 * 取消的可信度：能不能证明「对端真的停了」。
 *
 * `abort-only` 只代表我们这边不再等，**不代表对端已停** —— 这条区别决定
 * 界面能不能写「已停止」，写早了就是谎报。
 */
function cancelAssurance(source) {
  return confirmed(source, 'cancelConfirm') ? 'confirmed' : 'abort-only'
}

module.exports = { CAPABILITIES, isWired, confirmed, normalizeIncoming, cancelAssurance }
