/**
 * 结构化记忆：存储层
 *
 * 以前是一个 `memory.md` 纯文本，每轮整篇塞进系统提示。简单，但长期用会烂：
 * 所有记忆混在一起、没有来源、没有时间、没有作用范围、冲突了也没法处理，
 * 而且模型写错一条会持续影响之后**所有**对话。
 *
 * 词汇表与记录形状在 memory-schema.cjs，检索与注入在 memory-recall.cjs。
 *
 * 四个刻意的决定：
 *
 * ① **旧的 / 过期的不是删掉，是标 superseded / expired** —— 用户要能看见「以前记过
 *    什么、什么时候改的、什么时候失效的」（§56 Forget ≠ Delete）。
 * ② **用户明说的 vs 模型猜的，分开记 source**；前者 confidence=1 直接生效，后者待确认。
 * ③ **密钥、令牌一律不记** —— 记忆每轮都进上下文，混进一个 key 就是每轮都在泄露。
 * ④ **类型由模型自己说清**（`append` 的 type）：它决定检索权重与会不会取代旧的。
 */

const fs = require('node:fs')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { writeAtomic, keepCorruptCopy } = require('./safe-write.cjs')
const { findConflicts } = require('./memory-similarity.cjs')
const {
  TYPES,
  SCOPES,
  SOURCES,
  STATUSES,
  looksLikeSecret,
  filePath,
  newId,
  nextSeq,
  clamp,
  limitFromConfig,
} = require('./memory-schema.cjs')

function load() {
  let raw = ''
  try {
    raw = fs.readFileSync(filePath(), 'utf8')
  } catch {
    return { version: 1, items: [] } /* 还没建过这个文件 = 空，不是错 */
  }
  try {
    const parsed = JSON.parse(raw)
    const items = Array.isArray(parsed.items) ? parsed.items.filter((i) => i && typeof i.content === 'string') : []
    return { version: 1, items }
  } catch (error) {
    /* 解不开：先留一份 —— 不然接下来任何一次 add/touch 写盘都会把它盖成空列表 */
    log.error(`记忆文件解不开（已另存 ${keepCorruptCopy(filePath())}）：${error instanceof Error ? error.message : error}`)
    return { version: 1, items: [] }
  }
}

function persist(data) {
  fs.mkdirSync(DIRS.data, { recursive: true })
  writeAtomic(filePath(), JSON.stringify(data, null, 2))
}

/* ── 写 ──────────────────────────────────────────────────── */

/**
 * 加一条记忆。合法值校验都在这里按 `memory-schema.cjs` 那份词汇表做。
 * @param {{ content: string, type?: string, scope?: string, source?: string,
 *   importance?: number, confidence?: number, expiresAt?: number, projectId?: string }} input
 * @returns {{ ok: boolean, item?: object, superseded?: string[], error?: string, deduped?: boolean }}
 */
function add(input) {
  const content = String(input?.content ?? '').trim()
  if (!content) return { ok: false, error: '内容不能为空' }
  if (content.length > 500) return { ok: false, error: '一条记忆最多 500 字，请拆成几条' }

  /* 密钥不进记忆（每轮注入 = 每轮泄露）；判据只有一处：memory-schema → redact 模式表 */
  if (looksLikeSecret(content)) {
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
    if (looksLikeSecret(patch.content)) return { ok: false, error: '内容看起来含密钥，没有保存' }
    item.content = patch.content.trim().slice(0, 500)
  }
  if (TYPES.includes(patch.type)) item.type = patch.type
  if (SCOPES.includes(patch.scope)) item.scope = patch.scope
  if (STATUSES.includes(patch.status)) {
    item.status = patch.status
    /* 启用 = 再生效：不清 expiresAt 的话，下次检索立刻又把它标回 expired */
    if (patch.status === 'active') item.expiresAt = 0
  }
  if (patch.importance !== undefined)
    item.importance = clamp(patch.importance, 0, 1, item.importance)
  if (patch.confidence !== undefined)
    item.confidence = clamp(patch.confidence, 0, 1, item.confidence)

  item.updatedAt = Date.now()
  persist(data)
  return { ok: true, item }
}

/**
 * 只记「这条被用上了」，不算修改 —— 以前调 `update(id, {})` 会把 updatedAt 顶到现在，
 * 界面的「最近更新」显示的实际是「最近被注入」，而且每轮都要重写一遍 memory.json。
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

/** 列出记忆（options：status / scope / type / projectId / includeSuperseded） */
function list(options = {}) {
  const data = load()
  let items = data.items

  if (!options.includeSuperseded) items = items.filter((i) => i.status !== 'superseded')
  if (options.status) items = items.filter((i) => i.status === options.status)
  if (options.scope) items = items.filter((i) => i.scope === options.scope)
  if (options.type) items = items.filter((i) => i.type === options.type)
  if (options.projectId !== undefined) {
    items = items.filter(
      (i) => i.scope !== 'project' || (options.projectId && i.projectId === options.projectId),
    )
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 关键词搜索（标题、内容、类型都搜） */
function search(query, options = {}) {
  const text = String(query ?? '')
    .toLowerCase()
    .trim()
  if (!text) return list(options)
  return list({ ...options, includeSuperseded: true }).filter((item) =>
    `${item.content} ${item.type} ${item.scope}`.toLowerCase().includes(text),
  )
}

/*
 * 过期清扫：标记成 expired，**不删除**（§56 Forget ≠ Delete；理由见 docs/Memory设计.md）。
 * 标记后 retrieve 只取 active，注入行为不变；不动 updatedAt，否则过期条目在条数
 * 上限淘汰里会显得「很新」，反而最后才被清。
 */
function pruneExpired() {
  const data = load()
  const now = Date.now()
  let expired = 0
  for (const item of data.items) {
    if (item.status !== 'active' || !item.expiresAt || item.expiresAt >= now) continue
    item.status = 'expired'
    expired += 1
  }
  if (expired > 0) persist(data)
  return { ok: true, expired }
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
