/**
 * 文件改动事务（ChangeSet）
 *
 * 一次 Agent 运行里改过的文件打包成一个事务：
 *
 *   开始 → 记录每个文件改动**之前**的内容 → 运行结束提交
 *                                        ↘ 验证失败 → 一键回滚
 *
 * 为什么整批：模型改三个文件做一件事，第二个改错了 —— 只撤第二个会把代码留在更糟的中间态。
 *
 * 存储：`data/changesets/<id>/`
 *   meta.json          谁、什么时候、改了哪些文件
 *   files/0001.snap    改动前的内容（原文）
 *
 * 三个限制：文件太大不快照（maxFileBytes）/ 文件数上限（maxFiles）/ 新建的回滚=删掉、被删的回滚=重建
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
/* 「撤到某个检查点为止」在单独一个文件里（它惰性 require 本模块，顶层不引用） */
const { rollbackTo } = require('./changeset-rollback.cjs')

function root() {
  return path.join(DIRS.data, 'changesets')
}

function dirFor(id) {
  return path.join(root(), String(id))
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

/**
 * 开一个事务。
 *
 * @param {{ taskId?: string, sessionId?: string, title?: string }} options
 * @returns {{ ok: boolean, id?: string, skipped?: boolean }}
 */
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

function metaFile(id) {
  return path.join(dirFor(id), 'meta.json')
}

function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(id), 'utf8'))
  } catch {
    return null
  }
}

function writeMeta(id, meta) {
  fs.writeFileSync(metaFile(id), JSON.stringify(meta, null, 2), 'utf8')
}

/**
 * 记录一个文件的「改动前」状态。
 *
 * **必须在写入之前调用** —— 事务的价值全在这一步。
 *
 * @param {string} id
 * @param {string} file 绝对路径
 * @param {{ before?: string|null }} [options] 已读过的话直接传进来，省一次读盘
 */
function record(id, file, { before } = {}) {
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

/**
 * 回滚。三类都要处理：
 * ① 改过的 → 写回快照 ② 新建的 → 删掉 ③ 没快照的（太大）→ 明确告诉用户
 */
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
      failed.push({
        path: entry.path,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  meta.status = 'rolled-back'
  meta.rolledBackAt = Date.now()
  writeMeta(id, meta)

  log.info(
    `改动事务回滚：恢复 ${restored.length} 个，删除 ${removed.length} 个，失败 ${failed.length} 个`,
  )
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
  return {
    ...meta,
    files: meta.files.map((f) => ({ path: f.path, existed: f.existed, size: f.size })),
  }
}

/** 清理旧的（保留最近 N 个） */
function prune(keep = 50) {
  let names = []
  try {
    names = fs
      .readdirSync(root())
      .filter((name) => name.startsWith('cs_'))
      .sort()
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
