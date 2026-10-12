/**
 * 文件改动事务（ChangeSet）：一次 Agent 运行里改过的文件打包成一个事务 ——
 *   开始 → 记录每个文件改动**之前**的内容 → 运行结束提交 / 验证失败一键回滚。
 * 为什么整批：模型改三个文件做一件事，第二个改错了 —— 只撤第二个会把代码留在更糟的中间态。
 *
 * 存储 `data/changesets/<id>/`：`meta.json`（谁、何时、改了哪些文件）+ `files/0001.snap`（改动前原文）。
 * 限制：文件太大不快照 / 文件数上限 / 新建回滚=删掉、被删回滚=重建。
 * ★ `meta.json` 是**回滚凭据**（用户数据）：写它走原子写、坏了要留档报警 —— 见 readMeta / writeMeta。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { writeAtomic, keepCorruptCopy } = require('./safe-write.cjs')
/* 「撤到某个检查点为止」在单独一个文件里（它惰性 require 本模块，顶层不引用） */
const { rollbackTo } = require('./changeset-rollback.cjs')

function root() {
  return path.join(DIRS.data, 'changesets')
}

function dirFor(id) {
  return path.join(root(), String(id))
}

function metaFile(id) {
  return path.join(dirFor(id), 'meta.json')
}

function settings() {
  try {
    return require('./config.cjs').get().changeset
  } catch {
    return { enabled: true, maxFileBytes: 4 * 1024 * 1024, maxFiles: 200 }
  }
}

function newId() {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** 本进程内已留过档的损坏 meta —— 同一份重复读只留一份，别刷一地副本 */
const corruptKept = new Set()

/*
 * 读 meta。**「文件不在」与「文件坏了」必须分开**（以前一个 catch 压成 null，看不出区别）：
 *   · ENOENT —— 正常（还没建过 / 已被 prune）：返回 null，不报警、不留档；
 *   · 解不开 → 损坏：先 keepCorruptCopy 留档（原件不删、不覆盖）再记一条 error，**绝不静默 null**
 *     —— 否则接下来任意一次写盘会把证据盖掉；同一份本进程只留档一次。
 */
function readMeta(id) {
  const file = metaFile(id)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') log.warn(`读改动事务失败（${id}）：${error?.message ?? error}`)
    return null
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    if (!corruptKept.has(file)) {
      corruptKept.add(file)
      const kept = keepCorruptCopy(file)
      const where = kept ? ` —— 已留档 ${path.basename(kept)}` : ' —— 留档失败'
      log.error(`改动事务 meta 解不开（${id}）${where}：${error?.message ?? error}`)
    }
    return null
  }
}

/*
 * 写 meta —— 走原子写。以前 `fs.writeFileSync(整个文件)` 是「先截断、再写」：写到一半磁盘满 /
 * 断电 / 被杀，回滚凭据就只剩前半截（注入实测：403 字节 meta 在 ENOSPC 后变 25 字节、readMeta
 * 返回 null、事务从列表消失、rollback 报「事务不存在」）。写失败向调用方抛，不吞、不假报成功。
 */
function writeMeta(id, meta) {
  const file = metaFile(id)
  writeAtomic(file, JSON.stringify(meta, null, 2))
  corruptKept.delete(file) // 写成功 → 之前的「已留档」标记作废（再坏一次还会留档）
}

/** 开一个事务：建目录 + 写初始 meta（files 空）。返回 { ok, id } / { ok:false, skipped } */
function begin({ taskId = '', sessionId = '', title = '' } = {}) {
  if (!settings().enabled) return { ok: false, skipped: true }

  const id = newId()
  try {
    fs.mkdirSync(path.join(dirFor(id), 'files'), { recursive: true })
    writeMeta(id, {
      id,
      taskId,
      sessionId,
      title,
      status: 'open',
      startedAt: Date.now(),
      finishedAt: 0,
      files: [],
    })
    return { ok: true, id }
  } catch (error) {
    log.warn(`开改动事务失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, skipped: true }
  }
}

/** 记录文件的「改动前」状态。**必须在写入之前调用** —— 事务的价值全在这一步（before 已读过就传进来，省一次读盘）。 */
function record(id, file, { before } = /** @type {{before?: string|null}} */ ({})) {
  const meta = readMeta(id)
  if (!meta || meta.status !== 'open') return { ok: false, error: '事务不存在或已关闭' }

  const limit = settings()
  const absolute = path.resolve(String(file))

  /* 同一个文件改多次：只留第一次的快照（那才是原始状态） */
  if (meta.files.some((f) => f.path === absolute)) return { ok: true, deduped: true }

  if (meta.files.length >= limit.maxFiles) {
    meta.truncated = true
    writeMeta(id, meta)
    return { ok: false, error: `本次改动超过 ${limit.maxFiles} 个文件，不再记录` }
  }

  let content = before
  let existed = true
  let size = 0

  if (content === undefined) {
    try {
      const stat = fs.statSync(absolute)
      size = stat.size
      if (size > limit.maxFileBytes) {
        meta.files.push({
          path: absolute,
          snapshot: false,
          reason: '文件太大，未快照',
          existed: true,
          size,
        })
        writeMeta(id, meta)
        return { ok: false, error: '文件太大，未做快照' }
      }
      content = fs.readFileSync(absolute, 'utf8')
    } catch {
      /* 文件不存在 = 新建 */
      existed = false
      content = ''
    }
  }

  const index = String(meta.files.length + 1).padStart(4, '0')
  const snapName = `${index}.snap`

  try {
    if (existed) fs.writeFileSync(path.join(dirFor(id), 'files', snapName), content ?? '', 'utf8')
    meta.files.push({
      path: absolute,
      snapshot: existed,
      existed,
      snap: existed ? snapName : '',
      size: (content ?? '').length,
      at: Date.now(),
    })
    writeMeta(id, meta)
    return { ok: true }
  } catch (error) {
    log.warn(`记录文件快照失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, error: '快照写盘失败' }
  }
}

/** 运行结束、验证通过 → 提交（保留快照，用户之后仍可回滚） */
function commit(id, { verified = null } = {}) {
  const meta = readMeta(id)
  if (!meta) return { ok: false, error: '事务不存在' }
  meta.status = 'committed'
  meta.verified = verified
  meta.finishedAt = Date.now()
  writeMeta(id, meta)
  return { ok: true, files: meta.files.length }
}

/** 回滚。三类都要处理：① 改过的 → 写回快照 ② 新建的 → 删掉 ③ 没快照的（太大）→ 明确告诉用户 */
function rollback(id) {
  const meta = readMeta(id)
  if (!meta) return { ok: false, error: '事务不存在' }

  const restored = []
  const removed = []
  const failed = []

  for (const entry of meta.files) {
    try {
      if (!entry.existed) {
        if (fs.existsSync(entry.path)) fs.rmSync(entry.path, { force: true })
        removed.push(entry.path)
        continue
      }

      if (!entry.snapshot || !entry.snap) {
        failed.push({ path: entry.path, reason: entry.reason ?? '没有快照' })
        continue
      }

      const content = fs.readFileSync(path.join(dirFor(id), 'files', entry.snap), 'utf8')
      fs.mkdirSync(path.dirname(entry.path), { recursive: true })
      fs.writeFileSync(entry.path, content, 'utf8')
      restored.push(entry.path)
    } catch (error) {
      failed.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  meta.status = 'rolled-back'
  meta.rolledBackAt = Date.now()
  writeMeta(id, meta)

  log.info(`改动事务回滚：恢复 ${restored.length} 个，删除 ${removed.length} 个，失败 ${failed.length} 个`)
  return { ok: true, restored, removed, failed }
}

/** 盖「被重新生成替代」标记：事务本体不动、不自动回滚，只是让审查面板能看出它是旧一版的 */
function markSuperseded(id, byTaskId = '') {
  const meta = readMeta(id)
  if (!meta) return { ok: false, error: '事务不存在' }
  meta.supersededBy = String(byTaskId)
  meta.supersededAt = Date.now()
  writeMeta(id, meta)
  return { ok: true }
}

/** 列出事务（新的在前） */
function list({ limit = 20, taskId = '', sessionId = '' } = {}) {
  let names = []
  try {
    names = fs.readdirSync(root()).filter((name) => name.startsWith('cs_'))
  } catch {
    return []
  }

  const out = []
  for (const id of names.sort().reverse()) {
    const meta = readMeta(id)
    if (!meta) continue
    if (taskId && meta.taskId !== taskId) continue
    if (sessionId && meta.sessionId !== sessionId) continue
    out.push({
      id: meta.id,
      taskId: meta.taskId,
      sessionId: meta.sessionId,
      title: meta.title,
      status: meta.status,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      fileCount: meta.files.length,
      files: meta.files.map((f) => f.path),
      /* 被重新生成替代了（指向新任务 id；'' = 没被替代） */
      supersededBy: meta.supersededBy ?? '',
    })
    if (out.length >= limit) break
  }
  return out
}

function get(id) {
  const meta = readMeta(id)
  if (!meta) return null
  return { ...meta, files: meta.files.map((f) => ({ path: f.path, existed: f.existed, size: f.size })) }
}

/** 清理旧的（保留最近 N 个） */
function prune(keep = 50) {
  let names = []
  try {
    names = fs.readdirSync(root()).filter((name) => name.startsWith('cs_')).sort()
  } catch {
    return { ok: true, removed: 0 }
  }

  const stale = names.slice(0, Math.max(0, names.length - keep))
  for (const id of stale) {
    try {
      fs.rmSync(dirFor(id), { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
  return { ok: true, removed: stale.length }
}

module.exports = {
  begin, record, commit, rollback, rollbackTo, markSuperseded,
  list, get, readMeta, writeMeta, prune, root,
}
