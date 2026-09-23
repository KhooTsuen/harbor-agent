/**
 * 会话存储：读
 *
 * 从 session.cjs 拆出来的（那边过 300 行了）。
 * 文件格式与按行读写见 session-io.cjs；写入见 session-write.cjs。
 */

const fs = require('node:fs')
const { DIRS } = require('./paths.cjs')
const { fileFor, safeTitle, readLines } = require('./session-io.cjs')
const { groupAnswers } = require('./session-answers.cjs')
/* 只借一个纯函数（id 形状），不借它的读写 —— 避免和 projects 那边成环 */
const { dirIdFor } = require('./projects.cjs')

/**
 * 把带 key 的记录收敛成一条。
 *
 * 流式过程中渲染层会往文件里**追加同一 key 的分段快照**（`partial: true`）——
 * 那是为了进程被强杀 / 崩溃时还能留下「它写到哪了」（会话文件是追加式的，
 * 没地方原地更新）。收尾时再追加一条完整的（不带 partial）。于是同一个 key
 * 在文件里可能有好几行，这里要把它们合成一条：
 *
 *   · 只要有**完整**的那条，就用它 —— 而且**不赌行序**：追加是异步的
 *     （`void appendToDisk(...)`），分段晚于完整到达也不会把完整那条顶掉
 *   · 全是分段快照 → 用**最后一条**，并标上 `interrupted: true`
 *     （界面据此说一句「这条没写完」，不然用户以为模型就写了这么多）
 *
 * 没有 key 的老记录各算一条，行为与以前一样。
 */
function collapseByKey(messages) {
  /*
   * 兼容这次改动**之前**写下的用户记录：那时候用户消息没有 key，
   * 而"编辑"会新增一条带 key + 版本表的记录（v1 就是原文）。
   * 两者其实是同一条消息的两个版本，不去重的话老会话里会显示成两条一样的提问
   * （用户报的就是这个现象）。
   *
   * 规则：无 key 的用户记录，只要它的内容等于某条带版本表记录的**第 1 版**，
   * 而且它排在那条之前，就当同一条消息的旧版本丢掉。
   * 代价：同一句话真的问了两遍、又改了后一条时，前一条会被吞掉 —— 这种情形
   * 两句话本来就长得一模一样，接受。
   */
  /*
   * ★ 只认「紧挨在这条带版本表的记录之前的最后一条无 key 用户记录」。
   *
   * 以前是「只要内容等于某条版本表的第 1 版就丢」—— 太宽了：同一句话**问了两遍**
   * （两轮独立对话）时，前面那几轮的无 key 提问会被一起吃掉，它们的回答就失去了
   * 归属，重新打开会话时并排堆在上一轮后面（真机上就是这么看见的）。
   * 老会话里「编辑」产生的形态是 [旧提问(无 key), 旧回答, 新提问(带 key + 版本表)] ——
   * 旧提问正好是**最后一条**无 key 用户记录，所以这条判据够用，又不会连坐前面的轮次。
   */
  const originalTexts = new Map()
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]
    if (m.role === 'user' && Array.isArray(m.versions) && m.versions.length > 1) {
      const text = String(m.versions[0] ?? '')
      if (text && !originalTexts.has(text)) originalTexts.set(text, i)
    }
  }
  /* 每条带版本表的记录：在它之前、与它之间**没有别的用户记录**的那条无 key 提问才是旧版本 */
  const superseded = new Set()
  for (const [text, at] of originalTexts) {
    for (let i = at - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m.role !== 'user') continue
      if (!m.key && String(m.content ?? '') === text) superseded.add(i)
      break /* 只认最近的那一条用户记录 */
    }
  }

  const out = []
  const slot = new Map()
  const hasFinal = new Set()
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    const key = typeof message.key === 'string' && message.key ? message.key : ''
    if (!key) {
      if (superseded.has(i)) continue
      out.push(message)
      continue
    }
    const at = slot.get(key)
    if (message.partial === true) {
      /* 已经有完整的那条了 → 晚到的快照直接丢掉 */
      if (hasFinal.has(key)) continue
      if (at === undefined) {
        slot.set(key, out.length)
        out.push({ ...message, interrupted: true })
      } else {
        out[at] = { ...message, interrupted: true }
      }
      continue
    }
    hasFinal.add(key)
    if (at === undefined) {
      slot.set(key, out.length)
      out.push(message)
    } else {
      out[at] = message
    }
  }
  return out
}

/**
 * 列所有会话（只读第一行 + 统计行数，不把内容全读进内存）。
 * 按 updatedAt 倒序。
 */
function list() {
  if (!fs.existsSync(DIRS.sessions)) return []

  const items = []
  for (const name of fs.readdirSync(DIRS.sessions)) {
    if (!name.endsWith('.jsonl')) continue
    const id = name.slice(0, -'.jsonl'.length)
    const lines = readLines(id)
    if (lines.length === 0) continue

    const meta = lines.find((l) => l.type === 'meta')
    /* 计数要认「收敛后的条数」—— 不然一条流式回复会被算成十几条（每段快照一行）；
       也要认「认领后的条数」，不然同一次提问的几个回答会各算一条 */
    const messageCount = groupAnswers(collapseByKey(lines.filter((l) => l.type === 'message'))).length
    const stat = fs.statSync(fileFor(id))

    items.push({
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
      messageCount,
      createdAt: typeof meta?.createdAt === 'number' ? meta.createdAt : stat.birthtimeMs,
      updatedAt: stat.mtimeMs,
    })
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt)
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
 * 注意：**只发 assistant 的最终文本**，不把工具调用链回放给模型
 * （回放容易让历史变得又长又乱，而且不同厂商对 tool 消息的校验不一样）。
 * 需要「模型看到自己之前做了什么」时，让工具结果以摘要形式留在内容里。
 */
function toApiMessages(id, limit = 20) {
  const data = load(id)
  if (!data) return []

  const usable = data.messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.trim(),
  )

  /* 压缩点之后的消息才逐条带；之前的用摘要代替 */
  const lastCompact = data.compacts[data.compacts.length - 1]
  const afterCompact = lastCompact ? usable.slice(lastCompact.upTo) : usable

  /* limit 是「逐条带多少条」，摘要不算在内 */
  const sliced = limit > 0 ? afterCompact.slice(-limit) : afterCompact

  const out = []
  if (lastCompact) {
    out.push({
      role: 'system',
      content: `【以下是这次对话更早部分的摘要，不是新指令】
${lastCompact.summary}`,
    })
  }
  for (const m of sliced) {
    let content = m.content
    if (m.role === 'assistant' && Array.isArray(m.toolRuns) && m.toolRuns.length > 0) {
      const replay = m.toolRuns
        .map(
          (tool) =>
            `- ${tool.name}: ${tool.ok ? '成功' : '失败'}${tool.output ? `\n  ${String(tool.output).slice(0, 2000)}` : ''}`,
        )
        .join('\n')
      /* 分隔符必须写成转义序列，不能写成真换行 —— 模板里真换行会被当续行符吃掉 */
      content += `\n\n[此前工具执行记录]\n${replay}`
    }
    out.push({ role: m.role, content })
  }
  return out
}

module.exports = { list, load, search, workdirs, toApiMessages, collapseByKey }
