#!/usr/bin/env node
/**
 * 重复候选扫描器（C3）—— 找出「同一个名字可能又写了一份」的地方，**只报告、永不拦门**。
 *
 * 用法：`npm run dup`
 *
 * ⚠️ 这是**雷达，不是闸门**：不进 verify、退出码恒为 0。理由见
 *    docs/research/truth-map-design.md §1 ——「同名」不等于「同一件事」
 *    （`level` 在 risk / scale 同名不同义），一个「扫到就报红」的门会被假阳性淹死。
 *    已登记的真值看 `npm run contracts`；这里扫的是**还没登记的候选**。
 *
 * 扫什么：点分 / 蛇形的「标识符样」字符串字面量（事件名 `agent.tool.started`、
 *    字段名 `reasoning_effort`、文件名 ……），跨多个源文件出现 → 列成候选。
 *    注释里也提过的另标一下（往往说明有人已经认过这事）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { CONTRACTS } from './contracts.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-portable',
  'tmp',
  'test-env',
  'backups',
  'shots',
  'data',
])
const EXTS = new Set(['.ts', '.tsx', '.cjs', '.mjs'])

/** 标识符样：小写字母开头，至少一个 `.` 或 `_` 分隔（事件名 / 字段名 / 文件名的形状） */
const IDENT_RE = /^[a-z][a-zA-Z0-9]*(?:[._][a-zA-Z0-9]+)+$/
/** 点分事件样：`a.b` / `agent.tool.started`（不含下划线） */
const DOTTED_RE = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/
const MIN_FILES = 3

/** 末段是文件扩展名的丢掉（`package.json` / `index.css` / `cmd.exe` 这类文件名噪声，不是契约） */
const FILE_EXT = new Set([
  'js', 'ts', 'tsx', 'jsx', 'cjs', 'mjs', 'json', 'md', 'txt', 'css', 'html', 'htm', 'yml',
  'yaml', 'toml', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'woff', 'woff2', 'exe',
  'log', 'lock', 'bat', 'sh', 'py', 'map',
])
const isFileName = (s) => FILE_EXT.has(s.slice(s.lastIndexOf('.') + 1))

/** 已登记的契约文件（sot + mirrors）——「恰好 2 文件、且碰到它」是最可疑的重复 */
const TRUTH_FILES = new Set()
for (const c of CONTRACTS) {
  TRUTH_FILES.add(c.sot)
  for (const m of c.mirrors) TRUTH_FILES.add(m)
}

function walk(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out)
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name))
    }
  }
  return out
}

/** 把源码拆成 { code, comment } —— 注释单拿出来（「有人认过这事」的线索） */
function splitComments(text) {
  let code = ''
  let comment = ''
  let i = 0
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      comment += text.slice(i, stop) + '\n'
      i = stop
    } else if (two === '//') {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? text.length : end
      comment += text.slice(i, stop) + '\n'
      i = stop
    } else {
      code += text[i]
      i++
    }
  }
  return { code, comment }
}

const STR_RE = /'([^'\n]*)'|"([^"\n]*)"/g

function stringsIn(text) {
  const out = []
  for (const m of text.matchAll(STR_RE)) out.push(m[1] ?? m[2])
  return out
}

function collect() {
  const code = new Map()
  const comment = new Map()
  const files = [...walk('src'), ...walk('electron')]
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8')
    const { code: c, comment: cm } = splitComments(text)
    const relFwd = rel.replace(/\\/g, '/')
    for (const s of stringsIn(c)) {
      if (!IDENT_RE.test(s) || isFileName(s)) continue
      if (!code.has(s)) code.set(s, new Set())
      code.get(s).add(relFwd)
    }
    for (const s of stringsIn(cm)) {
      if (!IDENT_RE.test(s) || isFileName(s)) continue
      if (!comment.has(s)) comment.set(s, new Set())
      comment.get(s).add(relFwd)
    }
  }
  return { code, comment, fileCount: files.length }
}

function main() {
  const { code, comment, fileCount } = collect()
  const rows = [...code.entries()]
    .map(([name, files]) => ({ name, files: [...files].sort(), inComment: comment.has(name) }))
    .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name))

  console.log('═══ 重复候选扫描（只报告，不拦门）═══')
  console.log('（同名 ≠ 同一件事；候选要人判真假 —— 见 docs/research/truth-map-design.md §1）\n')

  const many = rows.filter((r) => r.files.length >= MIN_FILES)
  const nearSot = rows.filter(
    (r) =>
      r.files.length === 2 && (r.files.some((f) => TRUTH_FILES.has(f)) || DOTTED_RE.test(r.name)),
  )

  console.log(`── A. 跨 ≥${MIN_FILES} 个源文件出现的标识符（高信号，共 ${many.length} 条）──`)
  for (const r of many) {
    console.log(`  ${r.name}${r.inComment ? '（注释里也提过）' : ''}  ← ${r.files.length} 个文件`)
    console.log(`      ${r.files.join('  ')}`)
  }

  console.log(`\n── B. 恰好 2 文件、且是点分事件样 / 碰到已登记契约文件（第二份真值爱藏这，共 ${nearSot.length} 条）──`)
  for (const r of nearSot) {
    console.log(`  ${r.name}${r.inComment ? '（注释里也提过）' : ''}`)
    console.log(`      ${r.files.join('  ')}`)
  }

  console.log(`\n扫了 ${fileCount} 个源文件；候选 A+B 共 ${many.length + nearSot.length} 条`)
  console.log('（已登记的真值看 `npm run contracts`；本命令永不拦门，退出码恒为 0）')
}

main()
