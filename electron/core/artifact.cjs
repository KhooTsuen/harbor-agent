/**
 * 成果（Artifact）—— 落盘 + 版本历史
 *
 * 「成果」= 模型给出来、用户想留住的东西（回答里的一段代码块 / 一份报告 /
 * 模型真写进磁盘的文件）。之前它只是聊天记录的副产品：`extractArtifacts` 抓个文件名，
 * 关掉会话就没了、**没有历史** —— 同一份文件改了三版，你只能看到最后一版。
 *
 * 存储：`data/artifacts/<id>/` → `meta.json`（元信息 + 版本清单，**不含正文**）
 *                            + `v1.md` / `v2.md`（每版正文一个文件）
 * 正文外置的理由：一份报告可能几十 KB，内联进 meta 的话「列个清单」就要把所有
 * 历史正文读进内存 —— 和会话列表「只读第一行」是同一个道理（session-read.cjs）。
 *
 * 三条规矩：**append-only**（每变一次追加一版，不原地改）；同一 (任务/会话, name, path)
 * 视为同一个成果的新版本；内容没变则不新增版本（免得模型重复贴同一段就多一版）。
 *
 * ★ 边界：**不与 changeset 抢活** —— 「改了磁盘上哪些文件、怎么整批撤」归 changeset.cjs，
 *   「这份成果长什么样、改过几版」归本文件。这里**不做** diff / 合并（那是别人的事）。
 *
 * 刻意不 require('electron')，自检能直接跑。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DIRS } = require('./paths.cjs')
const log = require('./log.cjs')
const { redact } = require('./redact.cjs')

/** 与 `ArtifactRecord['type']` 一字不差 —— 内核落什么，界面就画什么 */
const TYPES = ['document', 'code', 'patch', 'report', 'generated_file']

/** 上限：成果不能把磁盘吃光（和 backup.cjs 的 KEEP、日志 6MB 轮转一个思路） */
const DEFAULTS = { maxVersions: 50, maxBytes: 2 * 1024 * 1024 }

function root() {
  return path.join(DIRS.data, 'artifacts')
}

/**
 * id 只允许 `art_[a-z0-9]+`（newId 就生成这个样子）。
 * 为什么要卡：id 是从渲染层传进来的，不卡的话 `remove('../../sessions')`
 * 就能删到别处去 —— 这个项目对「路径能到哪」是有规矩的。
 */
function safeId(id) {
  const text = String(id ?? '').trim()
  return /^art_[a-z0-9]+$/.test(text) ? text : ''
}

function dirFor(id) {
  const safe = safeId(id)
  return safe ? path.join(root(), safe) : ''
}

function metaFile(id) {
  const dir = dirFor(id)
  /* dirFor 对不合法的 id 返回空串 —— 这里必须跟着返回空串，
     否则 path.join('', 'meta.json') 会变成**相对 cwd** 的路径，读到不该读的文件 */
  return dir ? path.join(dir, 'meta.json') : ''
}

function versionFile(id, version) {
  const dir = dirFor(id)
  const n = Number(version)
  if (!dir || !Number.isInteger(n) || n < 1) return ''
  return path.join(dir, `v${n}.md`)
}

function newId() {
  return `art_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function settings() {
  try {
    const section = require('./config.cjs').get()?.artifact
    const maxVersions = Number(section?.maxVersions)
    const maxBytes = Number(section?.maxBytes)
    return {
      maxVersions: maxVersions > 0 ? Math.floor(maxVersions) : DEFAULTS.maxVersions,
      maxBytes: maxBytes > 0 ? Math.floor(maxBytes) : DEFAULTS.maxBytes,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function readMeta(id) {
  const file = metaFile(id)
  if (!file) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeMeta(id, meta) {
  fs.writeFileSync(metaFile(id), JSON.stringify(meta, null, 2), 'utf8')
}

/** 目录里现有的成果 id（新的不一定在前面，读的一侧自己按 updatedAt 排） */
function ids() {
  try {
    return fs.readdirSync(root()).filter((name) => safeId(name))
  } catch {
    return []
  }
}

/**
 * 「同一个成果」的判断键：**范围 + 路径 + 名字**。不带范围的话，两个不同任务里的
 * `README.md` 会被并成同一个成果、版本互相覆盖。范围优先 taskId，其次 sessionId。
 */
function keyOf(item) {
  const scope = String(item.taskId ?? '') || String(item.sessionId ?? '') || ''
  return `${scope}\u0000${String(item.path ?? '').trim()}\u0000${String(item.name ?? '').trim()}`
}

/** 同名的那个成果（内容变了就给它加版本） */
function findExisting(input) {
  const want = keyOf(input)
  let best = null
  for (const id of ids()) {
    const meta = readMeta(id)
    if (!meta || keyOf(meta) !== want) continue
    if (!best || Number(meta.updatedAt) > Number(best.updatedAt)) best = meta
  }
  return best
}

function readVersion(id, version) {
  const file = versionFile(id, version)
  if (!file) return null
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** meta → 对外的形状（`ArtifactRecord`），**不带正文** */
function record(meta, version) {
  return {
    id: meta.id,
    type: meta.type,
    name: meta.name,
    path: meta.path || undefined,
    version,
    threadId: meta.threadId || undefined,
    taskId: meta.taskId || undefined,
    sourceMessageId: meta.sourceMessageId || undefined,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    versions: (meta.versions ?? []).map((v) => ({
      version: v.version,
      bytes: v.bytes,
      createdAt: v.createdAt,
    })),
  }
}

/** 追加一版：写正文文件 + 记进清单 + 超上限丢最旧的 */
function pushVersion(meta, text, at) {
  const version = Number(meta.versions[meta.versions.length - 1]?.version ?? 0) + 1
  fs.writeFileSync(versionFile(meta.id, version), text, 'utf8')
  meta.versions.push({ version, bytes: Buffer.byteLength(text, 'utf8'), createdAt: at })
  meta.latest = version
  meta.updatedAt = at

  const limit = settings().maxVersions
  while (meta.versions.length > limit) {
    const dropped = meta.versions.shift()
    const file = versionFile(meta.id, dropped.version)
    try {
      if (file) fs.rmSync(file, { force: true })
    } catch {
      /* 忽略：旧的正文文件删不掉也不该让这次保存失败 */
    }
  }
  return version
}

/**
 * 存一个成果。
 *
 * 同名（同范围同路径）多次调用 = 同一个成果的新版本；内容没变则不新增版本。
 *
 * @param {{ taskId?: string, sessionId?: string, threadId?: string, sourceMessageId?: string,
 *           name: string, type?: string, content?: string, path?: string }} draft
 * @returns {{ ok: boolean, artifact?: object, deduped?: boolean, error?: string }}
 */
function save(draft = {}) {
  const name = String(draft.name ?? '').trim()
  if (!name) return { ok: false, error: '成果必须有名字' }

  const target = String(draft.path ?? '').trim()
  const limit = settings()

  /* 正文也过脱敏：模型贴出来的东西里**可能带密钥**（安全模型那条规矩） */
  const text = redact(String(draft.content ?? ''))
  if (Buffer.byteLength(text, 'utf8') > limit.maxBytes) {
    return { ok: false, error: `内容超过 ${Math.round(limit.maxBytes / 1024)}KB，未保存` }
  }

  const input = {
    name,
    path: target,
    taskId: String(draft.taskId ?? ''),
    sessionId: String(draft.sessionId ?? ''),
    threadId: String(draft.threadId ?? ''),
    sourceMessageId: String(draft.sourceMessageId ?? ''),
    type: TYPES.includes(draft.type) ? draft.type : target ? 'generated_file' : 'code',
  }

  try {
    const existing = findExisting(input)
    if (existing) {
      if (readVersion(existing.id, existing.latest) === text) {
        return { ok: true, artifact: { ...record(existing, existing.latest), content: text }, deduped: true }
      }
      const version = pushVersion(existing, text, Date.now())
      writeMeta(existing.id, existing)
      return { ok: true, artifact: { ...record(existing, version), content: text } }
    }

    const id = newId()
    const now = Date.now()
    const meta = { schemaVersion: 1, ...input, id, createdAt: now, updatedAt: now, latest: 1, versions: [] }
    fs.mkdirSync(dirFor(id), { recursive: true })
    pushVersion(meta, text, now)
    writeMeta(id, meta)
    log.info(`成果落盘：${name} → ${id}`)
    return { ok: true, artifact: { ...record(meta, meta.latest), content: text } }
  } catch (error) {
    log.warn(`成果落盘失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, error: '成果写盘失败' }
  }
}

/**
 * 列成果（新的在前）。**不含正文** —— 列清单不该把历史正文全读回内存。
 *
 * @param {{ taskId?: string, sessionId?: string, limit?: number }} [options]
 */
function list({ taskId = '', sessionId = '', limit = 200 } = {}) {
  const out = []
  for (const id of ids()) {
    const meta = readMeta(id)
    if (!meta) continue
    if (taskId && meta.taskId !== taskId) continue
    if (sessionId && meta.sessionId !== sessionId) continue
    out.push(record(meta, meta.latest))
  }
  out.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
  return out.slice(0, Math.max(1, Number(limit) || 200))
}

/**
 * 取一个成果（正文按版本取，默认最新版）。
 *
 * @param {string} id
 * @param {number} [version] 省略 = 最新版
 * @returns {{ ok: boolean, artifact?: object, content?: string, error?: string }}
 */
function get(id, version) {
  const meta = readMeta(id)
  if (!meta) return { ok: false, error: '成果不存在' }

  const wanted =
    version === undefined || version === null || version === ''
      ? Number(meta.latest)
      : Number(version)
  if (!Number.isInteger(wanted) || wanted < 1) return { ok: false, error: '版本号必须是正整数' }

  const entry = (meta.versions ?? []).find((v) => v.version === wanted)
  if (!entry) {
    const oldest = meta.versions?.[0]?.version ?? 0
    return { ok: false, error: `没有第 ${wanted} 版（现有 ${oldest}..${meta.latest}）` }
  }

  const content = readVersion(id, wanted)
  if (content === null) return { ok: false, error: `第 ${wanted} 版的正文读不出来` }
  return { ok: true, artifact: { ...record(meta, wanted), content }, content }
}

/** 删成果 = 删目录（sessionCore.remove 就是这么干的） */
function remove(id) {
  const safe = safeId(id)
  if (!safe) return { ok: false, error: '成果 id 不合法' }
  if (!fs.existsSync(dirFor(safe))) return { ok: false, error: '成果不存在' }
  try {
    fs.rmSync(dirFor(safe), { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    log.warn(`删除成果失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, error: '删除失败' }
  }
}

module.exports = { save, list, get, remove, readMeta, root, dirFor, versionFile, TYPES }
