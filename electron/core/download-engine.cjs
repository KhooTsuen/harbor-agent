/**
 * 下载引擎：分段并发 + 断点续传 + 重试 + 完整性校验。
 * 纯函数（探测 / 切段 / 目录 / 断点元数据 / 清临时）在 `download-plan.cjs`。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
/* 纯函数那一半；这里再导出一次，调用方与自检拿到的形状不变 */
const {
  DEFAULT_CONNECTIONS,
  MIN_SEGMENT_BYTES,
  probeUrl,
  planSegments,
  planFor,
  ensureDir,
  readMeta,
  writeMeta,
  cleanupParts,
} = require('./download-plan.cjs')

/** 失败重试次数；第 n 次退避 RETRY_BASE_MS × n */
const MAX_RETRIES = 3
const RETRY_BASE_MS = 500
/** 进度回调 / 断点落盘节流：每个 chunk 都做会刷爆事件流、拖慢下载 */
const PROGRESS_MIN_MS = 200
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
      /* ★ 206 的 Content-Range 起点必须等于我们要的 from（第 10 项）。服务器错位返回、
         或忽略 Range 却标 206 时，写下去就是**错位数据** —— 文件坏了还报成功。
         缺这个头也不接受：没有它就无法证明这段是我们要的那段。 */
      if (res.status === 206) {
        const got = /bytes\s+(\d+)-(\d+)/i.exec(res.headers.get('content-range') || '')
        if (!got || Number(got[1]) !== from) {
          throw new Error(`段落对不上（要 ${from}，给 ${got ? got[1] : '无 Content-Range'}）`)
        }
      }

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
      /* 未知总长（end<0）没有字节边界可数，流读到 EOF 就是这段结束。不收尾会再发一次
         请求，第二轮撞上「不支持从中间续传」——无 Content-Length 的文件必定失败。 */
      if (seg.end < 0) break
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

/** 下一个文件。返回 { bytes, total, resumed, connections }（调用方 download-queue.cjs） */
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
  ensureDir(path.dirname(file))

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
    /* total 原样传（别写 `total || received`：不给 Content-Length 时 total=0，界面会永远 100%） */
    if (onProgress) onProgress({ received, total })
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
    /* 中断（暂停/失败）时把最后一次真实进度落盘 —— 否则续传会从更早的位置重来 */
    flushMeta(true)
    try {
      await handle.close()
    } catch {
      /* 关了就行 */
    }
  }

  /* 服务器提前 EOF / 响应被截时，以前照样 rename 出**短文件**并报成功。
     抛在 rename 之前：`.part.json` 还在，下次能直接续传；rename 掉就接不上了。 */
  if (total > 0 && received !== total) {
    throw new Error(`下载不完整：收到 ${received} / 应有 ${total} 字节（已留在 .part，可续传）`)
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

module.exports = {
  DEFAULT_CONNECTIONS,
  MIN_SEGMENT_BYTES,
  MAX_RETRIES,
  probeUrl,
  planSegments,
  planFor,
  ensureDir,
  downloadFile,
  cleanupParts,
}
