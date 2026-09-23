/**
 * 项目注册表（一等实体）
 *
 * ── 为什么要有它 ──
 *
 * 「项目」以前**不是实体，是从会话的 workdir 现推出来的**：id = `dir:<workdir>`，
 * 每次读盘全量重建。于是三件事都不成立：
 *   · 侧栏的「新建 / 重命名 / 置顶 / 归档」在真机上是**纯内存操作**（不落盘），
 *     点完看着有反应，重启就没了；
 *   · 名字 = 目录最后一段，改不了；
 *   · 换盘符 / 移动目录 = 变成「另一个项目」，而 `memory` 里 `scope:'project'`
 *     的条目是挂 id 的 —— 会**静默失配**。
 *
 * ── id 为什么还是 `dir:<workdir>` ──
 *
 * 升级不该让用户看见任何变化：老数据里没有 `projectId`，只有 `workdir`。
 * 沿用同一套 id（`dirIdFor`，与前端 `folderIdFor` 逐字一致）有两个好处：
 *   ① 老会话推导出来的归属**和升级前一模一样**；
 *   ② 已有的项目级记忆挂的 id 不变，**不会失配**。
 * 用户自己新建的项目才用 `proj_xxx`。
 *
 * 改名的项目 **id 不变**（只改 `name`）—— 这正是比「id 跟着路径走」更稳的地方。
 *
 * ── 迁移 = 建登记项，**不重写任何会话文件** ──
 *
 * `ensureMigrated()` 只扫一遍会话的 workdir，给每个目录补一条登记项。
 * 会话文件一个字节都不动 —— 大规模重写聊天记录的风险远大于收益，
 * 而旧会话的 `projectId` 在读取时按 workdir 推导（见 session.cjs），结果完全一致。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
/* 路径 / 命名规范（含 `dirIdFor`）拆在 project-paths.cjs —— 这里只管注册表语义 */
const { dirIdFor, canon, nameOf, newProjectId } = require('./project-paths.cjs')

const VERSION = 1
const NAME_MAX = 60

function filePath() {
  return testPath || path.join(DIRS.data, 'projects.json')
}

/**
 * 自检用：把登记表指到沙箱去（传空串还原）。
 *
 * 名字带 `set…ForTest` 是故意的 —— 生产代码里出现这个调用就是可疑的，
 * 一眼能看出来（同一个约定见 `schedule-store.cjs`）。
 */
let testPath = ''
function setFilePathForTest(target) {
  testPath = String(target ?? '')
  return filePath()
}

function empty() {
  return { version: VERSION, activeId: '', items: [] }
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    if (parsed?.version !== VERSION || !Array.isArray(parsed.items)) return empty()
    return {
      version: VERSION,
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : '',
      items: parsed.items.filter((i) => i && typeof i.id === 'string'),
    }
  } catch {
    /* 没文件 / 读坏：当成「还没迁移」，ensureMigrated 会补出来 */
    return empty()
  }
}

/** 原子写：先写临时文件再 rename —— 登记表被写坏等于用户的项目全没了 */
function persist(data) {
  fs.mkdirSync(DIRS.data, { recursive: true })
  const tmp = `${filePath()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, filePath())
}

/* ── 读 ──────────────────────────────────────────────────── */

function list({ includeArchived = true } = {}) {
  const items = load().items
  const filtered = includeArchived ? items : items.filter((i) => !i.archived)
  return filtered.sort((a, b) => {
    /* 置顶的在最前，其余按最近动过 */
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
}

function get(id) {
  return load().items.find((i) => i.id === id) ?? null
}

function activeId() {
  return load().activeId
}

function active() {
  const data = load()
  return data.items.find((i) => i.id === data.activeId) ?? null
}

/** 按 root 找（比较时规范化，避免大小写/尾斜杠导致两条重复登记） */
function findByRoot(workdir) {
  const target = canon(workdir)
  if (!target) return null
  return load().items.find((i) => canon(i.root) === target) ?? null
}

/* ── 写 ──────────────────────────────────────────────────── */

/**
 * 自动登记项（跟着目录来的）。`ensureFor` / `ensureMigrated` 都要用。
 *
 * 抽成一个而不是各写一遍：字段少一个（比如漏了 `auto`）不会报错，
 * 只会在别处表现为「这条项目删不掉 / 名字被重置」，很难查。
 */
function autoItem(dir, now) {
  return {
    id: dirIdFor(dir),
    name: nameOf(dir),
    description: '',
    root: dir,
    branch: 'main',
    icon: '',
    color: '',
    pinned: false,
    archived: false,
    /** 自动登记（跟着目录来的）还是用户手建的 */
    auto: true,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 保证某个 workdir 有登记项，返回它（这就是「沿用老行为」的那条路）。
 *
 * 已存在就**原样返回**，不覆盖用户改过的名字/颜色 —— 这一点很关键：
 * 每次新建会话都会调它，若它顺手把 name 重置成目录名，用户改名就白改了。
 */
function ensureFor(workdir) {
  const dir = String(workdir ?? '').trim()
  if (!dir) return null

  const data = load()
  const existing = data.items.find((i) => canon(i.root) === canon(dir))
  if (existing) return existing

  const item = autoItem(dir, Date.now())
  data.items.push(item)
  if (!data.activeId) data.activeId = item.id
  persist(data)
  log.info(`项目登记：${item.name}（${dir}）`)
  return item
}

/** 用户手建的项目。id 用 proj_xxx —— 与目录无关，所以改名/移动都不影响它 */
function create({ name = '', root = '' } = {}) {
  const clean = String(name).trim()
  if (!clean) return { ok: false, error: '项目名不能为空' }
  if (clean.length > NAME_MAX) return { ok: false, error: `项目名最多 ${NAME_MAX} 个字` }

  const data = load()
  const now = Date.now()
  const item = {
    id: newProjectId(now),
    name: clean,
    description: '',
    root: String(root ?? '').trim(),
    branch: 'main',
    icon: '',
    color: '',
    pinned: false,
    archived: false,
    auto: false,
    createdAt: now,
    updatedAt: now,
  }
  data.items.push(item)
  persist(data)
  log.info(`新建项目：${item.name}`)
  return { ok: true, item }
}

/** 允许改的字段白名单 —— 别让调用方顺手把 id / auto 改了 */
function update(id, patch = {}) {
  const data = load()
  const item = data.items.find((i) => i.id === id)
  if (!item) return { ok: false, error: '项目不存在' }

  if (typeof patch.name === 'string' && patch.name.trim()) {
    item.name = patch.name.trim().slice(0, NAME_MAX)
  }
  if (typeof patch.root === 'string') {
    /* ⚠️ 改 root **不动 id**：老会话 / 项目级记忆挂的是 id，动 id 等于把它们孤立 */
    item.root = patch.root.trim()
  }
  for (const key of ['description', 'branch', 'icon', 'color']) {
    if (typeof patch[key] === 'string') item[key] = patch[key]
  }
  for (const key of ['pinned', 'archived']) {
    if (typeof patch[key] === 'boolean') item[key] = patch[key]
  }
  item.updatedAt = Date.now()
  persist(data)
  return { ok: true, item }
}

/**
 * 移除登记项。
 *
 * ⚠️ **只删登记，不删会话和任务** —— 那些是用户的东西。
 * 归属它的会话之后会显示在「未归类」下；如果那个目录又有新会话，
 * `ensureFor` 会把登记项重新建出来（沿用老行为：目录在，项目就在）。
 */
function remove(id) {
  const data = load()
  const before = data.items.length
  data.items = data.items.filter((i) => i.id !== id)
  if (data.items.length === before) return { ok: false, error: '项目不存在' }
  if (data.activeId === id) data.activeId = data.items[0]?.id ?? ''
  persist(data)
  log.info(`移除项目登记 ${id}（会话与任务保留）`)
  return { ok: true, localOnly: true }
}

function setActive(id) {
  const data = load()
  if (id && !data.items.some((i) => i.id === id)) return { ok: false, error: '项目不存在' }
  data.activeId = String(id ?? '')
  persist(data)
  return { ok: true, activeId: data.activeId }
}

/**
 * 迁移：扫一遍会话的 workdir，给每个目录补一条登记项。
 *
 * **不重写任何会话文件**（见文件头注释）。幂等：跑第二遍 `created` 是 0。
 * 老会话没有 `projectId`，读取时按 workdir 推导，所以这里只要保证「登记项在」。
 */
function ensureMigrated() {
  const data = load()
  const before = data.items.length

  let workdirs = []
  try {
    const session = require('./session.cjs')
    workdirs = session
      .list()
      .map((s) => String(s.workdir ?? '').trim())
      .filter(Boolean)
  } catch (error) {
    /* 读会话失败不该让整个启动挂掉 —— 但没有项目可登记，如实说 */
    log.warn(`扫描会话工作目录失败，项目登记可能不全：${error instanceof Error ? error.message : error}`)
    return { ok: false, created: 0, error: '读会话失败' }
  }

  const known = new Set(data.items.map((i) => canon(i.root)))
  let created = 0
  for (const dir of new Set(workdirs.map(canon))) {
    if (known.has(dir)) continue
    const original = workdirs.find((w) => canon(w) === dir) ?? dir
    data.items.push(autoItem(original, Date.now()))
    created += 1
  }

  if (!data.activeId && data.items.length > 0) data.activeId = data.items[0].id
  if (created > 0 || data.items.length !== before) persist(data)
  if (created > 0) log.info(`项目登记：从会话补出 ${created} 个项目`)
  return { ok: true, created, total: data.items.length }
}

module.exports = {
  VERSION,
  NAME_MAX,
  dirIdFor,
  canon,
  list,
  get,
  active,
  activeId,
  findByRoot,
  ensureFor,
  ensureMigrated,
  create,
  update,
  remove,
  setActive,
  filePath,
  setFilePathForTest,
}
