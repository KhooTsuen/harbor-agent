/**
 * 项目测试修复的**文件级恢复点**（2026-10-17 · 3B-3）
 *
 * 「自动改了代码 → 发现改错了 → 要能精确退回去」：只动那一次改过的文件，
 * 不整目录覆盖，不用 git reset/clean。
 *
 * ★ 四条判据（顺序不可换）：
 *   ① **每次真实写入一个独立恢复点**（`<executionId>__a<尝试序号>`）—— 原来只按 executionId
 *      命名，第 2 次会覆盖第 1 次的点，用户退不回原始。
 *   ② 当前 hash === 写入后的 hash → 安全写回原内容；③ === 写入前 → 如实说「本就已恢复」
 *   ④ 都不是 → **拒绝覆盖**（回退会抹掉别人的改动）
 *
 * ★ 存「原内容 + 两个 hash + 写根 root」：root 是必需的安全字段 —— 恢复时要用它把
 *   abs 验回工作区内（恢复点文件同机别的进程能改，不验就开了往任意路径写文本的通道）。
 *   原内容不脱敏（脱敏就恢复不出原样），所以只落 data/project-test-restores/（0600）、
 *   过期 14 天自动清、绝不外传、绝不进审计正文。⚠️ 不 require electron。
 */

const fs = require('node:fs')
const path = require('node:path')
const { hashOf } = require('./codex-mcp-edit-rules.cjs')

/** 最多留几个恢复点（环形裁剪，别把磁盘吃光） */
const MAX_POINTS = 50
/** 恢复点最多留几天（超过就清掉 —— 老现场没人会回去退，留着只是敏感数据堆积） */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
/** 单个文件原内容最多存多少字符（超过就不存内容，只标记不可恢复） */
const MAX_KEEP_CHARS = 2 * 1024 * 1024
/** 一个恢复点里最多几个条目（本流程只放 1 个；上限防畸形文件撑爆恢复循环） */
const MAX_ENTRIES = 8
/**
 * 恢复点文件权限：**只有当前用户可读写**（0600）。
 * ★ 恢复点里存的是**未脱敏的源码原文** —— 脱敏就恢复不出原样，所以只能在
 *   权限这一侧收紧。Windows 上 mode 对文件不起作用，靠的是「落在用户自己的
 *   data/ 目录下」；POSIX 上这条是实打实生效的。
 */
const FILE_MODE = 0o600

/** 恢复点目录（**惰性**取 DIRS：模块加载时 paths 可能还没初始化） */
function dir() {
  const { DIRS } = require('./paths.cjs')
  return path.join(DIRS.data, 'project-test-restores')
}

/** 只接受安全形状的 id（会拼进文件名） */
function safeId(id) {
  const s = String(id ?? '')
  return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : ''
}

/**
 * 恢复点的文件名主干：`<executionId>__a<尝试序号>`。
 * 序号缺失/非法 → 退回纯 executionId（兼容 3B 早期写下的点）。空串 = 形状不合法。
 */
function pointId(executionId, attemptNo) {
  const base = safeId(executionId)
  if (!base) return ''
  const n = Number(attemptNo)
  const seq = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  return seq > 0 ? `${base}__a${seq}` : base
}

/** 读文件；读不到返回 null（不存在 ≠ 出错） */
function readIfExists(abs) {
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** 记一条「写入前」的现场（root 必填 —— 恢复时要靠它把 abs 验回工作区内） */
function capture({ abs, rel, root, before, after }) {
  const b = String(before ?? '')
  return {
    rel: String(rel ?? ''),
    abs: String(abs ?? ''),
    /* 恢复时要靠它把 abs 验回工作区内 —— 没它的一律拒绝恢复 */
    root: String(root ?? ''),
    before: b.length > MAX_KEEP_CHARS ? '' : b,
    beforeHash: hashOf(b),
    afterHash: hashOf(String(after ?? '')),
    restorable: b.length <= MAX_KEEP_CHARS,
  }
}

/** 把一个恢复点落盘。**同名不覆盖** —— 逼调用方用 pointId(executionId, attemptNo) 给唯一名字 */
function savePoint(executionId, entries, extra = {}) {
  const id = pointId(executionId, extra.attemptNo)
  if (!id) return { ok: false, message: 'executionId 形状不合法（只允许 [A-Za-z0-9_-]，≤80 字符）' }
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return { ok: false, message: '没有可记录的条目' }
  if (list.length > MAX_ENTRIES) return { ok: false, message: `一个恢复点最多 ${MAX_ENTRIES} 个条目` }

  const file = path.join(dir(), `${id}.json`)
  /* ★ 已存在就**不覆盖**（那是另一轮写入的现场，覆盖掉就再也退不回去） */
  if (fs.existsSync(file)) {
    return { ok: false, message: `恢复点 ${id} 已存在 —— 拒绝覆盖（每次写入必须用独立的尝试序号）`, id }
  }

  const point = { executionId: safeId(executionId), pointId: id, at: Number(extra.at) || Date.now(), entries: list, ...extra, id }
  try {
    fs.mkdirSync(dir(), { recursive: true })
    /* 0600：恢复点里是未脱敏的源码原文，只给当前用户读写 */
    fs.writeFileSync(file, `${JSON.stringify(point)}\n`, { encoding: 'utf8', mode: FILE_MODE })
    prune()
    return { ok: true, point, id }
  } catch (error) {
    return { ok: false, message: `恢复点写入失败：${String((error && error.message) || error)}`, id }
  }
}

/**
 * 裁剪：先按**年龄**清过期（14 天），再按**数量**留最近 MAX_POINTS 个。
 * ★ 年龄优先：一次批量操作可能瞬间写出几十个点，只按数量裁会把更早但更近的挤掉。
 */
function prune() {
  try {
    const now = Date.now()
    const files = fs
      .readdirSync(dir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, at: readPointAt(path.join(dir(), f)) }))
    const alive = files.filter((x) => x.at > 0 && now - x.at <= MAX_AGE_MS)
    const expired = files.filter((x) => !alive.includes(x))
    const sorted = alive.sort((a, b) => b.at - a.at)
    for (const old of [...expired, ...sorted.slice(MAX_POINTS)]) {
      try {
        fs.unlinkSync(path.join(dir(), old.f))
      } catch {
        /* 删不掉就算了 */
      }
    }
  } catch {
    /* 目录还不在 —— 正常 */
  }
}

/** 读一个恢复点的时间戳（裁剪排序用） */
function readPointAt(file) {
  try {
    return Number(JSON.parse(fs.readFileSync(file, 'utf8')).at) || 0
  } catch {
    return 0
  }
}

/** 按文件名主干读一个恢复点；没有返回 null */
function loadById(id) {
  const one = safeId(id) || String(id ?? '')
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(one)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir(), `${one}.json`), 'utf8'))
    return raw && Array.isArray(raw.entries) ? raw : null
  } catch {
    return null
  }
}

/** 按 executionId 读恢复点：返回**最新的那一个**（兼容老调用） */
function loadPoint(executionId) {
  const all = loadAllPoints(executionId)
  return all.length > 0 ? all[all.length - 1] : null
}

/**
 * 某次失败下的**全部**恢复点，按尝试序号升序（第 1 次在前）。
 * 恢复时按这个顺序从最新往回退，才能一路退回原始状态。
 */
function loadAllPoints(executionId) {
  const base = safeId(executionId)
  if (!base) return []
  try {
    return fs
      .readdirSync(dir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => loadById(f.replace(/\.json$/, '')))
      .filter((p) => p && String(p.executionId) === base)
      .sort((a, b) => Number(a.attemptNo ?? 0) - Number(b.attemptNo ?? 0) || Number(a.at) - Number(b.at))
  } catch {
    return []
  }
}

/**
 * 最近的几个恢复点（给「要不要恢复」的界面/诊断用）。
 * @param {number} [limit]
 */
function listPoints(limit = 10) {
  try {
    return fs
      .readdirSync(dir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const p = loadById(f.replace(/\.json$/, ''))
        return p
          ? {
              executionId: p.executionId,
              pointId: p.pointId ?? p.id ?? '',
              attemptNo: Number(p.attemptNo ?? 0),
              at: p.at,
              files: p.entries.map((e) => e.rel),
            }
          : null
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, limit))
  } catch {
    return []
  }
}

/**
 * 恢复点里的绝对路径是否仍落在它自己的写根内。
 * ★ **唯一一处**恢复侧路径校验：abs 来自磁盘上的 JSON，同机别的进程能改它。
 * ★ 3C-2 再加一道：那个写根**现在**仍必须是用户授权的项目根（`project-roots.cjs`）。
 *   否则「先授权写一次 → 用户把条目删了 → 恢复仍然能写进去」，授权就形同虚设。
 */
function pathAllowed(entry, isInside, granted) {
  const abs = String(entry?.abs ?? '')
  const root = String(entry?.root ?? '')
  if (!abs) return { ok: false, message: '条目里没有绝对路径' }
  if (!root) return { ok: false, message: '恢复点里没有记录写根 —— 拒绝恢复（无法确认目标是否在工作区内）' }
  try {
    if (!isInside(root, abs)) return { ok: false, message: '目标路径不在记录的工作区内 —— 拒绝恢复' }
  } catch {
    return { ok: false, message: '路径校验失败 —— 拒绝恢复' }
  }
  if (granted && granted.ok === false) {
    return { ok: false, message: `写根已不再被授权 —— 拒绝恢复（${granted.message}）` }
  }
  return { ok: true }
}

/**
 * 精确恢复一个恢复点。`pointId` 缺省时用最新的那一个（兼容只有 executionId 的调用）。
 */
function restorePoint(input = {}) {
  const wanted = String(input.pointId ?? '').trim()
  const point = wanted ? loadById(wanted) : loadPoint(input.executionId)
  if (!point) return { ok: false, code: 'NO_POINT', message: '没有这个恢复点（id 不对，或已被裁剪）', results: [] }

  const policy = require('./codex-mcp-policy.cjs')
  const roots = require('./project-roots.cjs')
  /* 授权清单的**来源**可以注入（自检用）；判据仍只有 project-roots 一处。
     真实调用（工具层）不传，走当前配置 —— 用户删掉条目后恢复立刻失效。 */
  const items = Array.isArray(input.items) ? input.items : require('./project-tests.cjs').load().items
  const isoDir = String(input.isoDir ?? '') || require('./paths.cjs').DIRS.data
  const results = []
  for (const e of point.entries) {
    const rel = String(e.rel ?? '')
    /* 恢复 = 写入：既要它自己的写根仍包含 abs，也要那个写根**现在**仍被授权写 */
    const granted = roots.resolveAuthorizedRoot({ root: String(e.root ?? ''), items, isoDir, action: 'restore' })
    const allowed = pathAllowed(e, policy.isInside, granted)
    if (!allowed.ok) {
      results.push({ rel, action: 'rejected', message: allowed.message })
      continue
    }
    if (e.restorable === false) {
      results.push({ rel, action: 'skipped', message: '原内容太大未保存，无法恢复' })
      continue
    }
    const abs = String(e.abs)
    const now = readIfExists(abs)
    if (now === null) {
      results.push({ rel, action: 'conflict', message: '文件已不存在，拒绝凭空重建' })
      continue
    }
    const nowHash = hashOf(now)
    if (nowHash === e.afterHash) {
      try {
        fs.writeFileSync(abs, e.before, 'utf8')
        results.push({ rel, action: 'restored', message: '已写回修复前的内容' })
      } catch (error) {
        results.push({ rel, action: 'failed', message: `写回失败：${String((error && error.message) || error)}` })
      }
    } else if (nowHash === e.beforeHash) {
      results.push({ rel, action: 'already', message: '当前已是修复前的内容，未做改动' })
    } else {
      results.push({ rel, action: 'conflict', message: '文件在这次修复之后又被改动过 —— 拒绝覆盖（回退会抹掉别人的改动）' })
    }
  }

  const bad = results.filter((r) => r.action === 'conflict' || r.action === 'failed' || r.action === 'rejected')
  return {
    ok: bad.length === 0,
    code: bad.length === 0 ? 'OK' : 'PARTIAL_CONFLICT',
    message: bad.length === 0 ? '恢复完成' : `有 ${bad.length} 个文件未能恢复（见明细）`,
    pointId: String(point.pointId ?? point.id ?? ''),
    results,
  }
}

module.exports = {
  MAX_POINTS, MAX_KEEP_CHARS, MAX_ENTRIES, dir,
  capture, pointId, savePoint, loadById, loadPoint,
  loadAllPoints, listPoints, pathAllowed, restorePoint, safeId,
}
