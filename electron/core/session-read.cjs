/**
 * 会话存储：读
 *
 * 从 session.cjs 拆出来的（那边过 300 行了）。
 * 文件格式与按行读写见 session-io.cjs；写入见 session-write.cjs。
 */

const fs = require('node:fs')
const { DIRS } = require('./paths.cjs')
const { fileFor, safeTitle, readLines } = require('./session-io.cjs')

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
    const messageCount = lines.filter((l) => l.type === 'message').length
    const stat = fs.statSync(fileFor(id))

    items.push({
      id,
      title: safeTitle(meta?.title),
      mode: typeof meta?.mode === 'string' ? meta.mode : 'pair',
      model: typeof meta?.model === 'string' ? meta.model : '',
      /** 老会话没有这个字段，返回空串（前端会补上） */
      workdir: typeof meta?.workdir === 'string' ? meta.workdir : '',
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
  const messages = lines.filter((l) => l.type === 'message')
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

module.exports = { list, load, search, workdirs, toApiMessages }
