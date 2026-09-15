const fs = require('node:fs')
const { resolvePath, readTextFile, normalizeNewlines, snapshotBefore } = require('./_shared.cjs')

/**
 * 精确替换。
 *
 * 关键点：oldText 必须在文件里**唯一出现**，否则拒绝执行。
 * 这条规则是从踩坑里来的 —— 允许「替换第一处」的话，
 * 模型改错位置时你完全看不出来。
 */
module.exports = {
  name: 'edit_file',
  description:
    '把文件里的一小段文本替换成另一段。oldText 必须在文件里唯一出现（否则会报错让你改得更精确）。改少量内容用这个，比 write_file 安全。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要改的文件路径' },
      oldText: { type: 'string', description: '要被替换的原文（必须唯一且逐字匹配，包括缩进）' },
      newText: { type: 'string', description: '替换成什么（留空表示删除这段）' },
    },
    required: ['path', 'oldText', 'newText'],
  },

  async run(args, ctx) {
    const file = resolvePath(args.path, ctx.workdir, ctx)
    if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`)

    /* 事务快照：改之前先留底 */
    snapshotBefore(ctx, file)

    const original = normalizeNewlines(readTextFile(file))
    const oldText = normalizeNewlines(String(args.oldText ?? ''))
    const newText = normalizeNewlines(String(args.newText ?? ''))

    if (!oldText) throw new Error('oldText 不能为空')

    const first = original.indexOf(oldText)
    if (first === -1) {
      /* 给一点线索，帮模型自己纠正 */
      const preview = oldText.split('\n')[0]?.trim().slice(0, 60) ?? ''
      const nearby = preview
        ? original
            .split('\n')
            .map((line, i) => ({ line, i }))
            .filter(({ line }) => preview && line.includes(preview))
            .slice(0, 3)
            .map(({ line, i }) => `  第 ${i + 1} 行：${line.trim().slice(0, 90)}`)
            .join('\n')
        : ''
      throw new Error(
        `在 ${file} 里找不到这段原文。请先用 read_file 确认内容和缩进是否逐字一致。` +
          (nearby ? `\n可能相关的位置：\n${nearby}` : ''),
      )
    }

    const second = original.indexOf(oldText, first + oldText.length)
    if (second !== -1) {
      const lineA = original.slice(0, first).split('\n').length
      const lineB = original.slice(0, second).split('\n').length
      throw new Error(
        `这段原文在文件里出现了多次（第 ${lineA} 行和第 ${lineB} 行）。` +
          `请把 oldText 写得更长一些，带上前后文让它唯一。`,
      )
    }

    const updated = original.slice(0, first) + newText + original.slice(first + oldText.length)
    fs.writeFileSync(file, updated, 'utf8')

    const atLine = original.slice(0, first).split('\n').length
    const removed = oldText.split('\n').length
    const added = newText ? newText.split('\n').length : 0
    return `已修改 ${file}（第 ${atLine} 行起：${removed} 行 → ${added} 行）`
  },

  summarize(args) {
    const removed = String(args.oldText ?? '').split('\n').length
    const added = String(args.newText ?? '').split('\n').length
    return `改文件 ${args.path}（−${removed} +${added} 行）`
  },
}
