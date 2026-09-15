/**
 * 结构化记忆：存储层
 *
 * 以前是一个 `memory.md` 纯文本，每轮整篇塞进系统提示。简单，但长期用会烂：
 * 所有记忆混在一起、没有来源、没有时间、没有作用范围、冲突了也没法处理，
 * 而且模型写错一条会持续影响之后**所有**对话。
 *
 * 词汇表与记录形状在 memory-schema.cjs，检索与注入在 memory-recall.cjs。
 *
 * 三个刻意的决定：
 *
 * ① **旧的不是删掉，是标 superseded**。用户能看见「以前记过什么、什么时候改的」，
 *    这对「为什么它这么理解我」很重要。
 * ② **用户明说的 vs 模型猜的，分开记 source**。前者 confidence=1 直接生效，
 *    后者要用户确认（策略在 config.memory.autoWrite）。
 * ③ **密钥、令牌一律不记**。这里再做一道过滤 —— 记忆每轮都进上下文，
 *    混进一个 key 就等于每轮都在泄露它。
 */

const fs = require('node:fs')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { findConflicts } = require('./memory-similarity.cjs')
const {
  TYPES,
  SCOPES,
  SOURCES,
  STATUSES,
  SECRET_LIKE,
  filePath,
  newId,
  nextSeq,
  clamp,
  limitFromConfig,
} = require('./memory-schema.cjs')

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    return {
      version: 1,
      items: Array.isArray(parsed.items)
        ? parsed.items.filter((i) => i && typeof i.content === 'string')
        : [],
    }
  } catch {
    return { version: 1, items: [] }
  }
}

function persist(data) {
  fs.mkdirSync(DIRS.data, { recursive: true })
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8')
}

/* ── 写 ──────────────────────────────────────────────────── */

/**
 * 加一条记忆。
 *
 * @param {object} input
 * @param {string} input.content
 * @param {string} [input.type]
 * @param {string} [input.scope]
 * @param {string} [input.source]
 * @param {number} [input.importance]
 * @param {string} [input.projectId]
 * @returns {{ ok: boolean, item?: object, superseded?: string[], error?: string, skipped?: string }}
 */
function add(input) {
  const content = String(input?.content ?? '').trim()
  if (!content) return { ok: false, error: '内容不能为空' }
  if (content.length > 500) return { ok: false, error: '一条记忆最多 500 字，请拆成几条' }

  /* 密钥不进记忆 —— 记忆每轮都注入，混一个 key 等于每轮都在泄露 */
  if (SECRET_LIKE.test(content)) {
    return { ok: false, error: '这段内容看起来含密钥/凭据，没有记下来。' }
  }

  const data = load()

  /* 完全相同的内容直接当重复 */
  const duplicate = data.items.find(
    (item) => item.status === 'active' && item.content.trim() === content,
  )
  if (duplicate) {
    duplicate.lastUsedAt = Date.now()
    persist(data)
    return { ok: true, item: duplicate, deduped: true }
  }

  const item = {
    id: newId(),
    /* 单调递增序号：一批条目可能落在同一毫秒里，只按 createdAt 排序是不稳定的 */
    seq: nextSeq(data),
    content,
    type: TYPES.includes(input.type) ? input.type : 'fact',
    scope: SCOPES.includes(input.scope) ? input.scope : 'global',
    source: SOURCES.includes(input.source) ? input.source : 'user_explicit',
    confidence: clamp(input.confidence, 0, 1, 1),
    importance: clamp(input.importance, 0, 1, 0.6),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsedAt: 0,
    expiresAt: Number(input.expiresAt) || 0,
    projectId: String(input.projectId ?? ''),
    status: 'active',
    supersededBy: '',
  }

  /* 和旧的冲突就取代（历史留着，只是不再注入） */
  const conflicts = findConflicts(data.items, item)
  for (const old of conflicts) {
    old.status = 'superseded'
    old.supersededBy = item.id
    old.updatedAt = Date.now()
  }

  data.items.push(item)

  /* 总量上限：超了就把最旧的 temporary 清掉，再超就拒绝 */
  const max = limitFromConfig()
  if (data.items.length > max) {
    const removable = data.items
      .filter((i) => i.status !== 'active' || i.type === 'temporary')
      .sort((a, b) => a.updatedAt - b.updatedAt)
    while (data.items.length > max && removable.length > 0) {
      const victim = removable.shift()
      data.items = data.items.filter((i) => i.id !== victim.id)
    }
    if (data.items.length > max) {
      return { ok: false, error: `记忆条数已达上限（${max}），先在设置里清理一些` }
    }
  }

  persist(data)
  log.info(
    `记忆 +1（${item.type}/${item.scope}/${item.source}）${conflicts.length > 0 ? `，取代 ${conflicts.length} 条` : ''}`,
  )
  return { ok: true, item, superseded: conflicts.map((c) => c.id) }
}

/* ── 改 / 删 ─────────────────────────────────────────────── */

function update(id, patch) {
  const data = load()
  const item = data.items.find((i) => i.id === id)
  if (!item) return { ok: false, error: '记忆不存在' }

  if (typeof patch.content === 'string' && patch.content.trim()) {
    if (SECRET_LIKE.test(patch.content)) return { ok: false, error: '内容看起来含密钥，没有保存' }
    item.content = patch.content.trim().slice(0, 500)
  }
  if (TYPES.includes(patch.type)) item.type = patch.type
  if (SCOPES.includes(patch.scope)) item.scope = patch.scope
  if (STATUSES.includes(patch.status)) item.status = patch.status
  if (patch.importance !== undefined)
    item.importance = clamp(patch.importance, 0, 1, item.importance)
  if (patch.confidence !== undefined)
    item.confidence = clamp(patch.confidence, 0, 1, item.confidence)

  item.updatedAt = Date.now()
  persist(data)
  return { ok: true, item }
}

/**
 * 只记「这条被用上了」，不算修改。
 *
 * 以前检索完是调 `update(id, {})` —— 那个会把 updatedAt 顶到现在，
 * 于是界面上的「最近更新」实际显示的是「最近被注入」，一次编辑都没发生。
 * 而且每条都要重写一遍 memory.json。
 */
function touch(ids) {
  const list = Array.isArray(ids) ? ids : [ids]
  if (list.length === 0) return { ok: true, touched: 0 }
  const data = load()
  const now = Date.now()
  let touched = 0
  for (const item of data.items) {
    if (list.includes(item.id)) {
      item.lastUsedAt = now
      touched += 1
    }
  }
  if (touched > 0) persist(data)
  return { ok: true, touched }
}

/** 停用而不是删除 —— 用户可能只是想让它暂时别生效 */
function disable(id) {
  return update(id, { status: 'disabled' })
}

function enable(id) {
  return update(id, { status: 'active' })
}

function remove(id) {
  const data = load()
  const before = data.items.length
  data.items = data.items.filter((i) => i.id !== id)
  persist(data)
  return { ok: true, removed: before - data.items.length }
}

function clear() {
  persist({ version: 1, items: [] })
  return { ok: true }
}

/* ── 读 ──────────────────────────────────────────────────── */

/**
 * 列出记忆。
 *
 * @param {{ status?: string, scope?: string, type?: string, includeSuperseded?: boolean }} options
 */
function list(options = {}) {
  const data = load()
  let items = data.items

  if (!options.includeSuperseded) items = items.filter((i) => i.status !== 'superseded')
  if (options.status) items = items.filter((i) => i.status === options.status)
  if (options.scope) items = items.filter((i) => i.scope === options.scope)
  if (options.type) items = items.filter((i) => i.type === options.type)

  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 关键词搜索（标题、内容、类型都搜） */
function search(query) {
  const text = String(query ?? '')
    .toLowerCase()
    .trim()
  if (!text) return list()
  return list({ includeSuperseded: true }).filter((item) =>
    `${item.content} ${item.type} ${item.scope}`.toLowerCase().includes(text),
  )
}

/** 过期清扫 */
function pruneExpired() {
  const data = load()
  const now = Date.now()
  const before = data.items.length
  data.items = data.items.filter((item) => !(item.expiresAt && item.expiresAt < now))
  if (data.items.length !== before) persist(data)
  return { ok: true, removed: before - data.items.length }
}

function stats() {
  const items = list({ includeSuperseded: true })
  const active = items.filter((i) => i.status === 'active')
  const byType = {}
  const byScope = {}
  for (const item of active) {
    byType[item.type] = (byType[item.type] ?? 0) + 1
    byScope[item.scope] = (byScope[item.scope] ?? 0) + 1
  }
  return {
    total: items.length,
    active: active.length,
    disabled: items.filter((i) => i.status === 'disabled').length,
    superseded: items.filter((i) => i.status === 'superseded').length,
    byType,
    byScope,
    maxItems: limitFromConfig(),
  }
}

module.exports = {
  TYPES,
  SCOPES,
  SOURCES,
  add,
  update,
  touch,
  disable,
  enable,
  remove,
  clear,
  list,
  search,
  stats,
  pruneExpired,
  filePath,
}
