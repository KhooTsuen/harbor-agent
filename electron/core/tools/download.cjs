const path = require('node:path')
const { resolvePath } = require('./_shared.cjs')
const engine = require('../download-engine.cjs')
const fileCache = require('../file-cache.cjs')

/* ══════════════════════════════════════════════════════════════
   download —— 把网址上的文件抓到工作目录（真机反馈 9b）

   为什么要有它：以前模型想「下载一张图 / 一个压缩包」只能 `run_shell` 里
   拼 `curl` / `Invoke-WebRequest` —— 命令能不能跑通要看用户机器上有什么，
   而且**界面上一片空白**：几十秒里只有一个转圈的「run_shell 正在运行」。

   ★ 2026-10-11：真正下文件的活交给 `download-engine.cjs`（并行分段 /
   断点续传 / 失败重试），这里只管「解析路径 + 报进度 + 检查大小上限」。
   以前是**整个文件读进内存再原子写**，200MB 就到顶；现在直接写 `.part`、
   下完 rename，所以上限放到 2GB、中途断了也在 `.part` 上留着断点。

   三条边界：
     · 只吃 http/https（`file://` 这类本地协议从模型嘴里说出来很危险）；
     · 单个文件 2GB 上限（模型看不见「这文件多大」，别让它把磁盘吃光）；
     · 联网这件事归 `allowNetwork` 管 —— 那道门在 tools/index.cjs 里，不在这儿。
   ══════════════════════════════════════════════════════════════ */

/** 单个文件上限：超过就直说，而不是先下完再报错 */
const MAX_BYTES = 2 * 1024 * 1024 * 1024
/** 并行连接数（模型不下这个决定，写死一个稳妥值） */
const CONNECTIONS = 4

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

module.exports = {
  name: 'download',
  description:
    '把 http/https 上的文件下载到工作目录（图片、压缩包、数据集等）。支持并行分段与断点续传；' +
    '单个文件上限 2GB。网页正文用 browse，不要用这个。',
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
    engine.ensureDir(path.dirname(file))

    /* 先探一次拿大小，超上限就当场拒，别下到一半才发现 */
    let probe
    try {
      probe = await engine.probeUrl(url)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`连不上或太大：${reason}`)
    }
    if (probe.total > MAX_BYTES) {
      throw new Error(`文件太大：${human(probe.total)}，超过 ${human(MAX_BYTES)} 上限`)
    }

    const startedAt = Date.now()
    const report = (received, total, done = false) => {
      ctx.progress?.({
        percent: total > 0 ? Math.floor((received / total) * 100) : null,
        note: total > 0 ? `${human(received)} / ${human(total)}` : `已收 ${human(received)}`,
        done,
      })
    }

    let result
    try {
      result = await engine.downloadFile({
        url,
        file,
        connections: CONNECTIONS,
        onProgress: ({ received, total }) => report(received, total),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`下载失败：${reason}（断点留在 ${path.basename(file)}.part，重试可接着下）`)
    }

    /* 刚写过的文件缓存必须作废（同 write_file，AG-019） */
    fileCache.invalidate(file)
    report(result.bytes, result.total, true)

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    const resumed = result.resumed ? '（从断点续传）' : ''
    return `已下载 ${url}\n→ ${file}（${human(result.bytes)}，${result.connections} 条连接，耗时 ${seconds}s）${resumed}`
  },

  summarize(args) {
    return `下载 ${String(args.url ?? '')} → ${String(args.path ?? '')}`
  },
}
