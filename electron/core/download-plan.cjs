/**
 * 下载的**纯函数部分**：探测、切段、目录、断点元数据、清临时文件。
 *
 * 从 `download-engine.cjs` 抽出来的（那边 309 行贴着 300 红线，第 10 项
 * 加 Content-Range 校验时必然破线）。切法按「能不能不起网络/不改状态就测」：
 * 这一层除了 `probeUrl` 都是纯函数；`download-engine` 只管流程与落盘。
 *
 * ⚠️ `download-engine.cjs` **原样再导出**这些名字（自检与安全套件都从那边拿），
 * 所以调用方一行都不用改。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 默认几条连接（会被台账里的 limits.connections 覆盖） */
const DEFAULT_CONNECTIONS = 4
/** 小于 4MB 不切段：切段握手开销差不多这么多 */
const MIN_SEGMENT_BYTES = 4 * 1024 * 1024

/**
 * 探一次：支不支持 Range、文件多大、etag。
 * 用 Range 探测而不是 HEAD —— 很多站点 HEAD 不给 content-length。
 */
async function probeUrl(url, signal) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
    redirect: 'follow',
    signal,
  })
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${res.statusText}`)

  const contentRange = res.headers.get('content-range') || ''
  const matched = contentRange.match(/\/(\d+)\s*$/)
  let total = matched ? Number(matched[1]) : Number(res.headers.get('content-length')) || 0
  if (!Number.isFinite(total) || total < 0) total = 0

  const acceptRanges = res.status === 206 || /bytes/i.test(res.headers.get('accept-ranges') || '')
  const etag = res.headers.get('etag') || ''

  /* 206 只有 1 个字节，读掉；200（服务器不理 Range）别把整份读进来，直接掐 */
  try {
    if (res.status === 206) await res.arrayBuffer()
    else if (res.body) await res.body.cancel()
  } catch {
    /* 读/掐失败都不影响探测结果 */
  }
  return { total, acceptRanges, etag }
}

/** 把 total 切成 count 段；total 未知或不切时返回单段 */
function planSegments(total, count) {
  if (!(total > 0) || count <= 1) return [{ start: 0, end: total > 0 ? total - 1 : -1, received: 0 }]
  const size = Math.ceil(total / count)
  const segments = []
  for (let start = 0; start < total; start += size) {
    segments.push({ start, end: Math.min(start + size, total) - 1, received: 0 })
  }
  return segments
}

/** 切不切、切几段 —— **唯一一处**做这个判断（下载逻辑与自检都调它） */
function planFor(total, connections, acceptRanges) {
  const wanted = acceptRanges && total >= MIN_SEGMENT_BYTES && connections > 1 ? connections : 1
  return { wanted, segments: planSegments(total, wanted) }
}

/** 建父目录 —— 已存在就跳过。盘根时 `mkdirSync('E:\')` 会抛 EPERM（2026-10-11 真机踩到） */
function ensureDir(dir) {
  if (fs.existsSync(dir)) return
  fs.mkdirSync(dir, { recursive: true })
}

function readMeta(metaFile) {
  try {
    return JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  } catch {
    return null
  }
}

function writeMeta(metaFile, meta) {
  try {
    fs.writeFileSync(metaFile, JSON.stringify(meta))
  } catch {
    /* 写不进去也不该让下载失败 —— 顶多是续传点丢了 */
  }
}

/** 删掉一个文件的续传残留（`.part` + `.part.json`） */
function cleanupParts(file) {
  for (const suffix of ['.part', '.part.json']) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true })
    } catch {
      /* 删不掉就算了，别把 remove 弄挂 */
    }
  }
}

module.exports = {
  DEFAULT_CONNECTIONS,
  MIN_SEGMENT_BYTES,
  probeUrl,
  planSegments,
  planFor,
  ensureDir,
  readMeta,
  writeMeta,
  cleanupParts,
}
