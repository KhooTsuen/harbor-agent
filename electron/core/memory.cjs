/**
 * 记忆（门面）
 *
 * 存储与结构在 memory-store.cjs（每条一个对象，带类型/范围/来源/置信度）。
 * 检索与注入在 memory-recall.cjs。
 * 这一层负责三件事：
 *
 *   ① 给模型用的 `remember` 工具兜底（策略见 config.memory.autoWrite）
 *   ② 兼容老的纯文本接口（read/write）—— 设置页里还能整段编辑，
 *      只是写回来时会按行拆成条目
 *   ③ 老 memory.md 的迁移
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const store = require('./memory-store.cjs')
const recall = require('./memory-recall.cjs')

/** 老文件的路径，仅用于迁移 */
function legacyFile() {
  return path.join(DIRS.data, 'memory.md')
}

/* ══════════════════════════════════════════════════════════════
   迁移：老 memory.md → 结构化条目
   ══════════════════════════════════════════════════════════════ */

function migrateLegacy() {
  if (!fs.existsSync(legacyFile())) return { migrated: 0 }
  if (store.list({ includeSuperseded: true }).length > 0) return { migrated: 0 }

  let text = ''
  try {
    text = fs.readFileSync(legacyFile(), 'utf8')
  } catch {
    return { migrated: 0 }
  }

  const lines = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))

  let migrated = 0
  for (const line of lines) {
    const result = store.add({ content: line, type: 'fact', scope: 'global', source: 'imported' })
    if (result.ok) migrated += 1
  }

  if (migrated > 0) {
    /* 老文件改名留档，不删 —— 万一拆分错了用户还能找回来 */
    try {
      fs.renameSync(legacyFile(), path.join(DIRS.data, 'memory.md.migrated'))
    } catch {
      /* 改不动就算了 */
    }
    log.info(`记忆已迁移到结构化存储：${migrated} 条（老文件存为 memory.md.migrated）`)
  }
  return { migrated }
}

/* ══════════════════════════════════════════════════════════════
   兼容老接口（设置页整段编辑用）
   ══════════════════════════════════════════════════════════════ */

/** 渲染成纯文本（给老的 textarea 用） */
function read() {
  /*
   * 按**写入顺序**排（seq），不是按更新时间。
   * list() 是给界面用的（新的在前），但文本视图里顺序反过来
   * 会让人以为内容被重排了，而且 write → read 往返不稳定。
   */
  const items = store
    .list({ status: 'active' })
    .slice()
    .sort((a, b) => (a.seq ?? a.createdAt) - (b.seq ?? b.createdAt))
  return items.map((item) => `- ${item.content}`).join('\n')
}

/**
 * 整段覆盖写入。
 *
 * 按行拆成条目 —— 这样老的编辑体验不变，但底层已经是结构化的了。
 * 已有条目会被停用（不是删），保留历史。
 */
function write(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0)

  for (const item of store.list({ status: 'active' })) store.disable(item.id)
  for (const line of lines) {
    store.add({ content: line, type: 'fact', source: 'user_explicit' })
  }

  return { ok: true, count: lines.length, stats: stats() }
}

/** 追加一条（`remember` 工具走这里） */
function append(line) {
  const policy = autoWritePolicy()
  if (policy === 'off') {
    return {
      ok: false,
      error:
        '记忆写入被关掉了（设置 → 记忆 → 自动写入 = 关闭）。如果确实想记，让用户在设置里打开。',
    }
  }

  const result = store.add({
    content: line,
    type: 'fact',
    scope: 'global',
    /* 工具调用前面已经过一次用户确认（remember 算写操作），所以是「用户已确认」 */
    source: 'user_confirmed',
    confidence: 1,
    importance: 0.7,
  })

  return result.ok ? { ok: true, item: result.item, stats: stats() } : result
}

function autoWritePolicy() {
  try {
    return require('./config.cjs').get().memory.autoWrite
  } catch {
    return 'ask'
  }
}

function clear() {
  store.clear()
  return { ok: true, stats: stats() }
}

function stats() {
  const base = store.stats()
  return {
    ...base,
    count: base.active,
    maxChars: 12000,
    overLimit: base.active > base.maxItems,
  }
}

/* 第一次被 require 时做一次迁移 */
let migratedOnce = false
function ensureMigrated() {
  if (migratedOnce) return
  migratedOnce = true
  try {
    migrateLegacy()
  } catch (error) {
    log.warn(`记忆迁移失败：${error instanceof Error ? error.message : error}`)
  }
}

module.exports = {
  ensureMigrated,
  retrieve: recall.retrieve,
  buildPromptSection: recall.buildPromptSection,
  read,
  write,
  append,
  clear,
  stats,
  memoryFile: legacyFile,
  /* 结构化接口直接透出去，界面用得到 */
  list: store.list,
  search: store.search,
  add: store.add,
  update: store.update,
  disable: store.disable,
  enable: store.enable,
  remove: store.remove,
  TYPES: store.TYPES,
  SCOPES: store.SCOPES,
  SOURCES: store.SOURCES,
}
