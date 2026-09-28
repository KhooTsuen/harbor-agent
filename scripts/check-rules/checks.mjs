/**
 * 规范检查的**实现**（六个检查函数）
 *
 * 为什么单独一个文件：`scripts/check-rules.mjs` 带着说明和主流程超了 300 行
 * （而它自己第一条检查就是「单文件 ≤ 300 行」—— 第一次跑就红在自己身上）。
 * 缝很清楚：**查什么**（这里）和**怎么跑、怎么报**（门面那份）。
 *
 * 约定：
 *   · 每个函数签名 `(root = ROOT) => { errors, warnings, summary }`（root 是给测试用的）
 *   · **不抛异常**：读不到文件就当成一条 error 返回，让调用方统一输出
 *   · 警告不算失败；只有 errors 会让退出码变 1
 *   · 输出里**不许打印疑似密钥本身**
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** 仓库根（这个文件在 scripts/check-rules/ 下，往上两层） */
export const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** 扫这些目录（和 tools/line-limit.mjs 的 SCAN 保持一致） */
export const SCAN = ['src', 'electron', 'scripts', 'tools']
export const CODE_EXTS = new Set(['.ts', '.tsx', '.cjs', '.mjs'])
export const SKIP_DIRS = new Set([
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

const rel = (root, file) => path.relative(root, file).replace(/\\/g, '/')

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 递归收集源码文件（跳过 SKIP_DIRS） */
export function walk(root, dir, out = []) {
  const full = path.join(root, dir)
  let entries = []
  try {
    entries = fs.readdirSync(full, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(root, path.join(dir, entry.name), out)
    } else if (CODE_EXTS.has(path.extname(entry.name))) {
      out.push(path.join(full, entry.name))
    }
  }
  return out
}

/* ══════════════════════════════════════════════════════════════
   1. 单文件 ≤ 300 行

   **不自己数行**：行数的唯一实现是 `tools/line-limit.mjs`（CI 用的是它，
   它还带 `--code-only` 口径）。这里调它、读它的输出 —— 两处各写一套口径
   迟早会漂（本项目「同一件事写两份」翻过车：闸门的日期函数就是例子）。
   ══════════════════════════════════════════════════════════════ */
export function checkLineLimits(root = ROOT) {
  const tool = path.join(root, 'tools', 'line-limit.mjs')
  if (!fs.existsSync(tool)) {
    return { errors: ['找不到 tools/line-limit.mjs —— 行数检查的唯一实现在那里'], warnings: [] }
  }

  let out = ''
  try {
    out = execFileSync(process.execPath, [tool], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  const over = []
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s+(\d+)\s+(.+?)\s*$/)
    /* 统一成正斜杠：line-limit 的输出在 Windows 上是反斜杠，和别的检查项不一致 */
    if (m) over.push({ lines: Number(m[1]), file: m[2].replace(/\\/g, '/') })
  }

  const total = Number(out.match(/✓\s+(\d+)\s+个文件/)?.[1] ?? 0)
  if (over.length === 0) {
    return {
      errors: [],
      warnings: [],
      summary: total > 0 ? `${total} 个文件全 ≤ 300 行` : 'line-limit 没报出数字（输出格式变了？）',
    }
  }
  return {
    errors: over.map((r) => `${r.file}　${r.lines} 行（超 300）—— 拆法见 AGENT.md 硬约束 2`),
    warnings: [],
    summary: `${over.length} 个文件超 300 行`,
  }
}

/* ══════════════════════════════════════════════════════════════
   2. 依赖一致：package.json ↔ package-lock.json

   加依赖要用户点头（AGENT.md 硬禁区第 2 条）。这里查的是**两侧一致**：
   只在一侧出现、或版本不一致，都说明「改了一处忘了另一处」。
   真经批准要加依赖时：跑一次 `npm install` 让锁文件跟上，两边就一致了。
   ══════════════════════════════════════════════════════════════ */
export function checkNoNewDeps(root = ROOT) {
  const pkg = readJson(path.join(root, 'package.json'))
  const lock = readJson(path.join(root, 'package-lock.json'))
  if (!pkg || !lock) {
    return { errors: ['读不到 package.json / package-lock.json'], warnings: [] }
  }
  const lockRoot = lock.packages?.[''] ?? {}
  const errors = []
  const drift = []

  for (const section of ['dependencies', 'devDependencies']) {
    const declared = pkg[section] ?? {}
    const locked = lockRoot[section] ?? {}
    for (const name of Object.keys(declared)) {
      if (!(name in locked)) {
        errors.push(`${section}：${name} 在 package.json 里有、锁文件里没有 → 跑 npm install`)
      } else if (declared[name] !== locked[name]) {
        drift.push(`${name}（声明 ${declared[name]} / 锁里 ${locked[name]}）`)
      }
    }
    for (const name of Object.keys(locked)) {
      if (!(name in declared)) {
        errors.push(`${section}：${name} 只在锁文件里有、package.json 里没有`)
      }
    }
  }
  if (drift.length > 0) errors.push(`版本两侧不一致：${drift.slice(0, 8).join('、')}`)

  const count =
    Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length
  return { errors, warnings: [], summary: `${count} 个依赖，两侧一致` }
}

/* ══════════════════════════════════════════════════════════════
   3. data/config.json 里不许有明文密钥

   规矩（AGENT.md 硬约束 4）：密钥走 `credentials.cjs`，配置里只留 `credentialRef`。
   这个文件最容易被手改 / 被脚本写坏，所以专门查它。
   **输出里只给前缀和长度，绝不打印密钥本身**（终端记录、日志都会留痕）。
   ══════════════════════════════════════════════════════════════ */
export function checkNoSecretsInConfig(root = ROOT) {
  const file = path.join(root, 'data', 'config.json')
  if (!fs.existsSync(file)) {
    return { errors: [], warnings: [], summary: '没有 data/config.json（跳过）' }
  }

  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { errors: [`读不了 data/config.json：${error.message}`], warnings: [] }
  }

  const errors = []
  for (const hit of text.matchAll(/sk-[A-Za-z0-9_-]{8,}/g)) {
    errors.push(
      `data/config.json 里有像密钥的字符串（${hit[0].slice(0, 5)}…，共 ${hit[0].length} 字符）—— 移到 credentials.cjs`,
    )
  }

  /* 落盘的 apiKey 只应该是空串；掩码 '••••••••' 只出现在「给界面」的那份里 */
  const cfg = readJson(file)
  const bad = []
  for (const p of cfg?.providers ?? []) {
    if (typeof p?.apiKey === 'string' && p.apiKey !== '' && p.apiKey !== '••••••••') {
      bad.push(`providers[${p.id ?? '?'}]`)
    }
  }
  const searchKey = cfg?.search?.apiKey
  if (typeof searchKey === 'string' && searchKey !== '' && searchKey !== '••••••••') {
    bad.push('search')
  }
  if (bad.length > 0) {
    errors.push(`这些地方的 apiKey 不是空的：${bad.join('、')} —— 落盘的配置只留 credentialRef`)
  }

  return { errors, warnings: [], summary: errors.length === 0 ? '没有明文密钥' : `${errors.length} 处可疑` }
}

/* ══════════════════════════════════════════════════════════════
   4. 源码里的 TODO / FIXME / XXX

   **只警告，不失败**：这些不一定是漏的（有时是明确记下的「以后再说」）。
   它拦的是「顺手留一句就忘了」；交付报告里该说清哪些是真欠账。
   ══════════════════════════════════════════════════════════════ */
export function checkTodos(root = ROOT) {
  const pattern = /\/\/\s*(TODO|FIXME|XXX)\b/
  const hits = []

  for (const dir of SCAN) {
    for (const file of walk(root, dir)) {
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      text.split(/\r?\n/).forEach((line, index) => {
        const m = line.match(pattern)
        if (m) hits.push(`${rel(root, file)}:${index + 1}　${m[1]}`)
      })
    }
  }

  if (hits.length === 0) return { errors: [], warnings: [], summary: '没有 TODO / FIXME' }
  return {
    errors: [],
    warnings: [
      `发现 ${hits.length} 处未完成标记（确认是要提交的，还是漏了）：`,
      ...hits.slice(0, 10),
      ...(hits.length > 10 ? [`…还有 ${hits.length - 10} 处`] : []),
    ],
    summary: `${hits.length} 处标记`,
  }
}

/* ══════════════════════════════════════════════════════════════
   5. AGENT.md 存在且非空

   它是项目规矩的唯一来源，**应用每轮都会读它注入对话**。
   被整段覆盖 / 清空的话，后面所有任务都会失去约束 —— 这条必须红。
   ══════════════════════════════════════════════════════════════ */
export function checkAgentMd(root = ROOT) {
  const file = path.join(root, 'AGENT.md')
  if (!fs.existsSync(file)) {
    return { errors: ['根目录没有 AGENT.md —— 规矩的唯一来源没了'], warnings: [] }
  }
  const text = fs.readFileSync(file, 'utf8')
  if (text.trim().length === 0) return { errors: ['AGENT.md 是空的'], warnings: [] }

  const warnings = []
  /* 覆盖式改写的典型症状：结构性章节不见了 */
  for (const marker of ['第一铁律', '硬约束', '硬禁区', '收工前必须跑']) {
    if (!text.includes(marker)) {
      warnings.push(`AGENT.md 里找不到「${marker}」—— 是不是被整段覆盖了？`)
    }
  }
  return { errors: [], warnings, summary: `${text.split(/\r?\n/).length} 行` }
}

/* ══════════════════════════════════════════════════════════════
   6. 未提交改动的文件数

   **只警告**：超过 5 个不一定是错（拆文件那种活本来就要动好几个），
   但要停下来问一句「范围是不是太大 / 要不要拆成几批」。
   注：`git diff HEAD` 看不到**新增**文件，所以连未跟踪文件一起算。
   ══════════════════════════════════════════════════════════════ */
export function checkDiffSize(root = ROOT) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean)
    } catch {
      return null
    }
  }

  const changed = git(['diff', '--name-only', 'HEAD'])
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
  if (changed === null && untracked === null) {
    return { errors: [], warnings: ['拿不到 git diff（不在 git 仓库里？）—— 这项跳过'], summary: '跳过' }
  }

  const files = [...new Set([...(changed ?? []), ...(untracked ?? [])])]
  if (files.length <= 5) return { errors: [], warnings: [], summary: `${files.length} 个变更文件` }

  return {
    errors: [],
    warnings: [
      `未提交改动有 ${files.length} 个文件（> 5）—— 确认范围是否需要拆分：`,
      ...files.slice(0, 12),
      ...(files.length > 12 ? [`…还有 ${files.length - 12} 个`] : []),
    ],
    summary: `${files.length} 个变更文件`,
  }
}
