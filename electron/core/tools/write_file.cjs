const fs = require('node:fs')
const path = require('node:path')
const { resolvePath, snapshotBefore } = require('./_shared.cjs')

module.exports = {
  name: 'write_file',
  description:
    '写入整个文件（存在就覆盖，不存在就新建，父目录会自动建）。小改动请优先用 edit_file，只有新建文件或整体重写时才用这个。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的路径，或绝对路径' },
      content: { type: 'string', description: '文件的完整内容' },
    },
    required: ['path', 'content'],
  },

  async run(args, ctx) {
    const file = resolvePath(args.path, ctx.workdir, ctx)
    /* 事务快照要在写之前 —— 晚了就拿不到原始内容了 */
    snapshotBefore(ctx, file)
    const content = String(args.content ?? '')
    fs.mkdirSync(path.dirname(file), { recursive: true })

    const existed = fs.existsSync(file)
    const before = existed ? fs.statSync(file).size : 0
    fs.writeFileSync(file, content, 'utf8')

    const verb = existed ? '覆盖' : '新建'
    return `${verb} ${file}（${before} → ${Buffer.byteLength(content, 'utf8')} 字节，${content.split('\n').length} 行）`
  },

  summarize(args) {
    const size = Buffer.byteLength(String(args.content ?? ''), 'utf8')
    return `写文件 ${args.path}（${size} 字节）`
  },
}
