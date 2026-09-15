const fs = require('node:fs')
const path = require('node:path')
const { resolvePath } = require('./_shared.cjs')

/** 这些目录默认不列，否则一列就是几万行 */
const IGNORED = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  'target',
])

const MAX_ENTRIES = 400

module.exports = {
  name: 'list_dir',
  description:
    '列出目录内容。默认只看一层，可以用 depth 递归（最多 4 层）。node_modules/.git/dist 这类目录会自动跳过。不确定项目结构时先看这里。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，默认工作目录' },
      depth: { type: 'integer', description: '递归层数，1 = 只看当前层（默认 1，最多 4）' },
      all: { type: 'boolean', description: '是否包含被忽略的目录（默认 false）' },
    },
    required: [],
  },

  async run(args, ctx) {
    const root = resolvePath(args.path || '.', ctx.workdir, ctx)
    if (!fs.existsSync(root)) throw new Error(`目录不存在：${root}`)
    if (!fs.statSync(root).isDirectory()) throw new Error(`${root} 不是目录`)

    const depth = Math.min(4, Math.max(1, Number(args.depth) || 1))
    const showAll = args.all === true
    const lines = []
    let count = 0
    let truncated = false

    function walk(dir, level, prefix) {
      if (count >= MAX_ENTRIES) {
        truncated = true
        return
      }
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (error) {
        lines.push(`${prefix}[读不了：${error instanceof Error ? error.message : '未知错误'}]`)
        return
      }

      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      for (const entry of entries) {
        if (count >= MAX_ENTRIES) {
          truncated = true
          return
        }
        if (
          !showAll &&
          (IGNORED.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.env.example'))
        ) {
          continue
        }

        const full = path.join(dir, entry.name)
        count += 1

        if (entry.isDirectory()) {
          lines.push(`${prefix}${entry.name}/`)
          if (level < depth) walk(full, level + 1, `${prefix}  `)
        } else {
          let size = 0
          try {
            size = fs.statSync(full).size
          } catch {
            /* 读不到就算了 */
          }
          lines.push(`${prefix}${entry.name}  (${formatSize(size)})`)
        }
      }
    }

    walk(root, 1, '')

    const head = `${root}${depth > 1 ? `（递归 ${depth} 层）` : ''}：`
    const tail = truncated ? `\n…（条目太多，只列了前 ${MAX_ENTRIES} 个）` : ''
    return `${head}\n${lines.join('\n') || '（空目录）'}${tail}`
  },

  summarize(args) {
    return `列目录 ${args.path || '.'}`
  },
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
