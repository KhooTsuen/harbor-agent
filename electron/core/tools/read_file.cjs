const fs = require('node:fs')
const { resolvePath, readTextFile, withLineNumbers, truncateMiddle } = require('./_shared.cjs')
const fileCache = require('../file-cache.cjs')

module.exports = {
  name: 'read_file',
  description:
    '读一个文本文件的内容，返回带行号的结果。可以只读一部分（给 offset/limit）。读之前不确定路径时先用 list_dir。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的路径，或绝对路径' },
      offset: { type: 'integer', description: '从第几行开始（1 开始），默认 1' },
      limit: { type: 'integer', description: '最多读多少行，默认 400' },
    },
    required: ['path'],
  },

  async run(args, ctx) {
    const file = resolvePath(args.path, ctx.workdir, ctx)
    if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`)

    /*
     * AG-019：同一个文件、内容没变 → 用缓存，并在抬头里注明。
     *
     * 为什么**照样把内容给出去**（而不是只回一句「没变」）：历史可能被压缩
     * （AG-016），压完之后旧内容就只剩摘要了 —— 那时候只回一句「没变」
     * 等于让模型凭空相信一个它看不见的东西。
     */
    const cached = fileCache.get(file)
    const text = cached.hit ? cached.content : readTextFile(file)
    if (!cached.hit) fileCache.put(file, { content: text, source: 'read_file' })
    /* 缓存命中计数（token 优化指标）：记进任务台账的 toolStats */
    if (cached.hit && ctx?.taskId) {
      try {
        require('../task-notes.cjs').bumpToolStats(ctx.taskId, { cacheHits: 1 })
      } catch {
        /* 记不上不影响读 */
      }
    }

    const lines = text.split('\n')
    const offset = Math.max(1, Number(args.offset) || 1)
    const limit = Math.min(4000, Math.max(1, Number(args.limit) || 400))
    const slice = lines.slice(offset - 1, offset - 1 + limit)

    const shown = withLineNumbers(slice.join('\n'), offset)
    const more = offset - 1 + limit < lines.length
    const header = `${file}（共 ${lines.length} 行${cached.hit ? '，与上次读取内容一致' : ''}）`

    return truncateMiddle(
      `${header}\n${shown}${more ? `\n…（还有 ${lines.length - (offset - 1 + limit)} 行，用 offset 继续读）` : ''}`,
    )
  },

  summarize(args) {
    return `读文件 ${args.path}`
  },
}
