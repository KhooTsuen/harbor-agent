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
 *   node tools/line-limit.mjs --warn=270      # 「接近红线」的告警带（默认 270，只提示、不判红）
 *   node tools/line-limit.mjs --all           # 连合规的也列出来（看余量）
 *
 * 行数口径（末尾换行算不算一行、code-only 怎么去注释）**不在这个文件里** ——
 * 它是 [`line-count.mjs`](line-count.mjs) 的一份定义，这里 import 来用
 * （和 `scripts/project-map.mjs` 共用同一份）。本文件只管「怎么扫、怎么判、怎么报」。
 *
 * 两条踩过的坑，写在这里免得再踩：
 *   · **末尾换行不算一行** —— 不然一个正好 300 行的文件会被数成 301（真踩过，
 *     那一轮扫描报了 51 个"超标"，其中一大批其实是刚好合规）。
 *   · 别把 `tmp/`、`test-env/`、`dist-portable/` 算进来 —— 那些是历史测试副本，
 *     会淹没真实结果（同一次扫描里它们贡献了 41 条噪音）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
/* 行数口径的唯一实现 —— 和 scripts/project-map.mjs（npm run map）共用这一份 */
import { CODE_EXTS, countCodeLines, countLines } from './line-count.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const LIMIT = Number(arg('limit', '300'))
/*
 * 告警带：`>= WARN 且 <= LIMIT` 的文件只**提示**、不判红（退出码不受影响）。
 *
 * 为什么要它：1052 个文件里有 61 个卡在 290–300、82 个卡在 280–300（2026-10-09 实测）——
 * 一道「悬崖」：加几行就必须拆，于是拆得仓促。告警带把这句话提前说出来
 * （「你离红线不到 30 行了，先想清楚它该住哪」），让拆分**有计划**而不是**贴线才拆**。
 *
 * ⚠ 输出格式有约束：`scripts/check-rules/checks.mjs` 的 `checkLineLimits()` 是**逐行正则**
 *   解析本文件输出的（`^\s+(\d+)\s+(文件名)` = 一条超线）。所以告警**只能用一行摘要**
 *   （开头是 `↳`，不是数字），**绝不能**列出「缩进 + 数字 + 文件名」的行 —— 那会被当成违规。
 */
const WARN = Number(arg('warn', '270'))
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
    if (!CODE_EXTS.has(name.slice(dot))) continue
    const text = readFileSync(full, 'utf8')
    /* 末尾换行不算一行 —— 口径在 tools/line-count.mjs */
    const total = countLines(text)
    const n = CODE_ONLY ? countCodeLines(text) : total
    rows.push({ file: relative(ROOT, full), n, total })
  }
}

for (const dir of SCAN) walk(join(ROOT, dir))

const over = rows.filter((r) => r.n > LIMIT).sort((a, b) => b.n - a.n)
/* 告警带：接近红线但**还没**超 —— 只提示 */
const near = rows.filter((r) => r.n > WARN && r.n <= LIMIT).sort((a, b) => b.n - a.n)
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
  if (near.length > 0) {
    console.log(
      `  ↳ 另有 ${near.length} 个已 ≥${WARN} 行，离红线不到 ${LIMIT - WARN} 行 —— 加代码前先想清楚它该住哪，别等贴线才拆。`,
    )
  }
}

if (SHOW_ALL) {
  console.log(`\n余量最小的 10 个（告警带 ≥${WARN}）：`)
  for (const r of [...rows].sort((a, b) => b.n - a.n).slice(0, 10)) {
    console.log(`  ${r.n}  ${r.file}`)
  }
}

process.exit(over.length > 0 ? 1 : 0)
