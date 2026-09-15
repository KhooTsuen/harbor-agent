const fs = require('node:fs')
const { resolvePath, readTextFile, withLineNumbers, truncateMiddle } = require('./_shared.cjs')

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

    const text = readTextFile(file)
    const lines = text.split('\n')
    const offset = Math.max(1, Number(args.offset) || 1)
    const limit = Math.min(4000, Math.max(1, Number(args.limit) || 400))
    const slice = lines.slice(offset - 1, offset - 1 + limit)

    const shown = withLineNumbers(slice.join('\n'), offset)
    const more = offset - 1 + limit < lines.length
    const header = `${file}（共 ${lines.length} 行）`

    return truncateMiddle(
      `${header}\n${shown}${more ? `\n…（还有 ${lines.length - (offset - 1 + limit)} 行，用 offset 继续读）` : ''}`,
    )
  },

  summarize(args) {
    return `读文件 ${args.path}`
  },
}
