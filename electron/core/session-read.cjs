/**
 * 会话存储：读
 *
 * 从 session.cjs 拆出来的（那边过 300 行了）。
 * 文件格式与按行读写见 session-io.cjs；写入见 session-write.cjs。
 */

const fs = require('node:fs')
const { DIRS } = require('./paths.cjs')
const { fileFor, isSessionId, safeTitle, readLines } = require('./session-io.cjs')
const { groupAnswers } = require('./session-answers.cjs')
/* 文本口径（含带图消息的多模态数组）只有一处实现：message-text.cjs */
const { textOf } = require('./message-text.cjs')
/* 只借一个纯函数（id 形状），不借它的读写 —— 避免和 projects 那边成环 */
const { dirIdFor } = require('./projects.cjs')
/* 按 key 收敛流式快照 —— 2026-10-20 拆到独立文件（本文件贴过 300 行红线） */
const { collapseByKey } = require('./session-collapse.cjs')
const { replayToolRuns } = require('./session-replay.cjs')
/* P0-1：按完整轮次截取（唯一一处）；P0-2：有效压缩点（唯一一处） */
const { takeTurns } = require('./history-window.cjs')
const { effectivePoint, summaryMessageOf } = require('./compact-point.cjs')
/* 只读首行的工具：列表与「改 meta」的快路径都靠它，不碰正文 */
const slot = require('./session-meta-slot.cjs')

/**
 * 消息条数缓存：`文件路径 → { stamp: 'mtimeMs:size', count }`。
 *
 * 只存**进程内**，不落盘（用户明确选了「不新增文件」）。文件一被追加
 * （mtime 或大小变了）就重算，所以不需要额外的失效逻辑。
 * 表的大小 = 会话数 × 一个小对象，可略。
 */
const countCache = new Map()


/**
 * 列所有会话（**只读第一行** + 一个 stat，不把 141MB 正文读进内存）。
 * 按 updatedAt 倒序。
 *
 * ── 2026-10-20：这是「打开软件卡 20 秒」的根因，修在这里 ──────────
 * 以前用 `readLines(id)` 整篇读 + 逐行解析，只为拿第一行的 meta。
 * 开发版有个 141 MB 的会话 → 10 个这样的会话 list() 实测 21 943 ms。
 * 现在只碰首行 4KB（`slot.readMeta`）。
 *
 * 两条口径必须交代：
 *  ① `messageCount` 走缓存（按 mtime+size 失效），数字与以前一致
 *     （同一套 collapse+groupAnswers）；它只用于诊断报告与扩展桥。
 *  ② 首行解不开时**回退 `readLines` 判断**，不能直接跳过 ——
 *     否则换过 Windows 账户 / 坏首行的会话会从列表里被悄悄抹掉。
 */
function list() {
  if (!fs.existsSync(DIRS.sessions)) return []

  const items = []
  for (const name of fs.readdirSync(DIRS.sessions)) {
    if (!name.endsWith('.jsonl')) continue
    const id = name.slice(0, -'.jsonl'.length)
    /* 名字不合规的（人手放进去的、老版本留下的）跳过：下面 `readLines` 会走
       `fileFor` 的白名单校验并抛错 —— 一个杂物文件不能让整个会话列表打不开 */
    if (!isSessionId(id)) continue
    const item = listOne(id)
    if (item) items.push(item)
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 单条会话的列表项；`null` = 这个文件不算一条会话（空文件 / 整篇都解不开） */
function listOne(id, options = {}) {
  const file = fileFor(id)
  const stat = fs.statSync(file)
  const quick = slot.readMeta(file)
  /*
   * 首行读不到 → 必须走整篇判断，不能直接跳过。
   * 走到这里的真实情形：加密文件换了 Windows 账户、首行半行损坏、
   * 老格式（第一行不是 meta）。它们以前由 `lines.length === 0` 决定去留。
   */
  if (!quick) {
    const lines = readLines(id)
    if (lines.length === 0) return null
    return buildItem(id, lines.find((l) => l.type === 'meta'), countMessages(id, file, stat, lines), stat)
  }
  /*
   * `skipCount`：跳过「数消息条数」这一步（启动路径用）。
   *
   * 数条数要把整个文件读进来解析 —— 开发版那个 141 MB 的会话要 2.9 秒，
   * 而且**无法中途打断**（单个文件是一个不可分割的同步块）。启动时为了
   * 侧栏能立刻出来，先给 0（缓存里有真值时带上）。
   *
   * ★ 不启动后台补算：实测那会在列表出来之后又卡 3 秒，等于把卡顿推迟。
   * ★ 0 不会被当成「真的没有消息」：渲染层不用这个字段显示任何东西，
   *   它只出现在诊断报告与扩展桥 —— 两者走的都是同步 `list()`，那里是真值。
   */
  const count = options.skipCount ? (countCache.get(file)?.count ?? 0) : countMessages(id, file, stat, null)
  return buildItem(id, quick.meta, count, stat)
}

/**
 * 消息条数（收敛 + 认领后）。
 *
 * `cached` 按 **mtime + size** 失效：文件一被追加就重算，没变就不碰正文。
 * 代价是进程内多留一张小表（会话数 × 一个数字），换来「重复打开软件不再等 20 秒」。
 */
function countMessages(id, file, stat, linesOrNull) {
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const hit = countCache.get(file)
  if (hit && hit.stamp === stamp) return hit.count
  const lines = linesOrNull ?? readLines(id)
  const count = groupAnswers(collapseByKey(lines.filter((l) => l.type === 'message'))).length
  countCache.set(file, { stamp, count })
  return count
}

/** 列表项的形状（**唯一一处**；`list()` 与异步版都走它，不许两边各写一套） */
function buildItem(id, meta, messageCount, stat) {
  return {
    id,
    title: safeTitle(meta?.title),
    mode: typeof meta?.mode === 'string' ? meta.mode : 'pair',
    model: typeof meta?.model === 'string' ? meta.model : '',
    /** 思考强度档位（low / high / max）；老会话没有就空串 */
    reasoning: typeof meta?.reasoning === 'string' ? meta.reasoning : '',
    /** 老会话没有这个字段，返回空串（前端会补上） */
    workdir: typeof meta?.workdir === 'string' ? meta.workdir : '',
    /*
     * 属于哪个项目（一等实体，见 projects.cjs）。
     *
     * ★ **老会话没有这个字段** —— 不能为了统一就去重写全部聊天记录（那是几千个
     *   文件的大规模改动，风险远大于收益）。所以这里按 workdir 现推：
     *   结果与升级前的分组**逐字一致**（同一个 `dir:<workdir>`）。
     *   新会话建的时候会把这个字段写进 meta（见 session-write.create）。
     */
    projectId:
      typeof meta?.projectId === 'string' && meta.projectId
        ? meta.projectId
        : typeof meta?.workdir === 'string' && meta.workdir
          ? dirIdFor(meta.workdir)
          : '',
    threadSettings:
      meta?.threadSettings && typeof meta.threadSettings === 'object'
        ? meta.threadSettings
        : undefined,
    ...(meta?.collab && typeof meta.collab === 'object' ? { collab: meta.collab } : {}),
    messageCount,
    createdAt: typeof meta?.createdAt === 'number' ? meta.createdAt : stat.birthtimeMs,
    updatedAt: stat.mtimeMs,
  }
}

/**
 * 列出用过的所有工作目录（按会话数排序）。
 *
 * 侧栏的「对话文件夹」靠它列菜单 —— 用户不需要自己记住"上次那个目录在哪"。
 * 老会话没记 workdir 的归到空串，前端会把它们显示成「未分类」。
 */
function search(query, limit = 50) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
  if (!q) return []
  const hits = []
  for (const item of list()) {
    const data = load(item.id)
    for (const message of data?.messages ?? []) {
      const content = String(message.content ?? '')
      const index = content.toLowerCase().indexOf(q)
      if (index < 0) continue
      hits.push({
        threadId: item.id,
        title: item.title,
        workdir: item.workdir ?? '',
        timestamp: message.ts ?? item.updatedAt,
        role: message.role,
        snippet: content.slice(Math.max(0, index - 80), index + q.length + 160),
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

function workdirs() {
  const counts = new Map()
  for (const item of list()) {
    const key = typeof item.workdir === 'string' ? item.workdir : ''
    const entry = counts.get(key) ?? { workdir: key, count: 0, lastUsedAt: 0 }
    entry.count += 1
    entry.lastUsedAt = Math.max(entry.lastUsedAt, item.updatedAt)
    counts.set(key, entry)
  }
  return [...counts.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

function load(id) {
  const lines = readLines(id)
  if (lines.length === 0) return null
  const meta = lines.find((l) => l.type === 'meta') ?? {
    type: 'meta',
    id,
    title: '新对话',
    mode: 'pair',
    model: '',
    createdAt: Date.now(),
  }
  const messages = groupAnswers(collapseByKey(lines.filter((l) => l.type === 'message')))
  /* 压缩点：每次压缩往文件里追加一条，保留历史（可以看压缩是怎么一路发生的） */
  const compacts = lines.filter((l) => l.type === 'compact')
  const stateEvents = lines.filter((l) => l.type === 'conversation_state')
  const state = stateEvents.at(-1)?.state ?? null
  const threadSettings = meta.threadSettings ?? null
  return { meta, messages, compacts, state, threadSettings }
}

/**
 * 把会话转成模型要的 messages 格式。
 *
 * ★ 2026-10-23（P0-1 / P0-2）两条口径都改了，两条路必须同形：
 *
 *   · **先展开工具记录，再按完整轮次截取**（`history-window.cjs`）。
 *     以前是先按条数切、再展开 —— 于是一组工具调用会被切成两半：
 *     `assistant(tool_calls)` 带着 id 进来、`tool` 消息被切掉，上游直接 400
 *     「tool_call_id 无对应」。用户的观察是「30 次工具调用之后发一句『那个地方
 *     接着改』，最终请求里只剩这一句」。渲染层那份（`stores/thread/history.ts`）
 *     同规则。
 *   · **有效压缩点只有一处定义**（`compact-point.cjs`）：摘要段用 `system` 角色、
 *     文案与渲染层逐字一致。以前这里自己拼一句、界面那条路把整条摘要丢掉，
 *     「刚聊完」和「重开会话」模型看到的东西不一样。
 */

/** 这条记录里有可用的图片吗（用户带图提问时，图片是单独存的一个数组） */
const hasImages = (m) => Array.isArray(m.images) && m.images.some((x) => typeof x === 'string' && x)

/**
 * 一条记录 → 发给模型的内容。
 *
 * ★ 带图的消息必须还原成**多模态数组**。以前这里只发 `content`（文字），
 *   于是「恢复任务」时模型只看得到「（图片）」这种占位文字 —— 和
 *   `src/stores/thread/history.ts` 里那条规则是同一件事，两边都得说。
 */
function contentOf(m) {
  const images = Array.isArray(m.images) ? m.images.filter((x) => typeof x === 'string' && x) : []
  if (images.length === 0) return textOf(m.content)
  return [
    ...(textOf(m.content).trim() ? [{ type: 'text', text: m.content }] : []),
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ]
}

/**
 * 一条记录 → 若干条 API 消息（工具记录展开成 assistant(tool_calls) + tool）。
 * 展开规则本身在 `session-replay.cjs` —— 那边是唯一一处。
 */
function expandOne(m, index) {
  const content = contentOf(m)
  const runs = Array.isArray(m.toolRuns) ? m.toolRuns : []
  if (m.role === 'assistant' && runs.length > 0) {
    const seed = String(m.key ?? '').slice(-8) || `L${index}`
    return replayToolRuns({ content }, runs, seed)
  }
  return [{ role: m.role, content }]
}

function toApiMessages(id, limit = 20) {
  const data = load(id)
  if (!data) return []

  const usable = data.messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      /* 只有图片、没有文字的那条也算可用 —— 不然「光发一张图」在这条链路上会整条消失 */
      (typeof m.content === 'string' && m.content.trim() ? true : hasImages(m)),
  )

  /*
   * 压缩点：**只认覆盖最靠后的那一次**（`compact-point.cjs` 是唯一定义）。
   * 以前是 `compacts[compacts.length - 1]` —— 数组顺序与覆盖范围没有必然关系。
   */
  const point = effectivePoint(data.compacts)
  const afterCompact = point ? usable.slice(point.upTo) : usable

  /* 先展开（这里才有 tool_calls / tool 的成组关系），再按轮次切 */
  const expanded = afterCompact.flatMap((m, i) => expandOne(m, i))
  /* limit 是「逐条带多少条」的预算，摘要段不算在内；切点只落在轮次边界 */
  const windowed = takeTurns(expanded, limit, { minTurns: 1 })

  const out = []
  const summary = summaryMessageOf(point)
  if (summary) out.push(summary)
  out.push(...windowed.kept)
  return out
}

module.exports = { list, listOne, load, search, workdirs, toApiMessages, collapseByKey }
