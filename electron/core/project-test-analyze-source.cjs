/**
 * 分析用的**只读取证**（2026-10-17 · 3B-1）
 *
 * 分析层要说「看这几行源码」，就得真读到它。这个文件只做一件事：
 * 给定项目根 + **相对路径**，安全地读回一小段带行号的片段。
 *
 * ── ★ 五道门（缺一不可）──────────────────────────────────────
 *
 *   ① **相对路径**：拒绝对路径、`..`、NUL —— 判据是 `codex-mcp-policy` 的
 *      `resolveInWorkspace`（**唯一一处**，这里不另写一套）。
 *   ② **realpath 之后再判**：工作区里的软链接 / 目录联接指向外面也拒。
 *   ③ **必须真在项目根之内**：`resolveInWorkspace` 是相对"工作区"判的，
 *      项目根可能是它的子目录，所以还要再收一次。
 *   ④ **大小上限**：单文件 > `MAX_FILE_BYTES` 不读（分析不需要整篇大文件）。
 *   ⑤ **行数上限**：只读报错行附近 `CONTEXT` 行，不是整篇。
 *
 * ── 明确不读什么 ─────────────────────────────────────────────
 *
 *   稳定版数据、`~/.codex`、凭据文件、审计目录 —— 即使它们恰好在项目根里，
 *   也一律拒（`DENY_BASENAMES` + `DENY_SEGMENTS`）。理由是分析没有理由看这些。
 *
 * ⚠️ 不 require electron；除读盘外没有副作用。
 */

const fs = require('node:fs')
const path = require('node:path')
const policy = require('./codex-mcp-policy.cjs')

/** 单文件上限：超过就不读（分析只需看片段） */
const MAX_FILE_BYTES = 512 * 1024
/** 报错行上下各读几行 */
const CONTEXT = 12

/** 文件名黑名单（不看凭据/密钥类） */
const DENY_BASENAMES = new Set([
  'credentials.json',
  'credentials.json.bak',
  '.env',
  '.env.local',
  'config.json',
  'codex-mcp.token',
  'ext-bridge.token',
])

/** 路径段黑名单（不看这些目录里的东西） */
const DENY_SEGMENTS = new Set(['audit', 'audit-logs', '.codex', '.ssh', 'node_modules', '.git'])

/** 是不是被明确拒绝的文件（按 basename 与路径段） */
function denied(rel) {
  const norm = String(rel ?? '').replace(/\\/g, '/')
  const segs = norm.split('/').filter(Boolean)
  if (segs.length === 0) return '路径为空'
  const base = segs[segs.length - 1].toLowerCase()
  if (DENY_BASENAMES.has(base)) return `不读凭据/配置文件：${base}`
  for (const s of segs) {
    if (DENY_SEGMENTS.has(s.toLowerCase())) return `不读这些目录里的内容：${s}`
  }
  return ''
}

/** 文本文件才读（二进制读出来是垃圾，还会污染上下文） */
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return true
  }
  return false
}

/**
 * 读一个文件的片段（带行号），并做安全校验。
 *
 * @param {string} projectRoot 已 realpath 过的项目根
 * @param {unknown} relInput 相对路径（**只接受相对**）
 * @param {{ line?: number, context?: number }} [opts]
 * @returns {{ rel: string, abs?: string, line?: number, snippet?: string, error?: string, totalLines?: number }}
 */
function readSnippet(projectRoot, relInput, opts = {}) {
  const rel = String(relInput ?? '').trim()
  const out = { rel }

  const why = denied(rel)
  if (why) return { ...out, error: why }

  /* ①+② 工作区校验（唯一判据，含 realpath 复检） */
  const resolved = policy.resolveInWorkspace(projectRoot, rel)
  if (resolved.ok === false) return { ...out, error: `${resolved.code}：${resolved.message}` }

  /* ③ 必须真在项目根之内（resolveInWorkspace 是相对工作区判的，这里再收一次） */
  if (!policy.isInside(projectRoot, resolved.abs)) {
    return { ...out, error: '越界：解析后的路径不在项目根之内' }
  }

  let stat
  try {
    stat = fs.statSync(resolved.abs)
  } catch {
    return { ...out, abs: resolved.abs, error: '文件不存在' }
  }
  if (!stat.isFile()) return { ...out, abs: resolved.abs, error: '不是普通文件' }
  if (stat.size > MAX_FILE_BYTES) {
    return { ...out, abs: resolved.abs, error: `文件太大（${Math.round(stat.size / 1024)} KB > ${MAX_FILE_BYTES / 1024} KB），不读` }
  }

  let buf
  try {
    buf = fs.readFileSync(resolved.abs)
  } catch {
    return { ...out, abs: resolved.abs, error: '读不动（权限或占用）' }
  }
  if (looksBinary(buf)) return { ...out, abs: resolved.abs, error: '看起来是二进制文件，不读' }

  const lines = buf.toString('utf8').replace(/\r\n?/g, '\n').split('\n')
  const ctx = Math.max(0, Number(opts.context) || CONTEXT)
  const center = Math.max(1, Number(opts.line) || 1)
  const from = Math.max(1, center - ctx)
  const to = Math.min(lines.length, center + ctx)
  const snippet = lines
    .slice(from - 1, to)
    .map((text, i) => `${String(from + i).padStart(5)} | ${text}`)
    .join('\n')

  return { rel, abs: resolved.abs, line: center, snippet, totalLines: lines.length }
}

/**
 * 批量取证（每个文件独立判，失败的带 error 回来，不整体失败）。
 *
 * @param {string} projectRoot
 * @param {Array<string|{rel?:string,line?:number}>} list
 * @returns {Array<object>}
 */
function readMany(projectRoot, list) {
  const out = []
  const max = 6
  for (const one of Array.isArray(list) ? list.slice(0, max) : []) {
    const rel = typeof one === 'string' ? one : String(one?.rel ?? '')
    const line = typeof one === 'string' ? 0 : Number(one?.line) || 0
    out.push(readSnippet(projectRoot, rel, { line }))
  }
  return out
}

module.exports = { MAX_FILE_BYTES, CONTEXT, DENY_BASENAMES, DENY_SEGMENTS, denied, readSnippet, readMany }
