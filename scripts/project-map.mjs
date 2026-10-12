#!/usr/bin/env node
/**
 * 项目地图 —— 把「Harbor 现在有多大、长什么样」一次性打出来（**只读**，不写任何文件）
 *
 * 用法：`npm run map`
 *
 * 为什么要有它：`docs/项目地图.md` 里那些数（文件数 / 行数 / 各目录分布 / 测试文件数）
 * **每版都会涨**，手抄进文档必然过期（`AGENT.md` 硬约束 8：会涨的数字不写死）。
 * 这个脚本让数字「由命令生成」—— 文档只引用命令、不背数字，于是永远不会漂。
 *
 * 三条口径（**和 `tools/line-limit.mjs` 的 300 行红线共用** `tools/line-count.mjs`）：
 *   · 行数：**末尾换行不算一行**（`countLines`）
 *   · 二进制不算：文件里含 NUL 字节（`\0`）→ 判为二进制（png / ico / woff2 …），不计行数。
 *     2026-10-12 实测：不排二进制会把 1260 个文本文件虚报成 1269 个、行数虚高约 8%
 *     （`src/assets/` 从真实的 100 行被虚报成 10,403 行）。
 *   · 文件来源：`git ls-files`（只算被跟踪的项目文件，天然排掉 node_modules / dist / 临时副本）
 *
 * ⚠ 只做**机械统计**（有多少、谁引用谁）。其中「扇入 / 扇出」是**近似**：正则抠
 *   import 说明符、只认**相对路径**，别名（`@/`）/ 动态拼路径 / 条件 require 会漏 ——
 *   用来「看个大概、找骨干模块」，**不是准确度承诺**。
 *   **不画**真相源 / 重复状态那类「结构图」—— 那需要**判断**（哪个算重复、哪条是唯一
 *   真相源），不是统计，得单独立项。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { countLines } from '../tools/line-count.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

/** git 跟踪的文件列表（`-z`：路径含空格也不会被切坏） */
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
  } catch {
    console.error('拿不到 git ls-files —— 这个脚本要在 git 仓库里跑')
    process.exit(1)
  }
}

/**
 * 读成文本；判二进制 / 超大的返回 `{ binary: true }`。
 *
 * 二进制判据是**含 NUL 字节** —— 文本文件（含 svg、markdown）几乎不会有 `\0`，
 * 而 png / ico / woff2 一定有。比按扩展名列黑名单可靠（不用维护清单）。
 */
const MAX_BYTES = 5 * 1024 * 1024
function classify(rel) {
  try {
    if (statSync(path.join(ROOT, rel)).size > MAX_BYTES) return { binary: true }
    const buf = readFileSync(path.join(ROOT, rel))
    if (buf.includes(0)) return { binary: true }
    return { binary: false, text: buf.toString('utf8') }
  } catch {
    return { binary: true }
  }
}

/** 数某个目录下、路径匹配 pred 的文件个数（跳过大目录；不值得引 glob 库） */
function countFiles(pred, dir) {
  let n = 0
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (pred(full)) n += 1
    }
  }
  walk(dir)
  return n
}

const rows = []
let binaryCount = 0
for (const rel of trackedFiles()) {
  const r = classify(rel)
  if (r.binary) {
    binaryCount += 1
    continue
  }
  rows.push({ rel, lines: countLines(r.text) })
}

const topOf = (rel) => (rel.includes('/') ? `${rel.split('/')[0]}/` : '(根目录)')
const extOf = (rel) => {
  const base = rel.split('/').pop()
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '(无扩展名)' : base.slice(dot)
}
const subOf = (rel) =>
  rel.split('/').length >= 3 ? `${rel.split('/')[0]}/${rel.split('/')[1]}/` : null

/** 按 keyOf 分组求和，按行数降序 */
function group(keyOf, filter = () => true) {
  const map = new Map()
  for (const r of rows) {
    if (!filter(r.rel)) continue
    const cur = map.get(keyOf(r.rel)) ?? { files: 0, lines: 0 }
    cur.files += 1
    cur.lines += r.lines
    map.set(keyOf(r.rel), cur)
  }
  return [...map.entries()].sort((a, b) => b[1].lines - a[1].lines)
}

const fmt = (n) => n.toLocaleString('en-US')
const row = (key, v, width = 14) =>
  `  ${key.padEnd(width)} ${String(v.files).padStart(5)} files  ${fmt(v.lines).padStart(9)} lines`

const totalLines = rows.reduce((s, r) => s + r.lines, 0)
console.log('═══ Harbor 项目地图 ═══')
console.log('（只读；数字「每版都会涨」，这份输出就是「现状」的真相源）\n')
console.log(`总计：${fmt(rows.length)} 个文本文件 / ${fmt(totalLines)} 行`)
console.log(`      另 ${binaryCount} 个二进制文件（图片 / 字体 / 压缩包等）不计行数`)

console.log('\n── 顶层目录 ──')
for (const [k, v] of group(topOf)) console.log(row(k, v))

console.log('\n── 按扩展名 ──')
for (const [k, v] of group(extOf)) console.log(row(k, v, 12))

console.log('\n── 二级目录 ──')
for (const dir of ['src', 'electron', 'scripts', 'docs']) {
  console.log(`  -- ${dir}/ --`)
  const sub = group((rel) => subOf(rel) ?? `${dir}/（直接）`, (rel) => rel.startsWith(`${dir}/`))
  for (const [k, v] of sub) console.log(row(k, v, 22))
}

console.log('\n── 质量网（文件数；断言项数看 `npm test` 末尾）──')
const q = [
  ['前端单元测试  src/**/*.test.ts|tsx', countFiles((f) => /\.test\.tsx?$/.test(f), path.join(ROOT, 'src'))],
  ['内核自检组    scripts/selftest/groups/*.mjs', countFiles((f) => /\.mjs$/.test(f), path.join(ROOT, 'scripts/selftest/groups'))],
  ['安全测试      scripts/security/**/*.mjs', countFiles((f) => /\.mjs$/.test(f), path.join(ROOT, 'scripts/security'))],
  ['规则检查自测  scripts/**/*.test.mjs', countFiles((f) => /\.test\.mjs$/.test(f), path.join(ROOT, 'scripts'))],
]
for (const [k, n] of q) console.log(`  ${k.padEnd(46)} ${n}`)

/* ── 耦合：谁被 import 得最多（扇入）/ 谁 import 得最多（扇出）──
 *
 * 纯机械：正则抠出 `require('x')` / `import … from 'x'` / `import('x')`，把**相对路径**
 * 解析到仓库里某个真实文件；解析不上（bare 包名 / `node:` / 别名）的当外部依赖，不计。
 * 用来回答「内核的骨干是哪几个」—— 被引用越多 = 越像地基，改它要越小心。
 */
const CODE_EXT = new Set(['.ts', '.tsx', '.cjs', '.mjs', '.js', '.cts', '.jsx'])
const existing = new Set(rows.map((r) => r.rel))
const IMPORT_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g
const SIDE_EFFECT_RE = /\bimport\s+['"]([^'"]+)['"]/g
const EXT_TRY = ['', '.ts', '.tsx', '.cjs', '.mjs', '.js', '.cts', '.json']
const INDEX_TRY = ['/index.ts', '/index.tsx', '/index.cjs', '/index.mjs', '/index.js']

function resolveRel(fromRel, spec) {
  if (!spec.startsWith('.')) return null /* 外部依赖 / 别名（@/）—— 不解析 */
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
  for (const e of EXT_TRY) if (existing.has(target + e)) return target + e
  for (const e of INDEX_TRY) if (existing.has(target + e)) return target + e
  return null
}

const fanIn = new Map() /* 被引用方 → 一组引用它的文件 */
const fanOut = new Map() /* 引用方 → 一组它引用的文件 */
for (const r of rows) {
  if (!CODE_EXT.has(path.extname(r.rel))) continue
  /* `rows` 只留了行数、没留正文（省内存）—— 这里按需重读（只读代码文件） */
  let text
  try {
    text = readFileSync(path.join(ROOT, r.rel), 'utf8')
  } catch {
    continue
  }
  const specs = new Set()
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(text))) specs.add(m[1])
  SIDE_EFFECT_RE.lastIndex = 0
  while ((m = SIDE_EFFECT_RE.exec(text))) specs.add(m[1])
  const outs = new Set()
  for (const s of specs) {
    const t = resolveRel(r.rel, s)
    if (t && t !== r.rel) outs.add(t)
  }
  fanOut.set(r.rel, outs)
  for (const t of outs) {
    if (!fanIn.has(t)) fanIn.set(t, new Set())
    fanIn.get(t).add(r.rel)
  }
}

console.log('\n── 耦合 · 扇入（被最多文件引用的模块；改它要最小心）──')
const topIn = [...fanIn.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 12)
for (const [k, set] of topIn) console.log(`  ${k.padEnd(44)} ← 被 ${String(set.size).padStart(3)} 个文件引用`)

/* 上面这批榜首常常是测试脚手架（自检组 / 安全沙箱）—— 它们被每个用例引用，会盖住
 * 真正的业务骨干。所以再切一刀：**只看产品代码**（`src/` + `electron/`，去掉测试）。 */
const isProduct = (rel) =>
  (rel.startsWith('src/') || rel.startsWith('electron/')) && !/\.test\.[cm]?[jt]sx?$/.test(rel)
console.log('\n── 耦合 · 扇入 · 只看产品代码（src/ + electron/，去测试脚手架）──')
const topProd = [...fanIn.entries()]
  .filter(([k]) => isProduct(k))
  .sort((a, b) => b[1].size - a[1].size)
  .slice(0, 12)
for (const [k, set] of topProd) console.log(`  ${k.padEnd(44)} ← 被 ${String(set.size).padStart(3)} 个文件引用`)

console.log('\n── 耦合 · 扇出（引用模块最多的文件 = 耦合最重的；最该盯拆分）──')
const topOut = [...fanOut.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 10)
for (const [k, set] of topOut) console.log(`  ${k.padEnd(44)} → 引 ${String(set.size).padStart(3)} 个模块`)

console.log('\n（注：扇入 / 扇出只认**相对路径**，别名（@/）与外部包不计 —— 是近似，不是精确依赖图。）')
console.log('（要「结构图」——真相源 / 重复状态——需另立项：那是判断，不是统计。）')
