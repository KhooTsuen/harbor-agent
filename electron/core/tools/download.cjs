const fs = require('node:fs')
const path = require('node:path')
const { resolvePath } = require('./_shared.cjs')
const { writeAtomic } = require('../safe-write.cjs')
const fileCache = require('../file-cache.cjs')

/* ══════════════════════════════════════════════════════════════
   download —— 把网址上的文件抓到工作目录（真机反馈 9b）

   为什么要有它：以前模型想「下载一张图 / 一个压缩包」只能 `run_shell` 里
   拼 `curl` / `Invoke-WebRequest` —— 命令能不能跑通要看用户机器上有什么，
   而且**界面上一片空白**：几十秒里只有一个转圈的「run_shell 正在运行」。

   所以这个工具自己报进度（`ctx.progress` → `agent.tool.progress` → 那条进度条），
   落盘走 `safe-write.writeAtomic`（Windows 上目标文件被占着时 rename 会
   EPERM/EBUSY，那边有退避重试 —— 日志/记忆文件踩过这个坑）。

   三条边界：
     · 只吃 http/https（`file://` 这类本地协议从模型嘴里说出来很危险）；
     · 单个文件 200MB 上限（模型看不见「这文件多大」，别让它把磁盘吃光）；
     · 联网这件事归 `allowNetwork` 管 —— 那道门在 tools/index.cjs 里，不在这儿。
   ══════════════════════════════════════════════════════════════ */

/** 单个文件上限：超过就直说，而不是先下完再报错 */
const MAX_BYTES = 200 * 1024 * 1024
/** 一次下载的总超时（挂住的连接不该把整轮对话拖死） */
const TIMEOUT_MS = 10 * 60 * 1000
/** 进度节流：每 250ms 最多报一次 —— 每个 chunk 都发会把事件流刷爆 */
const PROGRESS_MIN_MS = 250

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

module.exports = {
  name: 'download',
  description:
    '把 http/https 上的文件下载到工作目录（图片、压缩包、数据集等）。网页正文用 browse，不要用这个。单个文件上限 200MB。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '下载地址（必须 http/https）' },
      path: { type: 'string', description: '保存到哪：相对工作目录的路径，或绝对路径' },
    },
    required: ['url', 'path'],
  },

  async run(args, ctx) {
    const url = String(args.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error(`只支持 http/https 地址：${url || '（空）'}`)

    const file = resolvePath(args.path, ctx.workdir, ctx)
    fs.mkdirSync(path.dirname(file), { recursive: true })

    const startedAt = Date.now()
    const report = (received, total, done = false) => {
      ctx.progress?.({
        percent: total > 0 ? Math.floor((received / total) * 100) : null,
        note: total > 0 ? `${human(received)} / ${human(total)}` : `已收 ${human(received)}`,
        done,
      })
    }

    let res
    try {
      res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`连不上或太慢（最长等 ${TIMEOUT_MS / 60_000} 分钟）：${reason}`)
    }
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`)

    const total = Number(res.headers.get('content-length')) || 0
    if (total > MAX_BYTES) {
      throw new Error(`文件太大：${human(total)}，超过 ${human(MAX_BYTES)} 上限`)
    }

    /* 先落内存再原子写：中途失败不会在磁盘上留半个文件（半截文件比没有更坑） */
    const chunks = []
    let received = 0
    let lastAt = 0
    report(0, total)

    for await (const chunk of res.body ?? []) {
      const buf = Buffer.from(chunk)
      received += buf.length
      if (received > MAX_BYTES) {
        throw new Error(`下载超过 ${human(MAX_BYTES)} 上限，已中止（没有写盘）`)
      }
      chunks.push(buf)
      const now = Date.now()
      if (now - lastAt >= PROGRESS_MIN_MS) {
        lastAt = now
        report(received, total)
      }
    }

    const body = Buffer.concat(chunks)
    writeAtomic(file, body)
    /* 刚写过的文件缓存必须作废（同 write_file，AG-019） */
    fileCache.invalidate(file)
    report(body.length, total || body.length, true)

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    return `已下载 ${url}\n→ ${file}（${human(body.length)}，耗时 ${seconds}s）`
  },

  summarize(args) {
    return `下载 ${String(args.url ?? '')} → ${String(args.path ?? '')}`
  },
}
