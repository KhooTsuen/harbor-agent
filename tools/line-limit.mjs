/**
 * 单文件行数检查（守 `AGENT.md` 硬约束 #2：单文件 ≤ 300 行）
 *
 * 为什么要它：这条硬规则**一直靠自觉** —— 2026-09-23 实测，有人（我）把 3 个文件
 * 改过头，**没有任何测试报出来**。对比一下：IPC 通道数有 `channelsOk` 守、
 * 版本号有同步组守、提示词有内容回归守，唯独行数没有。
 * 「没有强制的硬规则不是规则，是愿望。」
 *
 * 用法：
 *   node tools/line-limit.mjs                 # 超了就列出并以 1 退出（给 CI / hook 用）
 *   node tools/line-limit.mjs --code-only     # **不算注释行**（2026-09-23 提案的形态）
 *   node tools/line-limit.mjs --limit=400     # 换一条线
 *   node tools/line-limit.mjs --all           # 连合规的也列出来（看余量）
 *
 * 两条踩过的坑，写在这里免得再踩：
 *   · **末尾换行不算一行** —— 不然一个正好 300 行的文件会被数成 301（真踩过，
 *     那一轮扫描报了 51 个"超标"，其中一大批其实是刚好合规）。
 *   · 别把 `tmp/`、`test-env/`、`dist-portable/` 算进来 —— 那些是历史测试副本，
 *     会淹没真实结果（同一次扫描里它们贡献了 41 条噪音）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const LIMIT = Number(arg('limit', '300'))
const CODE_ONLY = argv.includes('--code-only')
const SHOW_ALL = argv.includes('--all')
/** 成功时一句不说 —— 给 hook 用（否则每次工具调用都刷一行） */
const QUIET = argv.includes('--quiet')

/** 只看这些目录（和 AGENT.md 的口径一致） */
const SCAN = ['src', 'electron', 'scripts', 'tools']
/** 这些不是本项目当前代码：历史副本 / 构建产物 / 依赖 */
const SKIP = new Set([
  'node_modules',
  'dist',
  'dist-portable',
  'tmp',
  'test-env',
  'backups',
  'shots',
  '.git',
  '.vscode',
])
const EXTS = new Set(['.ts', '.tsx', '.cjs', '.mjs'])

/**
 * 只留代码行：去掉行注释、块注释、以及纯注释行。
 *
 * 这是个**近似**（不解析字符串里的 `//`），但对"数行数"这个用途足够了，
 * 而且它服务的是一条更重要的原则：**解释"为什么"的注释不该被行数惩罚**
 * （AGENT.md 自己说"踩过的坑写进去 —— 那是最值钱的部分"）。
 */
function codeLineCount(text) {
  const out = []
  let inBlock = false
  for (const raw of text.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    /* 去掉块注释（可能跨行） */
    for (;;) {
      const start = line.indexOf('/*')
      if (start < 0) break
      const end = line.indexOf('*/', start + 2)
      if (end < 0) {
        line = line.slice(0, start)
        inBlock = true
        break
      }
      line = line.slice(0, start) + line.slice(end + 2)
    }
    /* 去掉行注释（粗略：不区分是否在字符串里） */
    const slash = line.indexOf('//')
    if (slash >= 0) line = line.slice(0, slash)
    if (line.trim()) out.push(line)
  }
  return out.length
}

const rows = []
const walk = (dir) => {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full)
      continue
    }
    const dot = name.lastIndexOf('.')
    if (!EXTS.has(name.slice(dot))) continue
    const text = readFileSync(full, 'utf8')
    /* 末尾换行不算一行 —— 见文件头注释 */
    const total = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    const n = CODE_ONLY ? codeLineCount(text) : total
    rows.push({ file: relative(ROOT, full), n, total })
  }
}

for (const dir of SCAN) walk(join(ROOT, dir))

const over = rows.filter((r) => r.n > LIMIT).sort((a, b) => b.n - a.n)
const label = CODE_ONLY ? '代码行（不含注释）' : '总行数'

if (over.length > 0) {
  console.log(`✗ ${over.length} 个文件超过 ${LIMIT} 行（${label}）：`)
  for (const r of over) {
    const extra = CODE_ONLY ? `（总行 ${r.total}）` : ''
    console.log(`  ${r.n}  ${r.file}${extra}`)
  }
  console.log('\n拆法见 AGENT.md 硬约束 #2；拆的时候注意 docs/踩坑记录.md 里那两个坑。')
} else if (!QUIET) {
  console.log(`✓ ${rows.length} 个文件，没有超过 ${LIMIT} 行的（${label}）`)
}

if (SHOW_ALL) {
  console.log('\n余量最小的 10 个：')
  for (const r of [...rows].sort((a, b) => b.n - a.n).slice(0, 10)) {
    console.log(`  ${r.n}  ${r.file}`)
  }
}

process.exit(over.length > 0 ? 1 : 0)
