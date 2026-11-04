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
const explain = require('./memory-explain.cjs')
/* 「这两行是不是同一行改了字」—— 判据在 memory-similarity（与冲突取代同一处） */
const { pairEdits } = require('./memory-similarity.cjs')

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
 * 整段覆盖写入（`memory:set` 通道：数据搬运清空旧版整篇 / 老版本设置页的整段编辑）
 *
 * 按行拆成条目 —— 这样老的编辑体验不变，但底层已经是结构化的了。
 * 文本里没有的条目会被**停用**（不是删），保留历史。
 *
 * ★ P1（2026-11-05）修的是元数据：以前是「无条件停用全部 active，再把每一行
 *   add 成 fact/global」，于是任何走这条通道的整段写回都会把 type / scope /
 *   sessionId / projectId 冲成 `fact` / `global` / `''`：
 *
 *     · 偏好、约束、项目规则降级成事实 —— 检索时不再被优先遵守；
 *     · 会话 / 项目作用域的记忆变成全局可见 —— **该藏的反而藏不住了**（SEC-065）。
 *
 *   探针实测：3 条（preference/project_rule/fact，含 project/session 归属）
 *   过一遍 write(read()) 之后，active 条数翻倍，而 type 只剩 fact、scope 只剩
 *   global、sessionId 全是空串、projectId 全空 —— 元数据**全部丢失**。
 *
 *   （当前界面已经改成逐条列表编辑，不再有整段 textarea；但这条通道还在
 *   预加载白名单里、数据搬运也用它，语义仍然要正确 —— 有损的入口留着就是隐患。）
 *
 *   现在的口径：这份纯文本只是**内容**视图（`read()` 本来也只输出内容行），
 *   所以「这行内容还在」= 这条记忆没被删，元数据一个字节都不动（连 updatedAt
 *   都不碰，往返是幂等的）；只有真消失的行才停用，只有新出现的行才新增。
 *
 * ★ P1 第二轮（同日）：上面这条只堵住了「保留」的一半 —— 用户**改掉一行里的字**
 *   时，内容既「消失」又「新出现」，于是照样会走「停用旧的 + 按 fact/global 新增」：
 *   实测一条 `instruction/session/s1` 改成同义句之后变成 `fact/global`，而在
 *   另一个会话 s2 里能读到它 —— 该藏的没藏住。现在先让 `pairEdits` 判断「这两行
 *   是不是同一行改了字」，配上的**原地换内容**（id/type/scope/sessionId/projectId
 *   全留），配不上的才按老口径处理。
 */
function write(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0)

  /* 内容 → 现有 active 条目（同内容有两条时按顺序一人认领一条，与老 add 的 dedupe 一致） */
  const byContent = new Map()
  for (const item of store.list({ status: 'active' })) {
    const bucket = byContent.get(item.content)
    if (bucket) bucket.push(item)
    else byContent.set(item.content, [item])
  }

  const keptIds = new Set()
  const keptContents = new Set()
  for (const line of lines) {
    const bucket = byContent.get(line)
    if (!bucket || bucket.length === 0) continue
    keptIds.add(bucket.shift().id)
    keptContents.add(line)
  }

  /* 文本里已经没有的条目 → 先别急着停用，看它是不是只被改了字 */
  const removed = []
  for (const bucket of byContent.values()) {
    for (const item of bucket) if (!keptIds.has(item.id)) removed.push(item)
  }

  /* 文本里新出现的行（同一行写了两次时只算一次，add 本来也会 dedupe） */
  const added = []
  for (const line of lines) {
    if (keptContents.has(line) || added.includes(line)) continue
    added.push(line)
  }

  const edited = pairEdits(removed, added)
  const editedIds = new Set(edited.map((pair) => pair.item.id))
  const editedLines = new Set(edited.map((pair) => pair.content))

  /* ① 同一行改了字：原地换内容 —— update() 只动 content/updatedAt，归属与类型碰都不碰 */
  for (const pair of edited) store.update(pair.item.id, { content: pair.content })

  /* ② 真被删掉的行 → 停用（不删，仍可追溯） */
  for (const item of removed) if (!editedIds.has(item.id)) store.disable(item.id)

  /* ③ 真新出现的行 → 新增（没有任何元数据可继承，按老口径 fact/global） */
  for (const line of added) {
    if (editedLines.has(line)) continue
    store.add({ content: line, type: 'fact', source: 'user_explicit' })
  }

  return { ok: true, count: lines.length, stats: stats() }
}


/** 追加一条（`remember` 工具走这里） */

/**
 * @param {string | { content?: string, type?: string, scope?: string, sessionId?: string, projectId?: string }} input
 *   老调用方传字符串（当 content）；`remember` 工具传对象，可以带 type/scope。
 *   type/scope 由 store.add 按 `memory-schema.cjs` 那份词汇表校验 —— 认不出的
 *   一律退回 fact / global，调用方不用自己再判一遍（形状只有一处）。
 */
function append(input) {
  const policy = autoWritePolicy()
  if (policy === 'off') {
    return {
      ok: false,
      error:
        '记忆写入被关掉了（设置 → 记忆 → 自动写入 = 关闭）。如果确实想记，让用户在设置里打开。',
    }
  }

  const fromString = typeof input === 'string'
  const result = store.add({
    content: fromString ? input : input?.content,
    /* 模型能说清这是偏好还是约束 —— 类型决定「该不该被遵守」和「会不会取代旧的」 */
    type: fromString ? undefined : input?.type,
    scope: fromString ? undefined : input?.scope,
    /* 会话作用域记忆要绑会话（SEC-065）——空串 = 无会话 = 不注入，由 store 落字段 */
    sessionId: fromString ? undefined : input?.sessionId,
    projectId: fromString ? undefined : input?.projectId,
    /* 工具调用前面已经过一次用户确认（remember 算写操作），所以是「用户已确认」 */
    source: 'user_confirmed',
    confidence: 1,
    importance: 0.7,
  })

  /*
   * ★ P1（2026-11-05）：`deduped` 必须往上传。
   *   以前这里只挑 `ok: true, item, stats` 三样，把 store 那句「这是重复，
   *   我只是把它当成又用了一次」的事实丢了 —— 于是 `remember` 永远回「记下了」，
   *   用户以为新类型/新作用域生效了，其实库里那条一个字都没变。
   */
  return result.ok ? { ok: true, item: result.item, deduped: result.deduped === true, stats: stats() } : result
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
  /*
   * 上一轮注入账（为什么是这几条、每条多少分、分是怎么来的）。
   *
   * ★ 这是**进程内**状态，不落盘：重启后回到 `null`。界面必须能处理 null ——
   *   不能假设「刚启动就有一份账」（自检组 71 钉住了「一条没注入时是结构完整的
   *   空账」和「从没注入过是 null」两种情形）。
   */
  lastInjection: recall.lastInjection,
  /* 单条打分的解释（同一套权重，见 memory-explain.cjs）—— 设置页逐条显示理由要用 */
  explain: explain.explain,
  explainSummary: explain.summarize,
}
