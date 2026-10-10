/**
 * 下载引擎：一个文件怎么下才靠得住。参照开源下载管理器（Ketch）的**功能思路**
 * 重写（不是搬代码）：① 并行分段（探 `Range`，支持就切段、多连接同时下）；
 * ② 断点续传（进度记在 `<目标>.part.json`，下次从断点接着下）；
 * ③ 失败重试（某条连接断了只重下这一段，从已收位置继续）。
 *
 * 边界：不支持 Range 的服务器**回退单连接**（硬切段会写出错位数据）；小文件
 * （< `MIN_SEGMENT_BYTES`）不切；落盘写 `.part` 再 rename（不占内存），中途磁盘
 * 上会有 `.part` / `.part.json`（由 queue 的 remove 负责清）。
 * 不 require electron、不碰台账 —— 只认「给我 url 和目标路径，我把字节弄上磁盘」。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

/** 默认几条连接（会被台账里的 limits.connections 覆盖） */
const DEFAULT_CONNECTIONS = 4
/** 小于这个大小就不切段了（4MB：切段的握手开销差不多要这么多） */
const MIN_SEGMENT_BYTES = 4 * 1024 * 1024
/** 每条连接失败后重试几次 */
const MAX_RETRIES = 3
/** 重试退避基数（毫秒）：第 n 次等 RETRY_BASE_MS × n */
const RETRY_BASE_MS = 500
/** 进度回调节流（毫秒）—— 每个 chunk 都报会把事件流刷爆 */
const PROGRESS_MIN_MS = 200
/** 断点元数据落盘节流（毫秒）—— 每个 chunk 都写盘会让下载变慢 */
const META_MIN_MS = 1000

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 取消用的错误（上游靠 `name === 'AbortError'` 认，别用别的方式判） */
function abortError() {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

/** 睡一会儿；被取消就立刻醒（醒来后调用方会检查 aborted） */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    }
  })
}

/* 探一次：支不支持 Range、文件多大、etag。用 Range 探测而不是 HEAD（很多站点 HEAD 不给 content-length） */
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

/* 下**一段**：从 seg.received 续着请求；断了退避重试（最多 retries 次），每次从已收位置接着来 */
async function runSegment(options) {
  const { url, seg, handle, retries, signal, gate, onBytes, onMeta, flushMeta } = options
  const length = seg.end >= seg.start ? seg.end - seg.start + 1 : Infinity
  let attempt = 0

  while (seg.received < length) {
    if (signal?.aborted) throw abortError()
    const from = seg.start + seg.received
    const headers = seg.end >= 0 ? { Range: `bytes=${from}-${seg.end}` } : {}
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      /* 从中间续却拿到 200（整份）—— 这服务器不会断点续传，写下去就是错位数据 */
      if (from > 0 && res.status !== 206) throw new Error('服务器不支持从中间续传')

      let position = from
      for await (const chunk of res.body ?? []) {
        const buf = Buffer.from(chunk)
        await handle.write(buf, 0, buf.length, position)
        position += buf.length
        seg.received += buf.length
        onBytes(buf.length)
        /* 全局限速：gate 是异步的，await 它就在这一格真正限住了速率 */
        if (gate) await gate(buf.length)
        onMeta()
      }
      attempt = 0
    } catch (error) {
      if (signal?.aborted) throw abortError()
      attempt += 1
      if (attempt > retries) {
        throw new Error(`连接连续失败 ${attempt} 次：${messageOf(error)}`)
      }
      await sleep(RETRY_BASE_MS * attempt, signal)
    }
  }
  flushMeta()
}

/**
 * 下一个文件。
 *
 * @param {{ url: string, file: string, connections?: number,
 *           onProgress?: (p: { received: number, total: number }) => void,
 *           gate?: (bytes: number) => Promise<void>, signal?: AbortSignal,
 *           retries?: number }} options
 * @returns {Promise<{ bytes: number, total: number, resumed: boolean, connections: number }>}
 */
async function downloadFile(options) {
  const {
    url,
    file,
    connections = DEFAULT_CONNECTIONS,
    onProgress,
    gate,
    signal,
    retries = MAX_RETRIES,
  } = options

  const partFile = `${file}.part`
  const metaFile = `${file}.part.json`
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const probe = await probeUrl(url, signal)
  const total = probe.total
  const { wanted, segments: planned } = planFor(total, connections, probe.acceptRanges)

  const previous = readMeta(metaFile)
  const reusable = Boolean(
    previous &&
      previous.url === url &&
      previous.total === total &&
      Array.isArray(previous.segments) &&
      previous.segments.length === wanted &&
      (probe.etag === '' || previous.etag === probe.etag),
  )
  const segments = reusable
    ? previous.segments.map((seg) => ({
        start: Number(seg.start) || 0,
        end: Number(seg.end),
        received: Number(seg.received) || 0,
      }))
    : planned

  const resumedFrom = segments.reduce((sum, seg) => sum + (Number(seg.received) || 0), 0)
  const resumed = reusable && resumedFrom > 0

  if (!reusable) {
    try {
      fs.rmSync(partFile, { force: true })
    } catch {
      /* 删不掉就覆盖写 */
    }
  }

  let handle
  if (total > 0) {
    if (!fs.existsSync(partFile)) fs.writeFileSync(partFile, Buffer.alloc(0))
    handle = await fsp.open(partFile, 'r+')
    await handle.truncate(total)
  } else {
    handle = await fsp.open(partFile, 'w')
  }

  const meta = { url, total, etag: probe.etag, segments }
  let metaAt = 0
  const flushMeta = (force) => {
    const now = Date.now()
    if (!force && now - metaAt < META_MIN_MS) return
    metaAt = now
    writeMeta(metaFile, meta)
  }
  flushMeta(true)

  let received = resumedFrom
  let lastAt = 0
  const progress = (force) => {
    const now = Date.now()
    if (!force && now - lastAt < PROGRESS_MIN_MS) return
    lastAt = now
    if (onProgress) onProgress({ received, total: total || received })
  }
  progress(true)

  try {
    for (const seg of segments) {
      if (signal?.aborted) throw abortError()
      await runSegment({
        url,
        seg,
        handle,
        retries,
        signal,
        gate,
        onBytes: (n) => {
          received += n
          progress(false)
        },
        onMeta: () => flushMeta(false),
        flushMeta: () => flushMeta(true),
      })
    }
  } finally {
    /* 中断（暂停/失败）时把最后一次真实进度落盘 —— 否则断点元数据还停在上一次
       节流刷新，续传会从更早的位置重来（真踩过：暂停时「已收」显示 0） */
    flushMeta(true)
    try {
      await handle.close()
    } catch {
      /* 关了就行 */
    }
  }

  try {
    fs.rmSync(metaFile, { force: true })
  } catch {
    /* 删不掉不影响成品 */
  }
  fs.renameSync(partFile, file)
  progress(true)

  return { bytes: received, total: total || received, resumed, connections: segments.length }
}

/** 清掉某条任务的临时文件（.part / .part.json）—— remove() 时用 */
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
  MAX_RETRIES,
  probeUrl,
  planSegments,
  planFor,
  downloadFile,
  cleanupParts,
}
